// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as fs from 'fs-extra';
import * as path from 'path';
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
} from '../../api';
import { computeCacheKey } from '../../common/inlineScriptCacheKey';
import {
    CacheEnvironmentInspection,
    InlineScriptEnvMeta,
    META_SCHEMA_VERSION,
    getBaseInterpreterStatus,
    getScriptEnvCacheRoot,
    getScriptEnvDir,
    inspectOwnedCacheEntry,
    inspectMetaJson,
    resolveCacheEntryPath,
    writeMetaJson,
} from '../../common/inlineScriptCacheLayout';
import { pickCompatibleInterpreter } from '../../common/inlineScriptInterpreter';
import {
    InlineScriptMetadata,
    matchesPythonVersion,
    readInlineScriptMetadataFromFile,
} from '../../common/inlineScriptMetadata';
import {
    CONDA_MANAGER_ID,
    ENVS_EXTENSION_ID,
    INLINE_SCRIPT_MANAGER_ID,
    PYTHON_EXTENSION_ID,
    SYSTEM_MANAGER_ID,
} from '../../common/constants';
import { acquireFileLock, AcquiredFileLock } from '../../common/lockfile.apis';
import { getWorkspacePersistentState, PersistentState } from '../../common/persistentState';
import { normalizePath } from '../../common/utils/pathUtils';
import { compareReleaseSegments, parseReleaseSegments } from '../../common/utils/pep440Release';
import { getVenvPythonPath } from '../../common/utils/virtualEnvironment';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { createWithProgress, resolveVenvPythonEnvironmentPath } from './venvUtils';

const BASE_INTERPRETER_MANAGER_IDS = new Set([
    SYSTEM_MANAGER_ID,
    CONDA_MANAGER_ID,
    `${PYTHON_EXTENSION_ID}:pyenv`,
]);

const CACHE_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const CACHE_LOCK_RETRY_MS = 500;
/** Workspace-state key for PEP 723 script path to environment executable associations. */
export const INLINE_SCRIPT_ENVS_KEY = `${ENVS_EXTENSION_ID}:inline-script:SCRIPT_ENVIRONMENTS`;

type PersistedInlineScriptEnvironments = Record<string, string>;

interface PersistedAssociationChange {
    readonly scriptPath: string;
    readonly environmentPath?: string;
    readonly expectedEnvironmentPath?: string;
}

/** Manages extension-owned PEP 723 script environments. */
export class InlineScriptEnvManager implements EnvironmentManager, Disposable {
    private readonly pendingCreations = new Map<string, Promise<PythonEnvironment | undefined>>();
    private readonly pendingRehydrations = new Map<string, Promise<PythonEnvironment | undefined>>();
    private readonly fsPathToEnv = new Map<string, PythonEnvironment>();
    private readonly fsPathToPersistedEnvPath = new Map<string, string>();
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

            const packages = [...(metadata.dependencies ?? []), ...(options?.additionalPackages ?? [])].map((value) =>
                value.trim(),
            );
            if (packages.some((value) => value.length === 0)) {
                this.log.warn(`Inline-script dependencies must not contain empty entries: ${scriptUri.fsPath}.`);
                return undefined;
            }

            const selectedBase = await this.selectBaseInterpreter(metadata);
            if (!selectedBase) {
                this.log.warn(`No installed Python satisfies the inline-script requirements for ${scriptUri.fsPath}.`);
                return undefined;
            }
            const cacheKey = computeCacheKey({
                dependencies: packages,
                interpreterPath: selectedBase.canonicalPath,
            });
            const pending = this.pendingCreations.get(cacheKey);
            if (pending) {
                return await pending;
            }

