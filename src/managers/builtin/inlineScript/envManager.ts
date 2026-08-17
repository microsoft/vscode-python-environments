// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as fs from 'fs-extra';
import * as path from 'path';
import { clean as cleanPep440, satisfies as satisfiesPep440 } from '@renovatebot/pep440';
import { Disposable, Event, EventEmitter, l10n, LogOutputChannel, MarkdownString, ThemeIcon, Uri } from 'vscode';
import {
    CreateEnvironmentOptions,
    CreateEnvironmentScope,
    DidChangeEnvironmentEventArgs,
    DidChangeEnvironmentsEventArgs,
    EnvironmentManager,
    GetEnvironmentScope,
    GetEnvironmentsScope,
    IconPath,
    PythonEnvironment,
    PythonEnvironmentApi,
    RefreshEnvironmentsScope,
    ResolveEnvironmentContext,
    SetEnvironmentScope,
} from '../../../api';
import { getErrorMessage } from '../../../common/errors/utils';
import { computeCacheKey, normalizeDependency } from '../../../common/inlineScript/cacheKey';
import {
    CacheEnvironmentInspection,
    META_SCHEMA_VERSION,
    getBaseInterpreterStatus,
    getScriptEnvCacheRoot,
    getScriptEnvDir,
    inspectOwnedCacheEntry,
    inspectMetaJson,
    resolveCacheEntryPath,
    writeMetaJson,
} from '../../../common/inlineScript/cacheLayout';
import { extractLowerBoundVersion, pickCompatibleInterpreter } from '../../../common/inlineScript/interpreter';
import { InlineScriptMetadata, readInlineScriptMetadataFromFile } from '../../../common/inlineScript/metadata';
import {
    CONDA_MANAGER_ID,
    ENVS_EXTENSION_ID,
    INLINE_SCRIPT_MANAGER_ID,
    PYENV_MANAGER_ID,
    SYSTEM_MANAGER_ID,
} from '../../../common/constants';
import { acquireFileLock, AcquiredFileLock } from '../../../common/lockfile.apis';
import { getWorkspacePersistentState, PersistentState } from '../../../common/persistentState';
import { EventNames, InlineScriptEnvErrorCategory } from '../../../common/telemetry/constants';
import { sendTelemetryEvent } from '../../../common/telemetry/sender';
import { isFileNotFoundError } from '../../../common/utils/filesystem';
import { normalizePath } from '../../../common/utils/pathUtils';
import { compareReleaseSegments, parseReleaseSegments } from '../../../common/utils/pep440Release';
import { getVenvPythonPath } from '../../../common/utils/virtualEnvironment';
import { NativePythonFinder } from '../../common/nativePythonFinder';
import { resolveSystemPythonEnvironmentPath } from '../utils';
import * as uvPythonInstaller from '../uvPythonInstaller';
import { createWithProgress, resolveVenvPythonEnvironmentPath } from '../venvUtils';

const BASE_INTERPRETER_MANAGER_IDS = new Set([
    SYSTEM_MANAGER_ID,
    CONDA_MANAGER_ID,
    PYENV_MANAGER_ID,
]);

const CACHE_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const CACHE_LOCK_RETRY_MS = 500;
const CACHED_ASSOCIATION_VALIDATION_INTERVAL_MS = 5_000;
/** Workspace-state key for PEP 723 script path to environment executable associations. */
export const INLINE_SCRIPT_ENVS_KEY = `${ENVS_EXTENSION_ID}:inline-script:SCRIPT_ENVIRONMENTS`;

interface SelectedBaseInterpreter {
    readonly environment: PythonEnvironment;
    readonly canonicalPath: string;
}

interface CreateOrReuseEnvironmentOptions {
    readonly cacheKey: string;
    readonly packages: ReadonlyArray<string>;
    readonly metadata: InlineScriptMetadata;
    readonly selectedBase: SelectedBaseInterpreter;
}

interface BuildCacheEntryResult {
    readonly environment?: PythonEnvironment;
    readonly retainLock?: boolean;
    readonly errorCategory?: InlineScriptEnvErrorCategory;
}

interface BaseInterpreterSelectionResult {
    readonly selectedBase?: SelectedBaseInterpreter;
    readonly errorCategory?: InlineScriptEnvErrorCategory;
}

interface SelectBaseInterpreterResult {
    readonly selectedBase?: SelectedBaseInterpreter;
    readonly discoveryFailed: boolean;
}

type InstallPythonAndRefreshResult =
    | { readonly kind: 'installed'; readonly installedPath: string }
    | { readonly kind: 'declined' }
    | { readonly kind: 'failed' };

type CacheEntryInspection =
    | { readonly kind: 'absent' | 'stale' | 'uncertain' }
    | { readonly kind: 'reusable'; readonly environment: PythonEnvironment };

/** Manages extension-owned PEP 723 script environments. */
export class InlineScriptEnvManager implements EnvironmentManager, Disposable {
    private readonly pendingSetups = new Map<string, Promise<PythonEnvironment | undefined>>();
    private readonly pendingCreations = new Map<string, Promise<PythonEnvironment | undefined>>();
    private readonly directlyResolvedBaseInterpreters = new Map<string, PythonEnvironment>();
    private baseInterpreterInstallationQueue: Promise<void> = Promise.resolve();
    private readonly pendingRehydrations = new Map<string, Promise<PythonEnvironment | undefined>>();
    private readonly fsPathToEnv = new Map<string, PythonEnvironment>();
    private readonly fsPathToPersistedEnvPath = new Map<string, string>();
    private readonly cachedAssociationValidatedAt = new Map<string, number>();
    private readonly associationRevisions = new Map<string, number>();
    private persistenceQueue: Promise<void> = Promise.resolve();
    private selectionQueue: Promise<void> = Promise.resolve();

    private readonly _onDidChangeEnvironments = new EventEmitter<DidChangeEnvironmentsEventArgs>();
    public readonly onDidChangeEnvironments: Event<DidChangeEnvironmentsEventArgs> =
        this._onDidChangeEnvironments.event;

    private readonly _onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
    public readonly onDidChangeEnvironment: Event<DidChangeEnvironmentEventArgs> = this._onDidChangeEnvironment.event;

    public readonly name = 'inline-script';
    public readonly displayName = l10n.t('Inline script environments');
    public readonly preferredPackageManagerId = 'ms-python.python:pip';
    public readonly description: string | undefined = undefined;
    public readonly tooltip: string | MarkdownString = new MarkdownString(
        l10n.t('Environments built from PEP 723 inline script metadata.'),
        true,
    );
    public readonly iconPath: IconPath = new ThemeIcon('file-code');

