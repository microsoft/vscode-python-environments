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
    INLINE_SCRIPT_CACHE_DIR_NAME,
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

const CACHE_CLEAR_ROOT_LOCK_TIMEOUT_MS = 1_000;
const CACHE_CLEAR_ROOT_LOCK_RETRY_MS = 50;
const CACHE_CREATE_HANDOFF_LOCK_TIMEOUT_MS = 1_000;
const CACHE_CREATE_HANDOFF_LOCK_RETRY_MS = 50;
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

type CacheLockDisposition = 'retained' | 'active' | 'unknown';

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
    private activeCreateCount = 0;
    private isClearCacheInProgress = false;

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
        if (this.isClearCacheInProgress) {
            throw this.createCacheOperationConflict(
                l10n.t(
                    'Cannot create an inline script environment while the script environment cache is being cleared. Retry after the cache clear finishes.',
                ),
            );
        }
        this.activeCreateCount += 1;
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
            if (error instanceof InlineScriptCacheOperationError) {
                this.sendInlineScriptEnvErrorTelemetry('setup-failure');
                this.log.warn(error.message);
                throw error;
            }
            this.sendInlineScriptEnvErrorTelemetry('setup-failure');
            this.log.error(`Failed to set up inline-script environment: ${getErrorMessage(error)}`);
            return undefined;
        } finally {
            this.activeCreateCount -= 1;
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
                errorCategory: selection.discoveryFailed ? 'discovery-failure' : 'no-compatible-python',
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

    async clearScriptCache(): Promise<void> {
        if (this.isClearCacheInProgress) {
            throw this.createCacheOperationConflict(
                l10n.t('Script environment cache clear is already in progress.'),
            );
        }
        this.isClearCacheInProgress = true;

        try {
            if (this.activeCreateCount > 0) {
                throw this.createCacheOperationConflict(
                    l10n.t(
                        'Cannot clear the script environment cache while another inline script environment operation may still be using it. Close other VS Code windows or restart VS Code, then retry.',
                    ),
                );
            }

            const cacheRoot = getScriptEnvCacheRoot(this.globalStorageUri);
            let rootLock: AcquiredFileLock | undefined = await this.acquireCacheRootLock(cacheRoot, {
                timeoutMs: CACHE_CLEAR_ROOT_LOCK_TIMEOUT_MS,
                retryIntervalMs: CACHE_CLEAR_ROOT_LOCK_RETRY_MS,
            }, 'clear');
            try {
                const clearableCacheRoot = await this.getClearableCacheRootPath(cacheRoot);
                if (clearableCacheRoot) {
                    await this.assertNoCacheLocks(clearableCacheRoot);
                    await this.removeClearableCacheRoot(clearableCacheRoot);
                }

                let persistError: unknown;
                try {
                    await this.clearPersistedAssociations();
                } catch (error) {
                    persistError = error;
                }

                this.clearKnownAssociations();

                if (persistError) {
                    throw persistError;
                }
            } finally {
                const lockToRelease = rootLock;
                rootLock = undefined;
                await this.releaseCacheRootLockOrThrow(lockToRelease, cacheRoot.fsPath);
            }
        } catch (error) {
            if (error instanceof InlineScriptCacheOperationError) {
                this.log.warn(error.message);
            } else {
                this.log.error(`Failed to clear inline-script cache: ${getErrorMessage(error)}`);
            }
            throw error;
        } finally {
            this.isClearCacheInProgress = false;
        }
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

    private clearPersistedAssociations(): Promise<void> {
        return this.enqueuePersistence((state) => state.clear([INLINE_SCRIPT_ENVS_KEY]));
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

    private clearKnownAssociations(): void {
        const cleared = [...this.fsPathToEnv.entries()].map(([scriptPath, old]) => ({
            uri: Uri.file(scriptPath),
            old,
            new: undefined as PythonEnvironment | undefined,
        }));
        const knownScriptPaths = new Set([
            ...this.associationRevisions.keys(),
            ...this.pendingRehydrations.keys(),
            ...this.fsPathToPersistedEnvPath.keys(),
            ...this.fsPathToEnv.keys(),
        ]);
        for (const scriptPath of knownScriptPaths) {
            this.bumpAssociationRevision(scriptPath);
            this.pendingRehydrations.delete(scriptPath);
        }
        this.fsPathToEnv.clear();
        this.fsPathToPersistedEnvPath.clear();
        this.cachedAssociationValidatedAt.clear();

        cleared.forEach((event) => this._onDidChangeEnvironment.fire(event));
    }

    private async getClearableCacheRootPath(cacheRoot: Uri): Promise<string | undefined> {
        const globalStoragePath = path.resolve(this.globalStorageUri.fsPath);
        let globalStorageStat: fs.Stats;
        try {
            globalStorageStat = await fs.lstat(globalStoragePath);
        } catch (error) {
            if (isFileNotFoundError(error)) {
                return undefined;
            }
            throw error;
        }
        if (!globalStorageStat.isDirectory() || globalStorageStat.isSymbolicLink()) {
            throw this.createUnsafeClearTargetError(globalStoragePath);
        }

        const resolvedGlobalStorage = await fs.realpath(globalStoragePath);
        if (normalizePath(resolvedGlobalStorage) !== normalizePath(globalStoragePath)) {
            throw this.createUnsafeClearTargetError(globalStoragePath);
        }

        const cacheRootPath = path.resolve(cacheRoot.fsPath);
        try {
            const cacheRootStat = await fs.lstat(cacheRootPath);
            if (!cacheRootStat.isDirectory() || cacheRootStat.isSymbolicLink()) {
                throw this.createUnsafeClearTargetError(cacheRootPath);
            }
        } catch (error) {
            if (isFileNotFoundError(error)) {
                return undefined;
            }
            throw error;
        }

        const resolvedCacheRoot = await resolveCacheEntryPath(Uri.file(globalStoragePath), Uri.file(cacheRootPath));
        const expectedCacheRoot = path.join(resolvedGlobalStorage, INLINE_SCRIPT_CACHE_DIR_NAME);
        if (!resolvedCacheRoot || normalizePath(resolvedCacheRoot) !== normalizePath(expectedCacheRoot)) {
            throw this.createUnsafeClearTargetError(cacheRootPath);
        }

        return resolvedCacheRoot;
    }

    private async acquireCacheRootLock(
        cacheRoot: Uri,
        options: {
            timeoutMs: number;
            retryIntervalMs: number;
        },
        operation: 'create' | 'clear',
    ): Promise<AcquiredFileLock> {
        await fs.ensureDir(path.dirname(cacheRoot.fsPath));
        const lockPath = this.getLockPath(cacheRoot.fsPath);
        try {
            return await acquireFileLock(cacheRoot.fsPath, options);
        } catch (error) {
            if (this.isBusyLockError(error)) {
                throw this.createCacheRootBusyError(operation, lockPath);
            }
            throw error;
        }
    }

    private async assertNoCacheLocks(cacheRootPath: string): Promise<void> {
        let entries: string[];
        try {
            entries = await fs.readdir(cacheRootPath);
        } catch (error) {
            if (isFileNotFoundError(error)) {
                return;
            }
            throw error;
        }

        for (const entry of entries.filter((candidate) => candidate.endsWith('.lock'))) {
            const lockPath = path.join(cacheRootPath, entry);
            const lockDisposition = await this.inspectCacheLock(lockPath);
            if (lockDisposition === 'active') {
                throw this.createActiveLockError(lockPath);
            }
            if (lockDisposition === 'unknown') {
                throw this.createUnknownLockError(lockPath);
            }
        }
    }

    private removeClearableCacheRoot(cacheRootPath: string): Promise<void> {
        return fs.remove(cacheRootPath);
    }

    private async inspectCacheLock(lockPath: string): Promise<CacheLockDisposition> {
        try {
            const lockStat = await fs.lstat(lockPath);
            if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
                return 'unknown';
            }
        } catch {
            return 'unknown';
        }

        const retainedPath = path.join(lockPath, 'retained');
        try {
            const retainedStat = await fs.lstat(retainedPath);
            if (retainedStat.isFile()) {
                return 'retained';
            }
            return 'unknown';
        } catch (error) {
            if (!isFileNotFoundError(error)) {
                return 'unknown';
            }
        }

        try {
            return (await fs.readdir(lockPath)).some((entry) => entry.startsWith('owner-')) ? 'active' : 'unknown';
        } catch {
            return 'unknown';
        }
    }

    private createUnsafeClearTargetError(targetPath: string): Error {
        return new Error(
            l10n.t(
                'Cannot clear the script environment cache because the target could not be proven safe: {0}',
                targetPath,
            ),
        );
    }

    private createCacheOperationConflict(message: string): InlineScriptCacheOperationError {
        return new InlineScriptCacheOperationError(message);
    }

    private createCacheRootBusyError(operation: 'create' | 'clear', lockPath: string): InlineScriptCacheOperationError {
        return this.createCacheOperationConflict(
            operation === 'clear'
                ? l10n.t(
                      'Cannot clear the script environment cache because the cache root lock at {0} may still be active or may have been left by an interrupted operation. Wait for current work to finish or close other VS Code windows and retry. If it persists after restart and no inline script cache operation is using it, remove only this lock path manually.',
                      lockPath,
                  )
                : l10n.t(
                      'Inline script environment cache is busy because the cache root lock at {0} may still be active or may have been left by an interrupted operation. Wait for current work to finish or close other VS Code windows and retry. If it persists after restart and no inline script cache operation is using it, remove only this lock path manually.',
                      lockPath,
                  ),
        );
    }

    private createActiveLockError(lockPath: string): InlineScriptCacheOperationError {
        return this.createCacheOperationConflict(
            l10n.t(
                'Cannot clear the script environment cache because the owner-only lock at {0} may still be active or may have been left by an interrupted operation. Close other VS Code windows and retry. If it persists after restart, manually remove only this lock path after confirming that no inline script cache operation is using it.',
                lockPath,
            ),
        );
    }

    private createUnknownLockError(lockPath: string): InlineScriptCacheOperationError {
        return this.createCacheOperationConflict(
            l10n.t(
                'Cannot clear the script environment cache because the cache lock at {0} could not be verified as retained. Remove it manually only if you know no inline script environment operation still needs it.',
                lockPath,
            ),
        );
    }

    private createCacheRootReleaseError(lockPath: string): InlineScriptCacheOperationError {
        return this.createCacheOperationConflict(
            l10n.t(
                'Failed to release the script environment cache root lock at {0}. Close other VS Code windows and retry. If it persists after restart and no inline script cache operation is using it, remove only this lock path manually.',
                lockPath,
            ),
        );
    }

    private async releaseCacheRootLockOrThrow(lock: AcquiredFileLock, cacheRootPath: string): Promise<void> {
        const lockPath = this.getLockPath(cacheRootPath);
        try {
            await lock.release();
        } catch {
            throw this.createCacheRootReleaseError(lockPath);
        }
    }

    private async releaseCacheLock(lock: AcquiredFileLock, label: string): Promise<void> {
        try {
            await lock.release();
        } catch (error) {
            this.log.warn(`Failed to release ${label} lock: ${getErrorMessage(error)}`);
        }
    }

    private isBusyLockError(error: unknown): boolean {
        return (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            ['ELOCKED', 'ELOCKRETAINED'].includes((error as NodeJS.ErrnoException).code ?? '')
        );
    }

    private getLockPath(targetPath: string): string {
        return `${path.resolve(targetPath)}.lock`;
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
                errorCategory: versionSelection.errorCategory ?? 'no-compatible-python',
            };
        }

        const installResult = await this.installPythonAndRefresh(requiresPython, versionSelection.version);
        if (installResult.kind !== 'installed') {
            return {
                errorCategory:
                    installResult.kind === 'declined' ? 'compatible-python-declined' : 'install-failure',
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
                errorCategory: discoveryFailedAfterInstall ? 'discovery-failure' : 'setup-failure',
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

        let rootLock: AcquiredFileLock | undefined;
        let lock: AcquiredFileLock | undefined;
        try {
            rootLock = await this.acquireCacheRootLock(cacheRoot, {
                timeoutMs: CACHE_CREATE_HANDOFF_LOCK_TIMEOUT_MS,
                retryIntervalMs: CACHE_CREATE_HANDOFF_LOCK_RETRY_MS,
            }, 'create');
            await fs.ensureDir(cacheRoot.fsPath);
            lock = await acquireFileLock(envDir.fsPath, {
                timeoutMs: CACHE_CREATE_HANDOFF_LOCK_TIMEOUT_MS,
                retryIntervalMs: CACHE_CREATE_HANDOFF_LOCK_RETRY_MS,
            });
            const handoffRootLock = rootLock;
            rootLock = undefined;
            await this.releaseCacheRootLockOrThrow(handoffRootLock, cacheRoot.fsPath);

            const cached = await this.inspectCacheEntry(cacheRoot, envDir, metadata, selectedBase);
            if (cached.kind === 'reusable') {
                this.sendInlineScriptEnvReuseHitTelemetry(dependencyCount);
                return cached.environment;
            }
            if (cached.kind === 'uncertain') {
                this.log.warn(
                    `Preserving an inline-script cache entry that could not be safely inspected: ${envDir.fsPath}`,
                );
                this.sendInlineScriptEnvErrorTelemetry('setup-failure');
                return undefined;
            }
            if (cached.kind === 'stale') {
                if (!(await this.removeCacheEntry(envDir))) {
                    this.sendInlineScriptEnvErrorTelemetry('setup-failure');
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
            if (error instanceof InlineScriptCacheOperationError) {
                this.sendInlineScriptEnvErrorTelemetry('setup-failure');
                this.log.warn(error.message);
                return undefined;
            }
            this.sendInlineScriptEnvErrorTelemetry(this.getCreateOrReuseErrorCategory(error));
            this.log.error(`Failed to create or reuse inline-script cache entry: ${getErrorMessage(error)}`);
            return undefined;
        } finally {
            if (lock) {
                await this.releaseCacheLock(lock, 'inline-script cache entry');
            }
            if (rootLock) {
                const lockToRelease = rootLock;
                rootLock = undefined;
                await this.releaseCacheRootLockOrThrow(lockToRelease, cacheRoot.fsPath);
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
            return { errorCategory: 'setup-failure' };
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
            return { errorCategory: 'setup-failure' };
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

    private sendInlineScriptEnvReuseHitTelemetry(dependencyCount: number): void {
        sendTelemetryEvent(EventNames.INLINE_SCRIPT_ENV_REUSE_HIT, { dependencyCount });
    }

    private sendInlineScriptEnvErrorTelemetry(category: InlineScriptEnvErrorCategory): void {
        sendTelemetryEvent(EventNames.INLINE_SCRIPT_ENV_ERROR, undefined, { category });
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
        return 'setup-failure';
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

class InlineScriptCacheOperationError extends Error {}
