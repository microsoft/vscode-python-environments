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
import { extractLowerBoundVersion, pickCompatibleInterpreter } from '../../common/inlineScriptInterpreter';
import {
    InlineScriptMetadata,
    matchesPythonVersion,
    readInlineScriptMetadataFromFile,
} from '../../common/inlineScriptMetadata';
import { CONDA_MANAGER_ID, PYTHON_EXTENSION_ID, SYSTEM_MANAGER_ID } from '../../common/constants';
import { acquireFileLock, AcquiredFileLock } from '../../common/lockfile.apis';
import { normalizePath } from '../../common/utils/pathUtils';
import { compareReleaseSegments, parseReleaseSegments } from '../../common/utils/pep440Release';
import { getVenvPythonPath } from '../../common/utils/virtualEnvironment';
import { NativePythonFinder } from '../common/nativePythonFinder';
import * as uvPythonInstaller from './uvPythonInstaller';
import { createWithProgress, resolveVenvPythonEnvironmentPath } from './venvUtils';

const BASE_INTERPRETER_MANAGER_IDS = new Set([
    SYSTEM_MANAGER_ID,
    CONDA_MANAGER_ID,
    `${PYTHON_EXTENSION_ID}:pyenv`,
]);

const CACHE_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const CACHE_LOCK_RETRY_MS = 500;

/** Manages extension-owned PEP 723 script environments. */
export class InlineScriptEnvManager implements EnvironmentManager, Disposable {
    private readonly pendingCreations = new Map<string, Promise<PythonEnvironment | undefined>>();
    private readonly pendingBaseInterpreterInstallations = new Map<string, Promise<boolean>>();

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

            let selectedBase = await this.selectBaseInterpreter(metadata);
            if (!selectedBase) {
                selectedBase = await this.installAndSelectBaseInterpreter(metadata);
            }
            if (!selectedBase) {
                this.log.warn(`No compatible Python is available for inline-script environment creation: ${scriptUri.fsPath}.`);
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

    async set(_scope: SetEnvironmentScope, _environment?: PythonEnvironment): Promise<void> {
        return;
    }

    async get(_scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        return undefined;
    }

    async resolve(_context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
        return undefined;
    }

    private getScriptUri(scope: CreateEnvironmentScope): Uri | undefined {
        const uri = scope instanceof Uri ? scope : Array.isArray(scope) && scope.length === 1 ? scope[0] : undefined;
        return uri?.scheme === 'file' ? uri : undefined;
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

    private async installAndSelectBaseInterpreter(
        metadata: InlineScriptMetadata,
    ): Promise<SelectedBaseInterpreter | undefined> {
        const requiresPython = metadata.requiresPython?.trim() || undefined;
        const version = extractLowerBoundVersion(requiresPython);
        if (requiresPython && !version) {
            this.log.warn(
                'Cannot install a Python for this inline script because its requires-python constraint has no safe lower bound.',
            );
            return undefined;
        }

        const installKey = version ?? 'latest';
        let installation = this.pendingBaseInterpreterInstallations.get(installKey);
        if (!installation) {
            installation = this.installPythonAndRefresh(requiresPython, version);
            this.pendingBaseInterpreterInstallations.set(installKey, installation);
            void installation.finally(() => {
                if (this.pendingBaseInterpreterInstallations.get(installKey) === installation) {
                    this.pendingBaseInterpreterInstallations.delete(installKey);
                }
            });
        }

        if (!(await installation)) {
            return undefined;
        }

        const selected = await this.selectBaseInterpreter(metadata);
        if (!selected) {
            this.log.warn(
                'Python was installed for an inline script, but no compatible base interpreter was discovered after refreshing environments.',
            );
        }
        return selected;
    }

    private async installPythonAndRefresh(requiresPython: string | undefined, version: string | undefined): Promise<boolean> {
        try {
            const installedPath = await uvPythonInstaller.promptInstallPythonViaUv('inlineScript', this.log, {
                requiresPython,
                version,
            });
            if (!installedPath) {
                this.log.warn('Python installation for inline-script environment creation was declined or did not complete.');
                return false;
            }

            await this.api.refreshEnvironments(undefined);
            return true;
        } catch (error) {
            this.log.error(`Failed to install or discover Python for an inline script: ${this.errorMessage(error)}`);
            return false;
        }
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