    constructor(
        private readonly nativeFinder: NativePythonFinder,
        private readonly api: PythonEnvironmentApi,
        private readonly baseManager: EnvironmentManager,
        private readonly globalStorageUri: Uri,
        public readonly log: LogOutputChannel,
    ) {}

    async create(
        scope: CreateEnvironmentScope,
        options?: CreateEnvironmentOptions,
    ): Promise<PythonEnvironment | undefined> {
        try {
            const scriptUri = this.getScriptUri(scope);
            if (!scriptUri) {
                this.log.warn('Inline-script environment creation requires exactly one local file URI.');
                return undefined;
            }

            const metadata = await readInlineScriptMetadataFromFile(scriptUri);
            if (!metadata) {
                this.log.warn(`No valid PEP 723 metadata found in ${scriptUri.fsPath}.`);
                return undefined;
            }

            const packages = [
                ...(metadata.dependencies ?? []),
                ...(options?.additionalPackages ?? []),
            ].map((value) => value.trim());
            if (packages.some((value) => value.length === 0)) {
                this.log.warn(`Inline-script dependencies must not contain empty entries: ${scriptUri.fsPath}.`);
                return undefined;
            }

            const setupKey = this.getPendingSetupKey(scriptUri, metadata, packages, options);
            const pending = this.pendingSetups.get(setupKey);
            if (pending) {
                return await pending;
            }

            const setup = this.createForScript(scriptUri, metadata, packages, options);
            this.pendingSetups.set(setupKey, setup);
            try {
                return await setup;
            } finally {
                if (this.pendingSetups.get(setupKey) === setup) {
                    this.pendingSetups.delete(setupKey);
                }
            }
        } catch (error) {
            this.sendInlineScriptEnvErrorTelemetry('install-failure');
            this.log.error(`Failed to set up inline-script environment: ${getErrorMessage(error)}`);
            return undefined;
        }
    }

    private async createForScript(
        scriptUri: Uri,
        metadata: InlineScriptMetadata,
        packages: readonly string[],
        options?: CreateEnvironmentOptions,
    ): Promise<PythonEnvironment | undefined> {
        const baseSelection = await this.selectOrInstallBaseInterpreter(metadata, options?.quickCreate === true);
        if (!baseSelection.selectedBase) {
            if (baseSelection.errorCategory) {
                this.sendInlineScriptEnvErrorTelemetry(baseSelection.errorCategory);
            }
            this.log.warn(`No compatible Python is available for inline-script environment creation: ${scriptUri.fsPath}.`);
            return undefined;
        }
        const selectedBase = baseSelection.selectedBase;

        const cacheKey = computeCacheKey({
            dependencies: packages,
            interpreterPath: selectedBase.canonicalPath,
        });
        const pending = this.pendingCreations.get(cacheKey);
        if (pending) {
            return await pending;
        }

        const creation = this.createOrReuseEnvironment({
            cacheKey,
            packages,
            metadata,
            selectedBase,
        });
        this.pendingCreations.set(cacheKey, creation);
        try {
            return await creation;
        } finally {
            if (this.pendingCreations.get(cacheKey) === creation) {
                this.pendingCreations.delete(cacheKey);
            }
        }
    }

    private getPendingSetupKey(
        scriptUri: Uri,
        metadata: InlineScriptMetadata,
        packages: readonly string[],
        options: CreateEnvironmentOptions | undefined,
    ): string {
        const normalizedPackages = Array.from(new Set(packages.map(normalizeDependency))).sort();
        return JSON.stringify([
            normalizePath(scriptUri.fsPath),
            metadata.requiresPython?.trim() ?? '',
            options?.quickCreate === true ? 'quick' : 'interactive',
            normalizedPackages,
        ]);
    }

    private async selectOrInstallBaseInterpreter(
        metadata: InlineScriptMetadata,
        quickCreate: boolean,
    ): Promise<BaseInterpreterSelectionResult> {
        const selection = await this.selectBaseInterpreter(metadata);
        if (selection.selectedBase) {
            return { selectedBase: selection.selectedBase };
        }
        if (quickCreate) {
            return {
                errorCategory: this.getBaseInterpreterErrorCategory(selection.discoveryFailed, 'no-compatible-python'),
            };
        }
        return this.installAndSelectBaseInterpreter(metadata, selection.discoveryFailed);
    }

    async refresh(_scope: RefreshEnvironmentsScope): Promise<void> {
        return;
    }

    async getEnvironments(_scope: GetEnvironmentsScope): Promise<PythonEnvironment[]> {
        return [];
    }

    async set(scope: SetEnvironmentScope, environment?: PythonEnvironment): Promise<void> {
        return this.enqueueSelection(() => this.setInternal(scope, environment));
    }

    async get(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        return this.getInternal(scope);
    }

    async resolve(_context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
        return undefined;
    }

    private getScriptUri(scope: CreateEnvironmentScope): Uri | undefined {
        const uri = scope instanceof Uri ? scope : Array.isArray(scope) && scope.length === 1 ? scope[0] : undefined;
        return uri?.scheme === 'file' ? uri : undefined;
    }