            const creation = this.createOrReuseEnvironment(cacheKey, packages, metadata, selectedBase);
            this.pendingCreations.set(cacheKey, creation);
            try {
                return await creation;
            } finally {
                if (this.pendingCreations.get(cacheKey) === creation) {
                    this.pendingCreations.delete(cacheKey);
                }
            }
        } catch (error) {
            this.log.error(`Failed to set up inline-script environment: ${this.errorMessage(error)}`);
            return undefined;
        }
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

        const changes: {
            readonly uri: Uri;
            readonly scriptPath: string;
            readonly before: PythonEnvironment | undefined;
        }[] = [];
        for (const script of scripts) {
            const before = await this.getAssociationForMutation(script.scriptPath);
            const hadPersistedAssociation = this.fsPathToPersistedEnvPath.has(script.scriptPath);
            const hasSamePersistedEnvironment =
                environmentPath !== undefined &&
                normalizePath(this.fsPathToPersistedEnvPath.get(script.scriptPath) ?? '') ===
                    normalizePath(environmentPath);
            if (
                (!this.isSameEnvironment(before, environment) && !hasSamePersistedEnvironment) ||
                (!environment && hadPersistedAssociation)
            ) {
                changes.push({ ...script, before });
            }
        }
        if (changes.length === 0) {
            return;
        }

        try {
            await this.updatePersistedAssociations(
                changes.map((change) => ({
                    scriptPath: change.scriptPath,
                    environmentPath,
                })),
            );
        } catch (error) {
            this.log.error(`Failed to persist inline-script environment association: ${this.errorMessage(error)}`);
            throw error;
        }

        for (const change of changes) {
            this.bumpAssociationRevision(change.scriptPath);
            if (environment) {
                this.fsPathToEnv.set(change.scriptPath, environment);
                this.fsPathToPersistedEnvPath.set(change.scriptPath, environmentPath!);
            } else {
                this.fsPathToEnv.delete(change.scriptPath);
                this.fsPathToPersistedEnvPath.delete(change.scriptPath);
            }
            this._onDidChangeEnvironment.fire({ uri: change.uri, old: change.before, new: environment });
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

        const environment = await this.getAssociation(normalizePath(scope.fsPath));
        if (!environment) {
            return undefined;
        }

        const requiresPython = metadata.requiresPython?.trim();
        return requiresPython && !matchesPythonVersion(requiresPython, environment.version) ? undefined : environment;
    }

    private getScriptUris(scope: SetEnvironmentScope): { readonly uri: Uri; readonly scriptPath: string }[] {
        const candidates = scope instanceof Uri ? [scope] : Array.isArray(scope) ? scope : [];
        const scripts: { readonly uri: Uri; readonly scriptPath: string }[] = [];
        const seen = new Set<string>();
        for (const candidate of candidates) {
            if (!(candidate instanceof Uri) || candidate.scheme !== 'file') {
                continue;
            }
            const scriptPath = normalizePath(candidate.fsPath);
            if (!seen.has(scriptPath)) {
                seen.add(scriptPath);
                scripts.push({ uri: candidate, scriptPath });
            }
        }
        return scripts;
    }

    private async getAssociation(scriptPath: string): Promise<PythonEnvironment | undefined> {
        const cached = this.fsPathToEnv.get(scriptPath);
        if (cached) {
            return cached;
        }

        const pending = this.pendingRehydrations.get(scriptPath);
        if (pending) {
            return pending;
        }

        const revision = this.associationRevisions.get(scriptPath) ?? 0;
        const rehydration = this.rehydrateAssociation(scriptPath, revision);
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

    private async rehydrateAssociation(scriptPath: string, revision: number): Promise<PythonEnvironment | undefined> {
        let environmentPath: string | undefined;
        try {
            environmentPath = await this.getPersistedAssociation(scriptPath);
        } catch (error) {
            this.log.warn(`Failed to read inline-script environment association: ${this.errorMessage(error)}`);
            return undefined;
        }
        if (!environmentPath) {
            return undefined;
        }
        if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
            return this.fsPathToEnv.get(scriptPath);
        }
        if (!path.isAbsolute(environmentPath)) {
            await this.removeStalePersistedAssociation(scriptPath, environmentPath, revision);
            return undefined;
        }

        try {
            const stat = await fs.stat(environmentPath);
            if (!stat.isFile()) {
                await this.removeStalePersistedAssociation(scriptPath, environmentPath, revision);
                return undefined;
            }
        } catch (error) {
            if (this.isDefinitivelyStalePathError(error)) {
                await this.removeStalePersistedAssociation(scriptPath, environmentPath, revision);
            } else {
                this.log.warn(
                    `Unable to inspect persisted inline-script environment ${environmentPath}: ${this.errorMessage(error)}`,
                );
            }
            return undefined;
        }

        const resolved = await resolveVenvPythonEnvironmentPath(
            environmentPath,
            this.nativeFinder,
            this.api,
            this,
            this.baseManager,
        );
        if (!resolved) {
            // PET/API resolution can fail transiently. Keep the association for a later retry.
            return undefined;
        }

        if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
            return this.fsPathToEnv.get(scriptPath);
        }
        const ownership = await this.inspectAssociationOwnership(resolved);
        if (ownership === 'stale') {
            await this.removeStalePersistedAssociation(scriptPath, environmentPath, revision);
            return undefined;
        }
        if (ownership !== 'expected') {
            return undefined;
        }

        if (!this.isCurrentAssociationRevision(scriptPath, revision) || this.fsPathToEnv.has(scriptPath)) {
            return this.fsPathToEnv.get(scriptPath);
        }
        this.fsPathToEnv.set(scriptPath, resolved);
        return resolved;
    }

    private async inspectAssociationOwnership(environment: PythonEnvironment): Promise<CacheEnvironmentInspection> {
        if (environment.envId.managerId !== INLINE_SCRIPT_MANAGER_ID || !path.isAbsolute(environment.sysPrefix)) {
            return 'stale';
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
            await this.updatePersistedAssociations([{ scriptPath }]);
            this.fsPathToPersistedEnvPath.delete(scriptPath);
            return undefined;
        }
        const rawValue = (raw as Record<string, unknown>)[scriptPath];
        if (rawValue !== undefined && (typeof rawValue !== 'string' || rawValue.length === 0)) {
            await this.updatePersistedAssociations([{ scriptPath }]);
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
    ): Promise<void> {
        if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
            return;
        }
        try {
            await this.updatePersistedAssociations([{ scriptPath, expectedEnvironmentPath }]);
            if (this.fsPathToPersistedEnvPath.get(scriptPath) === expectedEnvironmentPath) {
                this.fsPathToPersistedEnvPath.delete(scriptPath);
            }
        } catch (error) {
            this.log.warn(
                `Failed to remove stale inline-script environment association: ${this.errorMessage(error)}`,
            );
        }
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

    private async selectBaseInterpreter(metadata: InlineScriptMetadata): Promise<SelectedBaseInterpreter | undefined> {
        const reported = (await this.api.getEnvironments('global')).filter(
            (environment) =>
                BASE_INTERPRETER_MANAGER_IDS.has(environment.envId.managerId) &&
                (environment.envId.managerId !== CONDA_MANAGER_ID || environment.name === 'base'),
        );
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
            .filter((candidate) => !candidate.derived)
            .map((candidate) => candidate.environment);

        while (candidates.length > 0) {
            const environment = pickCompatibleInterpreter(candidates, metadata.requiresPython);
            if (!environment) {
                return undefined;
            }
            candidates = candidates.filter((candidate) => candidate !== environment);

            const executable = environment.execInfo?.run.executable;
            if (!executable) {
                continue;
            }
            try {
                return { environment, canonicalPath: await fs.realpath(executable) };
            } catch (error) {
                this.log.warn(
                    `Skipping base interpreter that cannot be resolved at ${executable}: ${this.errorMessage(error)}`,
                );
            }
        }

        return undefined;
    }

    private async createOrReuseEnvironment(
        cacheKey: string,
        packages: ReadonlyArray<string>,
        metadata: InlineScriptMetadata,
        selectedBase: SelectedBaseInterpreter,
    ): Promise<PythonEnvironment | undefined> {
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
                return cached.environment;
            }
            if (cached.kind === 'uncertain') {
                this.log.warn(
                    `Preserving an inline-script cache entry that could not be safely inspected: ${envDir.fsPath}`,
                );
                return undefined;
            }
            if (cached.kind === 'stale') {
                if (!(await this.removeCacheEntry(envDir))) {
                    return undefined;
                }
            }

            const build = await this.buildCacheEntry(envDir, cacheRoot, packages, selectedBase);
            if (build.retainLock) {
                try {
                    await lock.retain();
                } catch (error) {
                    this.log.error(
                        `Failed to mark the inline-script cache lock as retained: ${this.errorMessage(error)}`,
                    );
                }
            }
            return build.environment;
        } catch (error) {
            this.log.error(`Failed to create or reuse inline-script cache entry: ${this.errorMessage(error)}`);
            return undefined;
        } finally {
            if (lock) {
                try {
                    await lock.release();
                } catch (error) {
                    this.log.warn(`Failed to release inline-script cache lock: ${this.errorMessage(error)}`);
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
            return this.isFileNotFoundError(error) ? { kind: 'absent' } : { kind: 'uncertain' };
        }

        let resolvedEntry: string | undefined;
        try {
            resolvedEntry = await resolveCacheEntryPath(cacheRoot, envDir);
        } catch (error) {
            this.log.warn(`Failed to resolve inline-script cache entry: ${this.errorMessage(error)}`);
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
        const releaseComparison = this.comparePythonReleases(environment.version, selectedBase.environment.version);
        if (releaseComparison !== 'same') {
            return { kind: 'stale' };
        }
        const requiresPython = metadata.requiresPython?.trim();
        if (requiresPython && !matchesPythonVersion(requiresPython, environment.version)) {
            return { kind: 'stale' };
        }

        try {
            await writeMetaJson(envDir, { ...sidecar, lastUsedAt: new Date().toISOString() });
        } catch (error) {
            this.log.warn(`Failed to update inline-script cache metadata: ${this.errorMessage(error)}`);
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
                { trackUvEnvironment: false },
            );
        } catch (error) {
            this.log.error(`Failed to build inline-script environment: ${this.errorMessage(error)}`);
            await this.removeCacheEntry(envDir);
            return {};
        }

        if (result?.pkgInstallationCancelled) {
            this.log.warn(
                'Inline-script package installation was cancelled; retaining the cache lock until explicit cleanup.',
            );
            return { retainLock: true };
        }
        if (!result?.environment || result.envCreationErr || result.pkgInstallationErr) {
            const error =
                result?.envCreationErr ?? result?.pkgInstallationErr ?? 'environment creation returned no result';
            this.log.error(`Failed to build inline-script environment: ${error}`);
            await this.removeCacheEntry(envDir);
            return {};
        }
        if (
            this.comparePythonReleases(result.environment.version, selectedBase.environment.version) !== 'same' ||
            (await inspectOwnedCacheEntry(result.environment, cacheRoot, envDir)) !== 'expected'
        ) {
            this.log.error('Created inline-script environment does not match the requested cache entry.');
            await this.removeCacheEntry(envDir);
            return {};
        }

        const sidecar: InlineScriptEnvMeta = {
            schemaVersion: META_SCHEMA_VERSION,
            baseInterpreterPath: selectedBase.canonicalPath,
            baseInterpreterVersion: selectedBase.environment.version,
            lastUsedAt: new Date().toISOString(),
        };
        try {
            await writeMetaJson(envDir, sidecar);
        } catch (error) {
            this.log.error(`Failed to record inline-script cache metadata: ${this.errorMessage(error)}`);
            await this.removeCacheEntry(envDir);
            return {};
        }

        return { environment: result.environment };
    }

    private async removeCacheEntry(envDir: Uri): Promise<boolean> {
        try {
            await fs.remove(envDir.fsPath);
            return true;
        } catch (error) {
            this.log.error(`Failed to remove incomplete inline-script environment: ${this.errorMessage(error)}`);
            return false;
        }
    }

    private isFileNotFoundError(error: unknown): boolean {
        return (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error as NodeJS.ErrnoException).code === 'ENOENT'
        );
    }

    private isDefinitivelyStalePathError(error: unknown): boolean {
        if (this.isFileNotFoundError(error)) {
            return true;
        }
        return (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            ['ENOTDIR', 'EINVAL', 'ERR_INVALID_ARG_VALUE'].includes((error as NodeJS.ErrnoException).code ?? '')
        );
    }

    private comparePythonReleases(actual: string, expected: string): PythonReleaseComparison {
        const actualRelease = parseReleaseSegments(actual);
        const expectedRelease = parseReleaseSegments(expected);
        if (actualRelease === undefined || expectedRelease === undefined) {
            return 'uncertain';
        }
        return compareReleaseSegments(actualRelease, expectedRelease) === 0 ? 'same' : 'different';
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    dispose(): void {
        this._onDidChangeEnvironments.dispose();
        this._onDidChangeEnvironment.dispose();
    }
}

interface SelectedBaseInterpreter {
    readonly environment: PythonEnvironment;
    readonly canonicalPath: string;
}

interface BuildCacheEntryResult {
    readonly environment?: PythonEnvironment;
    readonly retainLock?: boolean;
}

type CacheEntryInspection =
    | { readonly kind: 'absent' | 'stale' | 'uncertain' }
    | { readonly kind: 'reusable'; readonly environment: PythonEnvironment };

type PythonReleaseComparison = 'same' | 'different' | 'uncertain';