    private async setInternal(scope: SetEnvironmentScope, environment?: PythonEnvironment): Promise<void> {
        const scripts = this.getScriptUris(scope);
        if (scripts.length === 0) {
            return;
        }

        let environmentPath: string | undefined;
        if (environment) {
            const ownership = await this.inspectAssociationOwnership(environment);
            if (ownership !== 'expected') {
                const message = `Inline-script environment is not an owned cache entry: ${environment.environmentPath.fsPath}.`;
                this.log.warn(message);
                throw new Error(message);
            }
            environmentPath = environment.environmentPath.fsPath;
        }

        const updates: PendingScriptUpdate[] = [];
        for (const script of scripts) {
            const before = await this.getAssociationForMutation(script.scriptPath);
            const hadPersistedAssociation = this.fsPathToPersistedEnvPath.has(script.scriptPath);
            const hasSamePersistedEnvironment =
                environmentPath !== undefined &&
                normalizePath(this.fsPathToPersistedEnvPath.get(script.scriptPath) ?? '') ===
                    normalizePath(environmentPath);
            const needsPersistence = environment ? !hasSamePersistedEnvironment : hadPersistedAssociation;
            const shouldNotify =
                (!this.isSameEnvironment(before, environment) && !hasSamePersistedEnvironment) ||
                (!environment && hadPersistedAssociation);
            const hasPendingRehydration = this.pendingRehydrations.has(script.scriptPath);
            const cached = this.fsPathToEnv.get(script.scriptPath);
            const needsMemoryUpdate = environment ? cached !== environment : cached !== undefined;
            if (needsPersistence || shouldNotify || hasPendingRehydration || needsMemoryUpdate) {
                updates.push({
                    ...script,
                    before,
                    needsPersistence,
                    shouldNotify,
                });
            }
        }
        if (updates.length === 0) {
            return;
        }

        try {
            const persistenceUpdates = updates.filter((update) => update.needsPersistence);
            if (persistenceUpdates.length > 0) {
                await this.updatePersistedAssociations(
                    persistenceUpdates.map((update) => ({
                        scriptPath: update.scriptPath,
                        environmentPath,
                    })),
                );
            }
        } catch (error) {
            this.log.error(`Failed to persist inline-script environment association: ${getErrorMessage(error)}`);
            throw error;
        }

        for (const update of updates) {
            this.bumpAssociationRevision(update.scriptPath);
            this.pendingRehydrations.delete(update.scriptPath);
            if (environment) {
                this.fsPathToEnv.set(update.scriptPath, environment);
                this.fsPathToPersistedEnvPath.set(update.scriptPath, environmentPath!);
                this.cachedAssociationValidatedAt.set(update.scriptPath, Date.now());
            } else {
                this.fsPathToEnv.delete(update.scriptPath);
                this.fsPathToPersistedEnvPath.delete(update.scriptPath);
                this.cachedAssociationValidatedAt.delete(update.scriptPath);
            }
            if (update.shouldNotify) {
                this._onDidChangeEnvironment.fire({
                    uri: update.uri,
                    old: update.before,
                    new: environment,
                });
            }
        }
    }

    private async getInternal(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        if (!(scope instanceof Uri) || scope.scheme !== 'file') {
            return undefined;
        }

        // An unreadable or invalid metadata block is indistinguishable from a transient
        // read failure, so retain the association but do not return it.
        const metadata = await readInlineScriptMetadataFromFile(scope);
        if (!metadata) {
            return undefined;
        }

        const environment = await this.getAssociation(normalizePath(scope.fsPath), scope);
        if (!environment) {
            return undefined;
        }

        const requiresPython = metadata.requiresPython?.trim();
        return requiresPython && !this.matchesInstallConstraint(requiresPython, environment.version)
            ? undefined
            : environment;
    }

    private getScriptUris(scope: SetEnvironmentScope): ScriptReference[] {
        const candidates = scope instanceof Uri ? [scope] : Array.isArray(scope) ? scope : undefined;
        if (
            !candidates ||
            candidates.length === 0 ||
            candidates.some((candidate) => !(candidate instanceof Uri) || candidate.scheme !== 'file')
        ) {
            throw new Error('Inline-script environment selection requires one or more local file URIs.');
        }

        const scripts: ScriptReference[] = [];
        const seen = new Set<string>();
        for (const candidate of candidates) {
            const scriptPath = normalizePath(candidate.fsPath);
            if (!seen.has(scriptPath)) {
                seen.add(scriptPath);
                scripts.push({ uri: candidate, scriptPath });
            }
        }
        return scripts;
    }

    private async getAssociation(scriptPath: string, scriptUri: Uri): Promise<PythonEnvironment | undefined> {
        const pending = this.pendingRehydrations.get(scriptPath);
        if (pending) {
            return pending;
        }

        const cached = this.fsPathToEnv.get(scriptPath);
        const revision = this.associationRevisions.get(scriptPath) ?? 0;
        if (cached) {
            const validatedAt = this.cachedAssociationValidatedAt.get(scriptPath);
            if (
                validatedAt !== undefined &&
                Date.now() - validatedAt < CACHED_ASSOCIATION_VALIDATION_INTERVAL_MS
            ) {
                return cached;
            }
            const validation = this.validateCachedAssociation(scriptPath, scriptUri, cached, revision);
            this.pendingRehydrations.set(scriptPath, validation);
            try {
                return await validation;
            } finally {
                if (this.pendingRehydrations.get(scriptPath) === validation) {
                    this.pendingRehydrations.delete(scriptPath);
                }
            }
        }

        const rehydration = this.rehydrateAssociation(scriptPath, scriptUri, revision);
        this.pendingRehydrations.set(scriptPath, rehydration);
        try {
            return await rehydration;
        } finally {
            if (this.pendingRehydrations.get(scriptPath) === rehydration) {
                this.pendingRehydrations.delete(scriptPath);
            }
        }
    }

    private async getAssociationForMutation(scriptPath: string): Promise<PythonEnvironment | undefined> {
        const cached = this.fsPathToEnv.get(scriptPath);
        if (cached) {
            return cached;
        }
        await this.getPersistedAssociation(scriptPath);
        return this.fsPathToEnv.get(scriptPath);
    }

    private async validateCachedAssociation(
        scriptPath: string,
        scriptUri: Uri,
        cached: PythonEnvironment,
        revision: number,
    ): Promise<PythonEnvironment | undefined> {
        const environmentPath = cached.environmentPath.fsPath;
        const envDirPath = path.dirname(path.dirname(environmentPath));
        const busy = await this.isCacheEntryBusy(envDirPath);
        if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
            return this.fsPathToEnv.get(scriptPath);
        }
        if (busy) {
            return undefined;
        }
        try {
            const stat = await fs.stat(environmentPath);
            if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
                return this.fsPathToEnv.get(scriptPath);
            }
            if (stat.isFile()) {
                const resolved = await resolveVenvPythonEnvironmentPath(
                    environmentPath,
                    this.nativeFinder,
                    this.api,
                    this,
                    this.baseManager,
                );
                if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
                    return this.fsPathToEnv.get(scriptPath);
                }
                if (!resolved) {
                    return undefined;
                }
                const ownership = await this.inspectAssociationOwnership(resolved);
                if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
                    return this.fsPathToEnv.get(scriptPath);
                }
                if (ownership === 'stale') {
                    await this.removeStalePersistedAssociation(
                        scriptPath,
                        environmentPath,
                        revision,
                        scriptUri,
                    );
                    return undefined;
                }
                if (ownership !== 'expected') {
                    return undefined;
                }
                this.cachedAssociationValidatedAt.set(scriptPath, Date.now());
                if (cached.version === resolved.version) {
                    return cached;
                }
                this.fsPathToEnv.set(scriptPath, resolved);
                this._onDidChangeEnvironment.fire({ uri: scriptUri, old: cached, new: resolved });
                return resolved;
            }
            const becameBusy = await this.isCacheEntryBusy(envDirPath);
            if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
                return this.fsPathToEnv.get(scriptPath);
            }
            if (!becameBusy) {
                await this.removeStalePersistedAssociation(
                    scriptPath,
                    environmentPath,
                    revision,
                    scriptUri,
                );
            }
        } catch (error) {
            if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
                return this.fsPathToEnv.get(scriptPath);
            }
            if (this.isDefinitivelyStalePathError(error)) {
                const becameBusy = await this.isCacheEntryBusy(envDirPath);
                if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
                    return this.fsPathToEnv.get(scriptPath);
                }
                if (!becameBusy) {
                    await this.removeStalePersistedAssociation(
                        scriptPath,
                        environmentPath,
                        revision,
                        scriptUri,
                    );
                }
            } else {
                this.log.warn(
                    `Unable to inspect cached inline-script environment ${environmentPath}: ${getErrorMessage(error)}`,
                );
            }
        }
        return undefined;
    }

    private async rehydrateAssociation(
        scriptPath: string,
        scriptUri: Uri,
        revision: number,
    ): Promise<PythonEnvironment | undefined> {
        let environmentPath: string | undefined;
        try {
            environmentPath = await this.getPersistedAssociation(scriptPath);
        } catch (error) {
            this.log.warn(`Failed to read inline-script environment association: ${getErrorMessage(error)}`);
            return undefined;
        }
        if (!environmentPath) {
            return undefined;
        }
        if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
            return this.fsPathToEnv.get(scriptPath);
        }
        if (!path.isAbsolute(environmentPath)) {
            await this.removeStalePersistedAssociation(scriptPath, environmentPath, revision, scriptUri);
            return undefined;
        }
        const envDirPath = path.dirname(path.dirname(environmentPath));
        if (await this.isCacheEntryBusy(envDirPath)) {
            return undefined;
        }

        try {
            const stat = await fs.stat(environmentPath);
            if (!stat.isFile()) {
                if (!(await this.isCacheEntryBusy(envDirPath))) {
                    await this.removeStalePersistedAssociation(scriptPath, environmentPath, revision, scriptUri);
                }
                return undefined;
            }
        } catch (error) {
            if (this.isDefinitivelyStalePathError(error)) {
                if (!(await this.isCacheEntryBusy(envDirPath))) {
                    await this.removeStalePersistedAssociation(scriptPath, environmentPath, revision, scriptUri);
                }
            } else {
                this.log.warn(
                    `Unable to inspect persisted inline-script environment ${environmentPath}: ${getErrorMessage(error)}`,
                );
            }
            return undefined;
        }

        let resolved: PythonEnvironment | undefined;
        try {
            resolved = await resolveVenvPythonEnvironmentPath(
                environmentPath,
                this.nativeFinder,
                this.api,
                this,
                this.baseManager,
            );
        } catch (error) {
            this.log.warn(
                `Unable to resolve persisted inline-script environment ${environmentPath}: ${getErrorMessage(error)}`,
            );
            return undefined;
        }
        if (!resolved) {
            // PET/API resolution can fail transiently. Keep the association for a later retry.
            return undefined;
        }

        if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
            return this.fsPathToEnv.get(scriptPath);
        }
        let ownership: CacheEnvironmentInspection;
        try {
            ownership = await this.inspectAssociationOwnership(resolved);
        } catch (error) {
            this.log.warn(
                `Unable to inspect persisted inline-script environment ${environmentPath}: ${getErrorMessage(error)}`,
            );
            return undefined;
        }
        if (ownership === 'stale') {
            await this.removeStalePersistedAssociation(scriptPath, environmentPath, revision, scriptUri);
            return undefined;
        }
        if (ownership !== 'expected') {
            return undefined;
        }

        if (!this.isCurrentAssociationRevision(scriptPath, revision) || this.fsPathToEnv.has(scriptPath)) {
            return this.fsPathToEnv.get(scriptPath);
        }
        this.fsPathToEnv.set(scriptPath, resolved);
        this.cachedAssociationValidatedAt.set(scriptPath, Date.now());
        this._onDidChangeEnvironment.fire({ uri: scriptUri, old: undefined, new: resolved });
        return resolved;
    }

    private async inspectAssociationOwnership(environment: PythonEnvironment): Promise<CacheEnvironmentInspection> {
        if (environment.envId.managerId !== INLINE_SCRIPT_MANAGER_ID || !path.isAbsolute(environment.sysPrefix)) {
            return 'uncertain';
        }
        const cacheRoot = getScriptEnvCacheRoot(this.globalStorageUri);
        const envDir = Uri.file(environment.sysPrefix);
        try {
            if (!(await resolveCacheEntryPath(cacheRoot, envDir))) {
                return 'stale';
            }
        } catch {
            return 'uncertain';
        }
        return inspectOwnedCacheEntry(
            environment,
            cacheRoot,
            envDir,
        );
    }

    private async getPersistedAssociation(scriptPath: string): Promise<string | undefined> {
        await this.persistenceQueue;
        const state = await getWorkspacePersistentState();
        const raw = await state.get<unknown>(INLINE_SCRIPT_ENVS_KEY);
        if (raw === undefined) {
            this.fsPathToPersistedEnvPath.delete(scriptPath);
            return undefined;
        }
        const associations = this.asPersistedAssociations(raw);
        if (!associations) {
            await this.removeInvalidPersistedAssociation(scriptPath);
            this.fsPathToPersistedEnvPath.delete(scriptPath);
            return undefined;
        }
        const rawValue = (raw as Record<string, unknown>)[scriptPath];
        if (rawValue !== undefined && (typeof rawValue !== 'string' || rawValue.length === 0)) {
            await this.removeInvalidPersistedAssociation(scriptPath);
            this.fsPathToPersistedEnvPath.delete(scriptPath);
            return undefined;
        }
        const environmentPath = associations[scriptPath];
        if (environmentPath) {
            this.fsPathToPersistedEnvPath.set(scriptPath, environmentPath);
        } else {
            this.fsPathToPersistedEnvPath.delete(scriptPath);
        }
        return environmentPath;
    }

    private async removeStalePersistedAssociation(
        scriptPath: string,
        expectedEnvironmentPath: string,
        revision: number,
        scriptUri?: Uri,
    ): Promise<void> {
        await this.enqueueSelection(async () => {
            if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
                return;
            }
            try {
                await this.updatePersistedAssociations([{ scriptPath, expectedEnvironmentPath }]);
                if (
                    normalizePath(this.fsPathToPersistedEnvPath.get(scriptPath) ?? '') ===
                        normalizePath(expectedEnvironmentPath) &&
                    this.isCurrentAssociationRevision(scriptPath, revision)
                ) {
                    const old = this.fsPathToEnv.get(scriptPath);
                    this.bumpAssociationRevision(scriptPath);
                    this.fsPathToEnv.delete(scriptPath);
                    this.fsPathToPersistedEnvPath.delete(scriptPath);
                    this.cachedAssociationValidatedAt.delete(scriptPath);
                    if (old && scriptUri) {
                        this._onDidChangeEnvironment.fire({ uri: scriptUri, old, new: undefined });
                    }
                }
            } catch (error) {
                this.log.warn(
                    `Failed to remove stale inline-script environment association: ${getErrorMessage(error)}`,
                );
            }
        });
    }

    private removeInvalidPersistedAssociation(scriptPath: string): Promise<void> {
        return this.enqueuePersistence(async (state) => {
            const raw = await state.get<unknown>(INLINE_SCRIPT_ENVS_KEY);
            if (raw === undefined) {
                return;
            }
            const associations = this.asPersistedAssociations(raw);
            if (!associations) {
                await state.set(INLINE_SCRIPT_ENVS_KEY, {});
                return;
            }
            const rawValue = (raw as Record<string, unknown>)[scriptPath];
            if (rawValue !== undefined && (typeof rawValue !== 'string' || rawValue.length === 0)) {
                delete associations[scriptPath];
                await state.set(INLINE_SCRIPT_ENVS_KEY, associations);
            }
        });
    }

    private updatePersistedAssociations(changes: readonly PersistedAssociationChange[]): Promise<void> {
        return this.enqueuePersistence(async (state) => {
            const raw = await state.get<unknown>(INLINE_SCRIPT_ENVS_KEY);
            const associations = { ...(this.asPersistedAssociations(raw) ?? {}) };
            for (const change of changes) {
                const current = associations[change.scriptPath];
                if (change.environmentPath) {
                    associations[change.scriptPath] = change.environmentPath;
                } else if (
                    change.expectedEnvironmentPath === undefined ||
                    (current !== undefined &&
                        normalizePath(current) === normalizePath(change.expectedEnvironmentPath))
                ) {
                    delete associations[change.scriptPath];
                }
            }
            await state.set(INLINE_SCRIPT_ENVS_KEY, associations);
        });
    }

    private asPersistedAssociations(value: unknown): PersistedInlineScriptEnvironments | undefined {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return undefined;
        }
        const associations: PersistedInlineScriptEnvironments = {};
        for (const [scriptPath, environmentPath] of Object.entries(value)) {
            if (typeof environmentPath === 'string' && environmentPath.length > 0) {
                associations[scriptPath] = environmentPath;
            }
        }
        return associations;
    }

    private enqueuePersistence(operation: (state: PersistentState) => Promise<void>): Promise<void> {
        const run = this.persistenceQueue.then(async () => operation(await getWorkspacePersistentState()));
        this.persistenceQueue = run.catch(() => undefined);
        return run;
    }

    private enqueueSelection<T>(operation: () => Promise<T>): Promise<T> {
        const run = this.selectionQueue.then(operation);
        this.selectionQueue = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    private async isCacheEntryBusy(envDirPath: string): Promise<boolean> {
        return (
            this.pendingCreations.has(path.basename(envDirPath)) ||
            (await fs.pathExists(`${path.resolve(envDirPath)}.lock`))
        );
    }

    private bumpAssociationRevision(scriptPath: string): void {
        this.associationRevisions.set(scriptPath, (this.associationRevisions.get(scriptPath) ?? 0) + 1);
    }

    private isCurrentAssociationRevision(scriptPath: string, revision: number): boolean {
        return (this.associationRevisions.get(scriptPath) ?? 0) === revision;
    }

    private isSameEnvironment(
        first: PythonEnvironment | undefined,
        second: PythonEnvironment | undefined,
    ): boolean {
        if (first === second) {
            return true;
        }
        if (!first || !second) {
            return false;
        }
        return (
            first.envId.managerId === second.envId.managerId &&
            normalizePath(first.environmentPath.fsPath) === normalizePath(second.environmentPath.fsPath)
        );
    }

    private async selectBaseInterpreter(metadata: InlineScriptMetadata): Promise<SelectBaseInterpreterResult> {
        let globalEnvironments: readonly PythonEnvironment[] = [];
        let discoveryFailed = false;
        try {
            globalEnvironments = await this.api.getEnvironments('global');
        } catch (error) {
            discoveryFailed = true;
            this.log.warn(`Unable to query discovered base interpreters: ${getErrorMessage(error)}`);
        }
        const reported = [
            ...globalEnvironments.filter(
                (environment) =>
                    BASE_INTERPRETER_MANAGER_IDS.has(environment.envId.managerId) &&
                    (environment.envId.managerId !== CONDA_MANAGER_ID || environment.name === 'base'),
            ),
            ...[...this.directlyResolvedBaseInterpreters.values()].filter(
                (environment) =>
                    !metadata.requiresPython ||
                    this.matchesInstallConstraint(metadata.requiresPython, environment.version),
            ),
        ];
        const derivedChecks = await Promise.all(
            reported.map(async (environment) => {
                if (!path.isAbsolute(environment.sysPrefix)) {
                    this.log.warn(
                        `Skipping base interpreter with a non-absolute sysPrefix: ${environment.sysPrefix || '<empty>'}.`,
                    );
                    return { environment, derived: true };
                }
                return {
                    environment,
                    derived: await fs.pathExists(path.join(environment.sysPrefix, 'pyvenv.cfg')),
                };
            }),
        );
        let candidates = derivedChecks
            .filter(
                (candidate) =>
                    !candidate.derived &&
                    (!metadata.requiresPython ||
                        this.matchesInstallConstraint(metadata.requiresPython, candidate.environment.version)),
            )
            .map((candidate) => candidate.environment);

        while (candidates.length > 0) {
            const environment = pickCompatibleInterpreter(candidates, undefined);
            if (!environment) {
                return { discoveryFailed };
            }
            candidates = candidates.filter((candidate) => candidate !== environment);

            const executable = environment.execInfo?.run.executable;
            if (!executable) {
                continue;
            }
            try {
                return {
                    selectedBase: { environment, canonicalPath: await fs.realpath(executable) },
                    discoveryFailed,
                };
            } catch (error) {
                this.log.warn(
                    `Skipping base interpreter that cannot be resolved at ${executable}: ${getErrorMessage(error)}`,
                );
            }
        }

        return { discoveryFailed };
    }

    private async installAndSelectBaseInterpreter(
        metadata: InlineScriptMetadata,
        priorDiscoveryFailed = false,
    ): Promise<BaseInterpreterSelectionResult> {
        const run = this.baseInterpreterInstallationQueue.then(() =>
            this.installAndSelectBaseInterpreterSerially(metadata, priorDiscoveryFailed),
        );
        // Keep the stored queue tail fulfilled so one failed request does not block later attempts;
        // the caller still observes the original result through `run`.
        this.baseInterpreterInstallationQueue = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    private async installAndSelectBaseInterpreterSerially(
        metadata: InlineScriptMetadata,
        priorDiscoveryFailed: boolean,
    ): Promise<BaseInterpreterSelectionResult> {
        const existing = await this.selectBaseInterpreter(metadata);
        const discoveryFailed = priorDiscoveryFailed || existing.discoveryFailed;
        if (existing.selectedBase) {
            return { selectedBase: existing.selectedBase };
        }

        const requiresPython = metadata.requiresPython?.trim() || undefined;
        const lowerBound = extractLowerBoundVersion(requiresPython);
        const versionSelection = await this.selectInstallablePythonVersion(requiresPython, lowerBound);
        if (requiresPython && !versionSelection.version) {
            this.log.warn(
                'Cannot install a Python for this inline script because no compatible install version could be selected.',
            );
            return {
                errorCategory: this.getBaseInterpreterErrorCategory(
                    discoveryFailed,
                    versionSelection.errorCategory ?? 'no-compatible-python',
                ),
            };
        }

        const installResult = await this.installPythonAndRefresh(requiresPython, versionSelection.version);
        if (installResult.kind !== 'installed') {
            return {
                errorCategory: this.getBaseInterpreterErrorCategory(
                    discoveryFailed,
                    installResult.kind === 'declined' ? 'compatible-python-declined' : 'install-failure',
                ),
            };
        }
        const installedPath = installResult.installedPath;

        const refreshedSelection = await this.selectBaseInterpreter(metadata);
        const discoveryFailedAfterInstall = discoveryFailed || refreshedSelection.discoveryFailed;
        let selected = refreshedSelection.selectedBase;
        if (!selected) {
            const resolved = await resolveSystemPythonEnvironmentPath(
                installedPath,
                this.nativeFinder,
                this.api,
                this.baseManager,
            );
            const executable = resolved?.execInfo?.run.executable;
            if (resolved && executable && pickCompatibleInterpreter([resolved], metadata.requiresPython)) {
                try {
                    const canonicalPath = await fs.realpath(executable);
                    if (!requiresPython || this.matchesInstallConstraint(requiresPython, resolved.version)) {
                        this.directlyResolvedBaseInterpreters.set(canonicalPath, resolved);
                        selected = {
                            environment: resolved,
                            canonicalPath,
                        };
                    }
                } catch (error) {
                    this.log.warn(
                        `Unable to resolve the Python installed for an inline script at ${executable}: ${getErrorMessage(error)}`,
                    );
                }
            }
        }
        if (!selected) {
            this.log.warn(
                'Python was installed for an inline script, but no compatible base interpreter was discovered after refreshing environments.',
            );
            return {
                errorCategory: this.getBaseInterpreterErrorCategory(discoveryFailedAfterInstall, 'install-failure'),
            };
        }
        return { selectedBase: selected };
    }

    private async selectInstallablePythonVersion(
        requiresPython: string | undefined,
        lowerBound: string | undefined,
    ): Promise<{ readonly version?: string; readonly errorCategory?: InlineScriptEnvErrorCategory }> {
        if (!requiresPython) {
            return { version: lowerBound };
        }
        const prereleaseLowerBound = this.extractPrereleaseLowerBound(requiresPython);
        if (prereleaseLowerBound) {
            return { version: prereleaseLowerBound };
        }
        const lowerBoundRelease = lowerBound ? parseReleaseSegments(lowerBound) : undefined;
        if (lowerBound && lowerBoundRelease?.[0] === 3) {
            if (/^>=\s*[^,]+$/.test(requiresPython) && this.matchesInstallConstraint(requiresPython, lowerBound)) {
                return { version: lowerBound };
            }
            if (/^==\s*[^,*]+$/.test(requiresPython) && this.matchesInstallConstraint(requiresPython, lowerBound)) {
                return { version: lowerBound };
            }
        }

        let available: uvPythonInstaller.UvPythonVersion[];
        try {
            const uvLookupResult = await uvPythonInstaller.ensureUvForInlineScriptVersionLookupDetailed(
                requiresPython,
                this.log,
            );
            if (uvLookupResult !== 'available') {
                return {
                    errorCategory:
                        uvLookupResult === 'declined' ? 'compatible-python-declined' : 'install-failure',
                };
            }
            available = await uvPythonInstaller.getAvailablePythonVersions();
        } catch (error) {
            this.log.warn(`Unable to query Python versions available from uv: ${getErrorMessage(error)}`);
            return { errorCategory: 'install-failure' };
        }
        if (available.length === 0) {
            return { errorCategory: 'install-failure' };
        }
        const version = available
            .filter(
                (candidate) =>
                    candidate.implementation === 'cpython' &&
                    candidate.variant === 'default' &&
                    candidate.version_parts.major === 3 &&
                    this.matchesInstallConstraint(requiresPython, candidate.version),
            )
            .sort((left, right) => {
                const leftRelease = parseReleaseSegments(left.version);
                const rightRelease = parseReleaseSegments(right.version);
                if (!leftRelease || !rightRelease) {
                    return 0;
                }
                return compareReleaseSegments(rightRelease, leftRelease);
            })[0]?.version;
        return version ? { version } : { errorCategory: 'no-compatible-python' };
    }

    private matchesInstallConstraint(requiresPython: string, version: string): boolean {
        try {
            return satisfiesPep440(version, requiresPython, {
                prereleases: /(?:(?:a|alpha|b|beta|c|rc|pre|preview)[._-]?\d+|dev[._-]?\d+)/i.test(
                    requiresPython,
                ),
            });
        } catch (error) {
            this.log.warn(`Unable to evaluate requires-python '${requiresPython}': ${getErrorMessage(error)}`);
            return false;
        }
    }

    private extractPrereleaseLowerBound(requiresPython: string): string | undefined {
        return requiresPython
            .split(',')
            .map((clause) =>
                clause
                    .trim()
                    .match(
                        /^(?:>=|==|~=)\s*(\d+(?:\.\d+)*(?:(?:a|alpha|b|beta|c|rc|pre|preview)[._-]?\d+|[._-]?dev[._-]?\d+))$/i,
                    )?.[1],
            )
            .map((version) => (version ? cleanPep440(version) : undefined))
            .filter((version): version is string => !!version)
            .find((version) => this.matchesInstallConstraint(requiresPython, version));
    }

    private async installPythonAndRefresh(
        requiresPython: string | undefined,
        version: string | undefined,
    ): Promise<InstallPythonAndRefreshResult> {
        let promptResult: uvPythonInstaller.PromptInstallPythonViaUvResult;
        try {
            promptResult = await uvPythonInstaller.promptInstallPythonViaUvDetailed('inlineScript', this.log, {
                requiresPython,
                version,
            });
            if (promptResult.kind === 'declined') {
                this.log.warn(
                    'Python installation for inline-script environment creation was declined or did not complete.',
                );
                return { kind: 'declined' };
            }
            if (promptResult.kind === 'failed') {
                this.log.error('Failed to install Python for an inline script.');
                return { kind: 'failed' };
            }
        } catch (error) {
            this.log.error(`Failed to install Python for an inline script: ${getErrorMessage(error)}`);
            return { kind: 'failed' };
        }

        try {
            await this.api.refreshEnvironments(undefined);
        } catch (error) {
            this.log.warn(
                `Python was installed for an inline script, but environment discovery could not be refreshed: ${getErrorMessage(error)}`,
            );
        }
        return { kind: 'installed', installedPath: promptResult.pythonPath };
    }

    private async createOrReuseEnvironment({
        cacheKey,
        packages,
        metadata,
        selectedBase,
    }: CreateOrReuseEnvironmentOptions): Promise<PythonEnvironment | undefined> {
        const dependencyCount = this.getTelemetryDependencyCount(packages);
        const cacheRoot = getScriptEnvCacheRoot(this.globalStorageUri);
        const envDir = getScriptEnvDir(this.globalStorageUri, cacheKey);
        await fs.ensureDir(cacheRoot.fsPath);

        let lock: AcquiredFileLock | undefined;
        try {
            lock = await acquireFileLock(envDir.fsPath, {
                timeoutMs: CACHE_LOCK_TIMEOUT_MS,
                retryIntervalMs: CACHE_LOCK_RETRY_MS,
            });

            const cached = await this.inspectCacheEntry(cacheRoot, envDir, metadata, selectedBase);
            if (cached.kind === 'reusable') {
                this.sendInlineScriptEnvReuseHitTelemetry();
                return cached.environment;
            }
            if (cached.kind === 'uncertain') {
                this.log.warn(
                    `Preserving an inline-script cache entry that could not be safely inspected: ${envDir.fsPath}`,
                );
                this.sendInlineScriptEnvErrorTelemetry('install-failure');
                return undefined;
            }
            if (cached.kind === 'stale') {
                if (!(await this.removeCacheEntry(envDir))) {
                    this.sendInlineScriptEnvErrorTelemetry('install-failure');
                    return undefined;
                }
            }

            const buildStartAtMs = Date.now();
            const build = await this.buildCacheEntry(envDir, cacheRoot, packages, selectedBase);
            if (build.retainLock) {
                try {
                    await lock.retain();
                } catch (error) {
                    this.log.error(
                        `Failed to mark the inline-script cache lock as retained: ${getErrorMessage(error)}`,
                    );
                }
            }
            if (build.environment) {
                this.sendInlineScriptEnvCreatedTelemetry(buildStartAtMs, dependencyCount);
                return build.environment;
            }
            if (build.errorCategory) {
                this.sendInlineScriptEnvErrorTelemetry(build.errorCategory);
            }
            return undefined;
        } catch (error) {
            this.sendInlineScriptEnvErrorTelemetry(this.getCreateOrReuseErrorCategory(error));
            this.log.error(`Failed to create or reuse inline-script cache entry: ${getErrorMessage(error)}`);
            return undefined;
        } finally {
            if (lock) {
                try {
                    await lock.release();
                } catch (error) {
                    this.log.warn(`Failed to release inline-script cache lock: ${getErrorMessage(error)}`);
                }
            }
        }
    }

    private async inspectCacheEntry(
        cacheRoot: Uri,
        envDir: Uri,
        metadata: InlineScriptMetadata,
        selectedBase: SelectedBaseInterpreter,
    ): Promise<CacheEntryInspection> {
        try {
            const stat = await fs.lstat(envDir.fsPath);
            if (!stat.isDirectory() || stat.isSymbolicLink()) {
                return { kind: 'uncertain' };
            }
        } catch (error) {
            return isFileNotFoundError(error) ? { kind: 'absent' } : { kind: 'uncertain' };
        }

        let resolvedEntry: string | undefined;
        try {
            resolvedEntry = await resolveCacheEntryPath(cacheRoot, envDir);
        } catch (error) {
            this.log.warn(`Failed to resolve inline-script cache entry: ${getErrorMessage(error)}`);
            return { kind: 'uncertain' };
        }
        if (!resolvedEntry) {
            return { kind: 'uncertain' };
        }

        let sidecarResult;
        try {
            sidecarResult = await inspectMetaJson(envDir);
        } catch {
            return { kind: 'uncertain' };
        }
        if (sidecarResult.kind !== 'valid') {
            return { kind: sidecarResult.kind === 'unavailable' ? 'uncertain' : 'stale' };
        }
        const sidecar = sidecarResult.metadata;
        if (
            normalizePath(sidecar.baseInterpreterPath) !== normalizePath(selectedBase.canonicalPath) ||
            sidecar.baseInterpreterVersion !== selectedBase.environment.version
        ) {
            return { kind: 'stale' };
        }

        const baseInterpreterStatus = await getBaseInterpreterStatus(envDir);
        if (baseInterpreterStatus !== 'available') {
            return { kind: baseInterpreterStatus === 'missing' ? 'stale' : 'uncertain' };
        }

        const environment = await resolveVenvPythonEnvironmentPath(
            getVenvPythonPath(envDir.fsPath),
            this.nativeFinder,
            this.api,
            this,
            this.baseManager,
        );
        if (!environment) {
            return { kind: 'uncertain' };
        }
        const environmentStatus = await inspectOwnedCacheEntry(environment, cacheRoot, envDir);
        if (environmentStatus !== 'expected') {
            return { kind: environmentStatus };
        }
        if (!this.areEqualPythonReleases(environment.version, selectedBase.environment.version)) {
            return { kind: 'stale' };
        }
        const requiresPython = metadata.requiresPython?.trim();
        if (requiresPython && !this.matchesInstallConstraint(requiresPython, environment.version)) {
            return { kind: 'stale' };
        }

        try {
            await writeMetaJson(envDir, { ...sidecar, lastUsedAt: new Date().toISOString() });
        } catch (error) {
            this.log.warn(`Failed to update inline-script cache metadata: ${getErrorMessage(error)}`);
        }
        return { kind: 'reusable', environment };
    }

    private async buildCacheEntry(
        envDir: Uri,
        cacheRoot: Uri,
        packages: ReadonlyArray<string>,
        selectedBase: SelectedBaseInterpreter,
    ): Promise<BuildCacheEntryResult> {
        let result;
        try {
            result = await createWithProgress(
                this.nativeFinder,
                this.api,
                this.log,
                this,
                selectedBase.environment,
                cacheRoot,
                envDir.fsPath,
                { install: [...packages], uninstall: [] },
                false, // trackUvEnvironment
            );
        } catch (error) {
            this.log.error(`Failed to build inline-script environment: ${getErrorMessage(error)}`);
            await this.removeCacheEntry(envDir);
            return { errorCategory: 'install-failure' };
        }

        if (result?.pkgInstallationCancelled) {
            this.log.warn(
                'Inline-script package installation was cancelled; retaining the cache lock until explicit cleanup.',
            );
            return { retainLock: true, errorCategory: 'package-install-cancelled' };
        }
        if (!result?.environment || result.envCreationErr || result.pkgInstallationErr) {
            const error =
                result?.envCreationErr ?? result?.pkgInstallationErr ?? 'environment creation returned no result';
            this.log.error(`Failed to build inline-script environment: ${error}`);
            await this.removeCacheEntry(envDir);
            return { errorCategory: 'install-failure' };
        }
        if (
            !this.areEqualPythonReleases(result.environment.version, selectedBase.environment.version) ||
            (await inspectOwnedCacheEntry(result.environment, cacheRoot, envDir)) !== 'expected'
        ) {
            this.log.error('Created inline-script environment does not match the requested cache entry.');
            await this.removeCacheEntry(envDir);
            return { errorCategory: 'install-failure' };
        }

        try {
            await writeMetaJson(envDir, {
                schemaVersion: META_SCHEMA_VERSION,
                baseInterpreterPath: selectedBase.canonicalPath,
                baseInterpreterVersion: selectedBase.environment.version,
                lastUsedAt: new Date().toISOString(),
            });
        } catch (error) {
            this.log.error(`Failed to record inline-script cache metadata: ${getErrorMessage(error)}`);
            await this.removeCacheEntry(envDir);
            return { errorCategory: 'install-failure' };
        }

        return { environment: result.environment };
    }

    private async removeCacheEntry(envDir: Uri): Promise<boolean> {
        try {
            await fs.remove(envDir.fsPath);
            return true;
        } catch (error) {
            this.log.error(`Failed to remove incomplete inline-script environment: ${getErrorMessage(error)}`);
            return false;
        }
    }

    private isDefinitivelyStalePathError(error: unknown): boolean {
        if (isFileNotFoundError(error)) {
            return true;
        }
        return (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            ['ENOTDIR', 'EINVAL', 'ERR_INVALID_ARG_VALUE'].includes((error as NodeJS.ErrnoException).code ?? '')
        );
    }

    private areEqualPythonReleases(actual: string, expected: string): boolean {
        const actualRelease = parseReleaseSegments(actual);
        const expectedRelease = parseReleaseSegments(expected);
        if (actualRelease === undefined || expectedRelease === undefined) {
            return false;
        }
        return compareReleaseSegments(actualRelease, expectedRelease) === 0;
    }

    private getTelemetryDependencyCount(packages: ReadonlyArray<string>): number {
        return new Set(packages.map(normalizeDependency)).size;
    }

    private sendInlineScriptEnvCreatedTelemetry(startAtMs: number, dependencyCount: number): void {
        sendTelemetryEvent(EventNames.INLINE_SCRIPT_ENV_CREATED, {
            duration: Date.now() - startAtMs,
            dependencyCount,
        });
    }

    private sendInlineScriptEnvReuseHitTelemetry(): void {
        sendTelemetryEvent(EventNames.INLINE_SCRIPT_ENV_REUSE_HIT);
    }

    private sendInlineScriptEnvErrorTelemetry(category: InlineScriptEnvErrorCategory): void {
        sendTelemetryEvent(EventNames.INLINE_SCRIPT_ENV_ERROR, undefined, { category });
    }

    private getBaseInterpreterErrorCategory(
        discoveryFailed: boolean,
        fallbackCategory: InlineScriptEnvErrorCategory,
    ): InlineScriptEnvErrorCategory {
        return discoveryFailed ? 'discovery-failure' : fallbackCategory;
    }

    private getCreateOrReuseErrorCategory(error: unknown): InlineScriptEnvErrorCategory {
        if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            ['ELOCKED', 'ELOCKRETAINED', 'ELOCKORPHANED'].includes((error as NodeJS.ErrnoException).code ?? '')
        ) {
            return (error as NodeJS.ErrnoException).code === 'ELOCKED' ? 'lock-timeout' : 'lock-unavailable';
        }
        return 'install-failure';
    }

    dispose(): void {
        this._onDidChangeEnvironments.dispose();
        this._onDidChangeEnvironment.dispose();
    }
}

type PersistedInlineScriptEnvironments = Record<string, string>;

interface PersistedAssociationChange {
    readonly scriptPath: string;
    readonly environmentPath?: string;
    readonly expectedEnvironmentPath?: string;
}

interface ScriptReference {
    readonly uri: Uri;
    readonly scriptPath: string;
}

interface PendingScriptUpdate extends ScriptReference {
    readonly before: PythonEnvironment | undefined;
    readonly needsPersistence: boolean;
    readonly shouldNotify: boolean;
}
