// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import type { Stats } from 'fs';
import * as fs from 'fs-extra';
import * as path from 'path';
import {
    Disposable,
    Event,
    EventEmitter,
    l10n,
    LogOutputChannel,
    MarkdownString,
    Memento,
    ThemeIcon,
    Uri,
} from 'vscode';
import {
    CreateEnvironmentOptions,
    CreateEnvironmentScope,
    DidChangeEnvironmentEventArgs,
    DidChangeEnvironmentsEventArgs,
    EnvironmentChangeKind,
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
import {
    CONDA_MANAGER_ID,
    INLINE_SCRIPT_MANAGER_ID,
    PYENV_MANAGER_ID,
    SYSTEM_MANAGER_ID,
} from '../../../common/constants';
import { getErrorMessage } from '../../../common/errors/utils';
import { computeCacheKey, normalizeDependency } from '../../../common/inlineScript/cacheKey';
import {
    CacheEntrySummary,
    CacheEnvironmentInspection,
    getBaseInterpreterStatus,
    getScriptEnvCacheRoot,
    getScriptEnvDir,
    hashSourceMetadataIdentity,
    INLINE_SCRIPT_CACHE_DIR_NAME,
    InlineScriptEnvMeta,
    inspectMetaJson,
    inspectOwnedCacheEntry,
    mergeSourceMetadataIdentityHashes,
    META_SCHEMA_VERSION,
    resolveCacheEntryPath,
    restoreMetaJsonBackupUnderLock,
    selectStaleEntries,
    writeMetaJson,
} from '../../../common/inlineScript/cacheLayout';
import { extractLowerBoundVersion, pickCompatibleInterpreter } from '../../../common/inlineScript/interpreter';
import { InlineScriptMetadata, readInlineScriptMetadataFromFile } from '../../../common/inlineScript/metadata';
import {
    getInlineScriptMetadataRoutingIdentity,
    InlineScriptMetadataChangeEvent,
    InlineScriptRoutingRegistry,
} from '../../../common/inlineScript/routingRegistry';
import {
    AcquiredFileLock,
    acquireFileLock,
    FILE_LOCK_DIR_SUFFIX,
    getFileLockPath,
    inspectFileLock,
    reclaimFileLock,
} from '../../../common/lockfile.apis';
import { EventNames, InlineScriptEnvErrorCategory } from '../../../common/telemetry/constants';
import { sendTelemetryEvent } from '../../../common/telemetry/sender';
import { createDeferred, Deferred } from '../../../common/utils/deferred';
import { isFileNotFoundError } from '../../../common/utils/filesystem';
import { normalizePath } from '../../../common/utils/pathUtils';
import { PythonVersion } from '../../../common/pythonVersion';
import { PythonVersionSpecifier, splitClause } from '../../../common/pythonVersionSpecifier';
import { getVenvPythonPath } from '../../../common/utils/virtualEnvironment';
import { getOpenTextDocuments, onDidDeleteFiles, onDidRenameFiles } from '../../../common/workspace.apis';
import { NativePythonFinder } from '../../common/nativePythonFinder';
import { sortEnvironments } from '../../common/utils';
import { resolveSystemPythonEnvironmentPath } from '../utils';
import * as uvPythonInstaller from '../uvPythonInstaller';
import { createWithProgress, hasMinimumPathDepth, isDriveRoot, resolveVenvPythonEnvironmentPath } from '../venvUtils';
import { InlineAssociationAccessor, InlineScriptAssociationStore } from './associationStore';

const BASE_INTERPRETER_MANAGER_IDS = new Set([SYSTEM_MANAGER_ID, CONDA_MANAGER_ID, PYENV_MANAGER_ID]);

const CACHE_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const CACHE_LOCK_RETRY_MS = 500;
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const CACHED_ASSOCIATION_VALIDATION_INTERVAL_MS = 5_000;
const DISCOVERY_RETRY_DELAYS_MS = [1_000, 5_000, 30_000] as const;
const PERSISTED_ASSOCIATION_SCHEMA_VERSION = 1 as const;

interface SelectedBaseInterpreter {
    readonly environment: PythonEnvironment;
    readonly canonicalPath: string;
}

interface CreateOrReuseEnvironmentOptions {
    readonly cacheKey: string;
    readonly packages: ReadonlyArray<string>;
    readonly metadata: InlineScriptMetadata;
    readonly selectedBase: SelectedBaseInterpreter;
    readonly pendingCreation: PendingCreationContext;
    readonly scriptUri: Uri;
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

interface DiscoveryRefreshPass {
    readonly promise: Promise<boolean>;
    readonly checksForSnapshotChanges: boolean;
}

interface PendingCreationContext {
    promise: Promise<PythonEnvironment | undefined>;
    sourceMetadataIdentityHashes?: readonly string[];
    hasStartedRecordingSourceMetadataIdentityHashes: boolean;
    recordedSourceMetadataIdentityHashes?: readonly string[];
}

interface MergeCacheEntrySourceMetadataIdentityHashResult {
    readonly success: boolean;
    readonly sourceMetadataIdentityHashes?: readonly string[];
}

interface CacheEntryRemovalOptions {
    readonly shouldRemove?: (entryPath: string) => Promise<boolean>;
    readonly afterRemove?: () => void;
    readonly reclaimRetainedLock?: boolean;
}

type CacheEntryInspection =
    | { readonly kind: 'absent' | 'stale' | 'uncertain' }
    | { readonly kind: 'reusable'; readonly environment: PythonEnvironment };

interface PendingAssociationValidation {
    readonly metadataIdentity: string;
    readonly associationRevision: number;
    readonly promise: Promise<PythonEnvironment | undefined>;
}

interface PendingMetadataRefresh {
    readonly metadataIdentity: string;
    readonly metadataRevision: number;
    readonly associationRevision: number;
    readonly promise: Promise<void>;
}

interface ParsedPersistedAssociations {
    readonly rawEntries: Record<string, unknown>;
    readonly records: PersistedInlineScriptEnvironments;
    readonly invalidKeys: Set<string>;
}

interface SavedMetadataSnapshot {
    readonly metadata?: InlineScriptMetadata;
    readonly identity?: string;
}

/** Manages extension-owned PEP 723 script environments. */
export class InlineScriptEnvManager implements EnvironmentManager, Disposable {
    private readonly pendingSetups = new Map<string, Promise<PythonEnvironment | undefined>>();
    private readonly pendingCreations = new Map<string, PendingCreationContext>();
    private readonly directlyResolvedBaseInterpreters = new Map<string, PythonEnvironment>();
    private baseInterpreterInstallationQueue: Promise<void> = Promise.resolve();
    private collection: PythonEnvironment[] = [];
    private readonly pendingRehydrations = new Map<string, PendingAssociationValidation>();
    private readonly pendingMetadataRefreshes = new Map<string, PendingMetadataRefresh>();
    private readonly fsPathToEnv = new Map<string, PythonEnvironment>();
    private readonly fsPathToPersistedAssociation = new Map<string, PersistedAssociationRecord>();
    private readonly cachedAssociationValidatedAt = new Map<string, number>();
    private readonly lastValidatedMetadataIdentities = new Map<string, string>();
    private readonly lastValidatedMetadataIdentityProofs = new Map<string, boolean>();
    private readonly associationRevisions = new Map<string, number>();
    private pendingRefresh: DiscoveryRefreshPass | undefined;
    private pendingSnapshotRefresh: Promise<boolean> | undefined;
    private activationDiscoveryActive = false;
    private discoveryRetryAttempt = 0;
    private discoveryRetryTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly subscriptions: Disposable[] = [];
    private readonly associationStore: InlineScriptAssociationStore;
    private readonly persistedAssociationsLoaded: Promise<void>;
    private selectionQueue: Promise<void> = Promise.resolve();
    private cacheMaintenanceQueue: Promise<void> = Promise.resolve();
    private cacheMaintenanceBarrier: Deferred<void> | undefined;
    private pendingCacheMaintenances = 0;
    private activeCreateOperations = 0;
    private ttlEviction: Promise<void> | undefined;
    private cacheMutationRevision = 0;
    private disposed = false;

    private readonly _onDidChangeEnvironments = new EventEmitter<DidChangeEnvironmentsEventArgs>();
    public readonly onDidChangeEnvironments: Event<DidChangeEnvironmentsEventArgs> =
        this._onDidChangeEnvironments.event;

    private readonly _onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
    public readonly onDidChangeEnvironment: Event<DidChangeEnvironmentEventArgs> = this._onDidChangeEnvironment.event;

    public readonly name = 'inline-script';
    public readonly displayName = l10n.t('Inline scripts');
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
        workspaceState: Memento,
        private readonly routingRegistry: InlineScriptRoutingRegistry = new InlineScriptRoutingRegistry(),
    ) {
        this.associationStore = new InlineScriptAssociationStore(workspaceState);
        this.subscriptions.push(
            this.routingRegistry.onDidChangeMetadata((event) => {
                void this.handleSavedMetadataChange(event).catch((error) => {
                    this.log.warn(`Failed to refresh inline-script routing state: ${getErrorMessage(error)}`);
                });
            }),
            onDidDeleteFiles((event) => {
                void this.clearAssociationsForScripts(event.files).catch((error) => {
                    this.log.warn(
                        `Failed to clear inline-script associations for deleted files: ${getErrorMessage(error)}`,
                    );
                });
            }),
            onDidRenameFiles((event) => {
                void this.clearAssociationsForScripts(event.files.map((file) => file.oldUri)).catch((error) => {
                    this.log.warn(
                        `Failed to clear inline-script associations for renamed files: ${getErrorMessage(error)}`,
                    );
                });
            }),
        );
        this.persistedAssociationsLoaded = this.loadPersistedAssociations();
        void this.initializePersistedAssociations().catch((error) => {
            this.log.warn(`Failed to prime inline-script environment associations: ${getErrorMessage(error)}`);
        });
    }

    async create(
        scope: CreateEnvironmentScope,
        options?: CreateEnvironmentOptions,
    ): Promise<PythonEnvironment | undefined> {
        this.activeCreateOperations += 1;
        try {
            await this.runTtlEvictionOnce();
            return await this.waitForCacheMaintenance(async () => {
                try {
                    const scriptUri = this.getScriptUri(scope);
                    if (!scriptUri) {
                        this.log.warn('Inline-script environment creation requires exactly one local file URI.');
                        return undefined;
                    }
                    this.routingRegistry.clearSetupOutcome(scriptUri);

                    const metadata = await readInlineScriptMetadataFromFile(scriptUri);
                    if (!metadata) {
                        this.log.warn(`No valid PEP 723 metadata found in ${scriptUri.fsPath}.`);
                        return undefined;
                    }

                    const packages = [...(metadata.dependencies ?? []), ...(options?.additionalPackages ?? [])].map(
                        (value) => value.trim(),
                    );
                    if (packages.some((value) => value.length === 0)) {
                        this.log.warn(
                            `Inline-script dependencies must not contain empty entries: ${scriptUri.fsPath}.`,
                        );
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
                    this.sendInlineScriptEnvErrorTelemetry('setup-failure');
                    this.log.error(`Failed to set up inline-script environment: ${getErrorMessage(error)}`);
                    return undefined;
                }
            });
        } finally {
            this.activeCreateOperations -= 1;
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
            this.routingRegistry.noteSetupOutcome(scriptUri, {
                kind: 'failed',
                category: baseSelection.errorCategory ?? 'setup-failure',
                requiresPython: metadata.requiresPython,
            });
            this.log.warn(
                `No compatible Python is available for inline-script environment creation: ${scriptUri.fsPath}.`,
            );
            return undefined;
        }
        const selectedBase = baseSelection.selectedBase;

        const cacheKey = computeCacheKey({
            dependencies: packages,
            interpreterPath: selectedBase.canonicalPath,
        });
        const metadataIdentity = getInlineScriptMetadataRoutingIdentity(metadata);
        const sourceMetadataIdentityHash = metadataIdentity ? hashSourceMetadataIdentity(metadataIdentity) : undefined;
        const pending = this.pendingCreations.get(cacheKey);
        if (pending) {
            const joinedAfterPendingCreationStartedRecordingSourceMetadataIdentityHashes =
                pending.hasStartedRecordingSourceMetadataIdentityHashes;
            this.addPendingCreationSourceMetadataIdentityHash(pending, sourceMetadataIdentityHash);
            const environment = await pending.promise;
            return await this.finalizeCreateForScript(
                cacheKey,
                environment,
                sourceMetadataIdentityHash,
                pending,
                joinedAfterPendingCreationStartedRecordingSourceMetadataIdentityHashes,
            );
        }
        const pendingCreation: PendingCreationContext = {
            promise: Promise.resolve(undefined),
            sourceMetadataIdentityHashes: mergeSourceMetadataIdentityHashes(undefined, sourceMetadataIdentityHash),
            hasStartedRecordingSourceMetadataIdentityHashes: false,
        };
        const creation = this.createOrReuseEnvironment({
            cacheKey,
            packages,
            metadata,
            selectedBase,
            pendingCreation,
            scriptUri,
        });
        pendingCreation.promise = creation;
        this.pendingCreations.set(cacheKey, pendingCreation);
        try {
            const environment = await creation;
            return await this.finalizeCreateForScript(
                cacheKey,
                environment,
                sourceMetadataIdentityHash,
                pendingCreation,
                false,
            );
        } finally {
            if (this.pendingCreations.get(cacheKey) === pendingCreation) {
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

    private addPendingCreationSourceMetadataIdentityHash(
        pendingCreation: PendingCreationContext,
        sourceMetadataIdentityHash: string | undefined,
    ): void {
        pendingCreation.sourceMetadataIdentityHashes = mergeSourceMetadataIdentityHashes(
            pendingCreation.sourceMetadataIdentityHashes,
            sourceMetadataIdentityHash,
        );
    }

    private async finalizeCreateForScript(
        cacheKey: string,
        environment: PythonEnvironment | undefined,
        sourceMetadataIdentityHash: string | undefined,
        pendingCreation: PendingCreationContext,
        joinedAfterPendingCreationStartedRecordingSourceMetadataIdentityHashes: boolean,
    ): Promise<PythonEnvironment | undefined> {
        if (!environment || !sourceMetadataIdentityHash) {
            return environment;
        }
        if (
            pendingCreation.recordedSourceMetadataIdentityHashes?.includes(sourceMetadataIdentityHash) !== true &&
            joinedAfterPendingCreationStartedRecordingSourceMetadataIdentityHashes
        ) {
            const mergeResult = await this.mergeCacheEntrySourceMetadataIdentityHash(
                cacheKey,
                sourceMetadataIdentityHash,
            );
            if (!mergeResult.success) {
                this.log.warn(
                    `Failed to durably record inline-script cache provenance for ${cacheKey}; returning no environment to the caller.`,
                );
                return undefined;
            }
            pendingCreation.recordedSourceMetadataIdentityHashes = mergeResult.sourceMetadataIdentityHashes;
        }
        return environment;
    }

    async refresh(_scope: RefreshEnvironmentsScope): Promise<void> {
        if (this.disposed) {
            return;
        }
        this.stopActivationDiscovery();
        await this.getOrStartRefreshPass(false);
    }

    async getEnvironments(scope: GetEnvironmentsScope): Promise<PythonEnvironment[]> {
        if (scope === 'all') {
            return Array.from(this.collection);
        }
        return [];
    }

    async set(scope: SetEnvironmentScope, environment?: PythonEnvironment): Promise<void> {
        return this.waitForCacheMaintenance(() => this.enqueueSelection(() => this.setInternal(scope, environment)));
    }

    async get(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        return this.waitForCacheMaintenance(() => this.getInternal(scope));
    }

    async resolve(_context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
        return undefined;
    }

    async clearCache(): Promise<void> {
        const activeCreatesAtStart = this.activeCreateOperations;
        return this.enqueueCacheMaintenance(() =>
            this.enqueueSelection(() => this.clearCacheInternal(activeCreatesAtStart)),
        );
    }

    public startActivationDiscovery(): void {
        if (this.disposed || this.activationDiscoveryActive) {
            return;
        }
        this.activationDiscoveryActive = true;
        this.discoveryRetryAttempt = 0;
        this.runActivationDiscoveryPass();
    }

    private getOrStartRefreshPass(checkForSnapshotChanges: boolean): Promise<boolean> {
        const pending = this.pendingRefresh;
        if (pending) {
            return checkForSnapshotChanges && !pending.checksForSnapshotChanges
                ? this.getOrScheduleSnapshotRefresh(pending)
                : pending.promise;
        }

        return this.startRefreshPass(checkForSnapshotChanges);
    }

    private startRefreshPass(checkForSnapshotChanges: boolean): Promise<boolean> {
        const pass: DiscoveryRefreshPass = {
            promise: this.refreshDiscoveredEnvironments(checkForSnapshotChanges),
            checksForSnapshotChanges: checkForSnapshotChanges,
        };
        this.pendingRefresh = pass;
        void pass.promise.then(
            () => {
                if (this.pendingRefresh === pass) {
                    this.pendingRefresh = undefined;
                }
            },
            () => {
                if (this.pendingRefresh === pass) {
                    this.pendingRefresh = undefined;
                }
            },
        );
        return pass.promise;
    }

    private getOrScheduleSnapshotRefresh(sharedPass: DiscoveryRefreshPass): Promise<boolean> {
        const pending = this.pendingSnapshotRefresh;
        if (pending) {
            return pending;
        }

        const followUp = this.startSnapshotRefreshAfter(sharedPass);
        this.pendingSnapshotRefresh = followUp;
        void followUp.then(
            () => {
                if (this.pendingSnapshotRefresh === followUp) {
                    this.pendingSnapshotRefresh = undefined;
                }
            },
            () => {
                if (this.pendingSnapshotRefresh === followUp) {
                    this.pendingSnapshotRefresh = undefined;
                }
            },
        );
        return followUp;
    }

    private async startSnapshotRefreshAfter(sharedPass: DiscoveryRefreshPass): Promise<boolean> {
        await sharedPass.promise;
        if (this.disposed || !this.activationDiscoveryActive) {
            return false;
        }
        const pending = this.pendingRefresh;
        if (pending && pending !== sharedPass) {
            return pending.checksForSnapshotChanges ? pending.promise : this.startSnapshotRefreshAfter(pending);
        }
        return this.startRefreshPass(true);
    }

    private runActivationDiscoveryPass(): void {
        if (this.disposed || !this.activationDiscoveryActive) {
            return;
        }

        void this.getOrStartRefreshPass(true)
            .then((shouldRetry) => {
                if (this.disposed || !this.activationDiscoveryActive) {
                    return;
                }
                if (!shouldRetry) {
                    this.stopActivationDiscovery();
                    return;
                }
                this.scheduleActivationDiscoveryRetry();
            })
            .catch((error) => {
                if (this.disposed || !this.activationDiscoveryActive) {
                    return;
                }
                this.log.warn(`Activation-time inline-script discovery failed: ${getErrorMessage(error)}`);
                this.stopActivationDiscovery();
            });
    }

    private async refreshDiscoveredEnvironments(checkForSnapshotChanges: boolean): Promise<boolean> {
        const cacheMaintenance = this.cacheMaintenanceBarrier;
        if (cacheMaintenance) {
            await cacheMaintenance.promise;
        }
        const cacheMutationRevision = this.cacheMutationRevision;
        const cacheRoot = getScriptEnvCacheRoot(this.globalStorageUri);
        const previousByKey = new Map(
            this.collection.map((environment) => [this.getDiscoveredEnvironmentKey(environment), environment]),
        );

        let entryNames: string[];
        try {
            entryNames = await fs.readdir(cacheRoot.fsPath);
        } catch (error) {
            if (this.isDefinitivelyStalePathError(error)) {
                entryNames = [];
            } else {
                this.log.warn(
                    `Unable to inspect the inline-script cache root ${cacheRoot.fsPath}: ${getErrorMessage(error)}`,
                );
                return true;
            }
        }

        const lockedKeys = new Set<string>();
        const nextByKey = new Map<string, PythonEnvironment>();
        const initialFingerprints = new Map<string, string | undefined>();
        let shouldRetry = false;
        for (const entryName of entryNames.sort()) {
            if (entryName.endsWith('.lock')) {
                lockedKeys.add(this.getDiscoveryEntryKey(entryName.slice(0, -5)));
                shouldRetry = true;
                continue;
            }

            if (this.disposed) {
                return false;
            }

            const envDir = Uri.joinPath(cacheRoot, entryName);
            const key = this.getDiscoveryEntryKey(entryName);
            const discovered = await this.inspectDiscoveredCacheEntry(cacheRoot, envDir);
            initialFingerprints.set(key, discovered.fingerprint);
            if (discovered.kind === 'resolved') {
                nextByKey.set(key, discovered.environment);
            } else if (discovered.kind === 'preserve') {
                shouldRetry = true;
                const previous = previousByKey.get(key);
                if (previous) {
                    nextByKey.set(key, previous);
                }
            }
        }
        for (const [key, previous] of previousByKey) {
            if (!nextByKey.has(key) && lockedKeys.has(key)) {
                nextByKey.set(key, previous);
            }
        }

        if (this.disposed) {
            return false;
        }

        if (checkForSnapshotChanges) {
            let finalEntryNames: string[] | undefined;
            let finalCacheRootMissing = false;
            try {
                finalEntryNames = await fs.readdir(cacheRoot.fsPath);
            } catch (error) {
                if (this.isDefinitivelyStalePathError(error)) {
                    finalEntryNames = [];
                    finalCacheRootMissing = true;
                } else {
                    this.log.warn(
                        `Unable to verify the final inline-script cache snapshot ${cacheRoot.fsPath}: ${getErrorMessage(error)}`,
                    );
                    return true;
                }
            }

            if (finalCacheRootMissing) {
                shouldRetry ||= entryNames.length > 0;
                nextByKey.clear();
            } else if (finalEntryNames !== undefined) {
                const initialEntries = new Set(entryNames);
                const snapshotChanged =
                    finalEntryNames.length !== entryNames.length ||
                    finalEntryNames.some((entryName) => !initialEntries.has(entryName));
                if (snapshotChanged) {
                    return true;
                }

                for (const entryName of finalEntryNames) {
                    if (entryName.endsWith(FILE_LOCK_DIR_SUFFIX)) {
                        continue;
                    }
                    const key = this.getDiscoveryEntryKey(entryName);
                    let finalFingerprint: string;
                    try {
                        finalFingerprint = this.getCacheEntryFingerprint(
                            await fs.lstat(Uri.joinPath(cacheRoot, entryName).fsPath),
                        );
                    } catch (error) {
                        if (this.isDefinitivelyStalePathError(error)) {
                            return true;
                        }
                        this.log.warn(
                            `Unable to verify inline-script cache entry ${entryName}: ${getErrorMessage(error)}`,
                        );
                        return true;
                    }
                    if (initialFingerprints.get(key) !== finalFingerprint) {
                        return true;
                    }
                }
            }
        }

        if (this.disposed) {
            return false;
        }
        if (cacheMutationRevision !== this.cacheMutationRevision) {
            return true;
        }

        // Preserve previously known entries when a refresh cannot safely classify
        // them because a build is in progress or the filesystem is transiently unavailable.
        this.replaceDiscoveredEnvironments(sortEnvironments(Array.from(nextByKey.values())));
        return shouldRetry;
    }

    private async inspectDiscoveredCacheEntry(cacheRoot: Uri, envDir: Uri): Promise<DiscoveredCacheEntryResult> {
        let fingerprint: string | undefined;
        try {
            const stat = await fs.lstat(envDir.fsPath);
            fingerprint = this.getCacheEntryFingerprint(stat);
            if (!stat.isDirectory() || stat.isSymbolicLink()) {
                return { kind: 'skip', fingerprint };
            }
        } catch (error) {
            return this.isDefinitivelyStalePathError(error) ? { kind: 'skip' } : { kind: 'preserve' };
        }

        if (await this.isCacheEntryBusy(envDir.fsPath)) {
            return { kind: 'preserve', fingerprint };
        }

        try {
            if (!(await resolveCacheEntryPath(cacheRoot, envDir))) {
                return { kind: 'skip', fingerprint };
            }
        } catch (error) {
            return this.isDefinitivelyStalePathError(error)
                ? { kind: 'skip', fingerprint }
                : { kind: 'preserve', fingerprint };
        }

        const sidecarResult = await inspectMetaJson(envDir);
        if (sidecarResult.kind !== 'valid') {
            return {
                kind: sidecarResult.kind === 'unavailable' ? 'preserve' : 'skip',
                fingerprint,
            };
        }

        const baseInterpreterStatus = await getBaseInterpreterStatus(envDir);
        if (baseInterpreterStatus !== 'available') {
            return {
                kind: baseInterpreterStatus === 'unavailable' ? 'preserve' : 'skip',
                fingerprint,
            };
        }

        let environment: PythonEnvironment | undefined;
        try {
            environment = await resolveVenvPythonEnvironmentPath(
                getVenvPythonPath(envDir.fsPath),
                this.nativeFinder,
                this.api,
                this,
                this.baseManager,
                'inlineScript',
            );
        } catch (error) {
            this.log.warn(`Unable to resolve inline-script cache entry ${envDir.fsPath}: ${getErrorMessage(error)}`);
            return { kind: 'preserve', fingerprint };
        }
        if (!environment) {
            return { kind: 'preserve', fingerprint };
        }

        const ownership = await inspectOwnedCacheEntry(environment, cacheRoot, envDir);
        if (ownership !== 'expected') {
            return {
                kind: ownership === 'uncertain' ? 'preserve' : 'skip',
                fingerprint,
            };
        }
        if (!this.areEqualPythonReleases(environment.version, sidecarResult.metadata.baseInterpreterVersion)) {
            return { kind: 'skip', fingerprint };
        }

        return { kind: 'resolved', environment, fingerprint };
    }

    private replaceDiscoveredEnvironments(next: PythonEnvironment[]): void {
        const previousByKey = new Map(
            this.collection.map((environment) => [this.getDiscoveredEnvironmentKey(environment), environment]),
        );
        const nextByKey = new Map(
            next.map((environment) => [this.getDiscoveredEnvironmentKey(environment), environment]),
        );
        const changes: DidChangeEnvironmentsEventArgs = [];

        for (const [key, previous] of previousByKey) {
            const current = nextByKey.get(key);
            if (!current || !this.isSameDiscoveredEnvironment(previous, current)) {
                changes.push({ kind: EnvironmentChangeKind.remove, environment: previous });
            }
        }
        for (const [key, current] of nextByKey) {
            const previous = previousByKey.get(key);
            if (!previous || !this.isSameDiscoveredEnvironment(previous, current)) {
                changes.push({ kind: EnvironmentChangeKind.add, environment: current });
            }
        }

        this.collection = next;
        if (changes.length > 0) {
            this._onDidChangeEnvironments.fire(changes);
        }
    }

    private getDiscoveryEntryKey(entryName: string): string {
        return normalizePath(entryName);
    }

    private getCacheEntryFingerprint(stat: Stats): string {
        return [stat.dev, stat.ino, stat.birthtimeMs, stat.ctimeMs, stat.mtimeMs].join(':');
    }

    private getDiscoveredEnvironmentKey(environment: PythonEnvironment): string {
        return this.getDiscoveryEntryKey(path.basename(environment.sysPrefix));
    }

    private isSameDiscoveredEnvironment(first: PythonEnvironment, second: PythonEnvironment): boolean {
        return (
            first.envId.managerId === second.envId.managerId &&
            normalizePath(first.environmentPath.fsPath) === normalizePath(second.environmentPath.fsPath) &&
            first.version === second.version
        );
    }

    private scheduleActivationDiscoveryRetry(): void {
        if (this.discoveryRetryTimer) {
            return;
        }

        const delayMs = this.getDiscoveryRetryDelayMs(this.discoveryRetryAttempt);
        if (delayMs === undefined) {
            this.stopActivationDiscovery();
            return;
        }

        this.discoveryRetryAttempt += 1;
        this.discoveryRetryTimer = setTimeout(() => {
            this.discoveryRetryTimer = undefined;
            if (this.disposed || !this.activationDiscoveryActive) {
                return;
            }
            this.runActivationDiscoveryPass();
        }, delayMs);
    }

    private getDiscoveryRetryDelayMs(attempt: number): number | undefined {
        return DISCOVERY_RETRY_DELAYS_MS[attempt];
    }

    private stopActivationDiscovery(): void {
        if (this.discoveryRetryTimer) {
            clearTimeout(this.discoveryRetryTimer);
            this.discoveryRetryTimer = undefined;
        }
        this.activationDiscoveryActive = false;
        this.discoveryRetryAttempt = 0;
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
            const persistedAssociation = this.getPersistedAssociationFromMemory(script.scriptPath);
            const savedMetadata = environment ? await this.getSavedMetadataForPersistence(script.uri) : undefined;
            const sourceMetadataIdentity =
                environment && savedMetadata
                    ? await this.resolveVerifiedSourceMetadataIdentity(script, environment, savedMetadata)
                    : undefined;
            const nextPersistedAssociation = environmentPath
                ? this.createPersistedAssociationRecord(
                      environmentPath,
                      sourceMetadataIdentity,
                      savedMetadata?.identity,
                  )
                : undefined;
            const needsPersistence = nextPersistedAssociation
                ? !this.isSamePersistedAssociation(persistedAssociation, nextPersistedAssociation)
                : persistedAssociation !== undefined;
            const shouldNotify =
                (!this.isSameEnvironment(before, environment) &&
                    !this.isSamePersistedAssociation(persistedAssociation, nextPersistedAssociation)) ||
                (!environment && persistedAssociation !== undefined);
            const hasPendingRehydration = this.pendingRehydrations.has(script.scriptPath);
            const cached = this.fsPathToEnv.get(script.scriptPath);
            const needsMemoryUpdate = environment ? cached !== environment : cached !== undefined;
            if (needsPersistence || shouldNotify || hasPendingRehydration || needsMemoryUpdate) {
                updates.push({
                    ...script,
                    before,
                    persistedAssociation: nextPersistedAssociation,
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
                        persistedAssociation: update.persistedAssociation,
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
            this.pendingMetadataRefreshes.delete(update.scriptPath);
            if (environment) {
                this.fsPathToEnv.set(update.scriptPath, environment);
                this.fsPathToPersistedAssociation.set(update.scriptPath, update.persistedAssociation!);
                this.invalidateCachedAssociationValidation(update.scriptPath);
            } else {
                this.fsPathToEnv.delete(update.scriptPath);
                this.fsPathToPersistedAssociation.delete(update.scriptPath);
                this.invalidateCachedAssociationValidation(update.scriptPath);
            }
            if (update.shouldNotify) {
                this._onDidChangeEnvironment.fire({
                    uri: update.uri,
                    old: update.before,
                    new: environment,
                });
            }
        }

        await Promise.all(
            updates.map(async (update) => {
                if (!environment) {
                    this.clearValidatedRouteableState(update.uri);
                    return;
                }
                await this.updateValidatedStateForSelection(update);
            }),
        );
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

        return this.getAssociationForMetadata(normalizePath(scope.fsPath), scope, metadata);
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

    private async getAssociationForMetadata(
        scriptPath: string,
        scriptUri: Uri,
        metadata: InlineScriptMetadata,
    ): Promise<PythonEnvironment | undefined> {
        const pending = this.pendingRehydrations.get(scriptPath);
        const cached = this.fsPathToEnv.get(scriptPath);
        const revision = this.associationRevisions.get(scriptPath) ?? 0;
        const metadataIdentity = getInlineScriptMetadataRoutingIdentity(metadata)!;
        const forceFreshValidation =
            this.fsPathToPersistedAssociation.get(scriptPath)?.metadataBinding.kind === 'pending';
        if (pending && pending.metadataIdentity === metadataIdentity && pending.associationRevision === revision) {
            return pending.promise;
        }
        if (cached) {
            const validatedAt = this.cachedAssociationValidatedAt.get(scriptPath);
            if (
                !forceFreshValidation &&
                validatedAt !== undefined &&
                this.lastValidatedMetadataIdentities.get(scriptPath) === metadataIdentity &&
                Date.now() - validatedAt < CACHED_ASSOCIATION_VALIDATION_INTERVAL_MS
            ) {
                return cached;
            }
            const validation = this.validateCachedAssociation(
                scriptPath,
                scriptUri,
                cached,
                revision,
                metadataIdentity,
                metadata,
            );
            this.pendingRehydrations.set(scriptPath, {
                metadataIdentity,
                associationRevision: revision,
                promise: validation,
            });
            try {
                return await validation;
            } finally {
                if (this.pendingRehydrations.get(scriptPath)?.promise === validation) {
                    this.pendingRehydrations.delete(scriptPath);
                }
            }
        }

        const rehydration = this.rehydrateAssociation(scriptPath, scriptUri, revision, metadataIdentity, metadata);
        this.pendingRehydrations.set(scriptPath, {
            metadataIdentity,
            associationRevision: revision,
            promise: rehydration,
        });
        try {
            return await rehydration;
        } finally {
            if (this.pendingRehydrations.get(scriptPath)?.promise === rehydration) {
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
        metadataIdentity: string,
        metadata: InlineScriptMetadata,
    ): Promise<PythonEnvironment | undefined> {
        const environmentPath = cached.environmentPath.fsPath;
        const expectedPersistedAssociation = this.fsPathToPersistedAssociation.get(scriptPath);
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
                    'inlineScript',
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
                        expectedPersistedAssociation,
                    );
                    return undefined;
                }
                if (ownership !== 'expected') {
                    return undefined;
                }
                const metadataMatch = this.inspectAssociationMetadata(scriptPath, metadataIdentity, true);
                if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
                    return this.fsPathToEnv.get(scriptPath);
                }
                if (metadataMatch === 'mismatched') {
                    return undefined;
                }
                const sidecar = await this.readCurrentCacheEntrySidecar(resolved);
                if (sidecar && !this.cacheEntryMatchesRuntimeAndMetadata(sidecar, resolved, metadata)) {
                    return undefined;
                }
                const metadataIdentityProven =
                    !!sidecar &&
                    this.cacheEntryProvesSourceMetadataIdentity(sidecar, resolved, metadataIdentity, metadata);
                if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
                    return this.fsPathToEnv.get(scriptPath);
                }
                const current = this.fsPathToEnv.get(scriptPath);
                this.cachedAssociationValidatedAt.set(scriptPath, Date.now());
                this.lastValidatedMetadataIdentities.set(scriptPath, metadataIdentity);
                this.lastValidatedMetadataIdentityProofs.set(scriptPath, metadataIdentityProven);
                if (current && this.isSameEnvironment(current, resolved)) {
                    return current;
                }
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
                    expectedPersistedAssociation,
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
                        expectedPersistedAssociation,
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
        metadataIdentity: string,
        metadata: InlineScriptMetadata,
    ): Promise<PythonEnvironment | undefined> {
        let persistedAssociation: PersistedAssociationRecord | undefined;
        try {
            persistedAssociation = await this.getPersistedAssociation(scriptPath);
        } catch (error) {
            this.log.warn(`Failed to read inline-script environment association: ${getErrorMessage(error)}`);
            return undefined;
        }
        const environmentPath = persistedAssociation?.environmentPath;
        if (!environmentPath) {
            return undefined;
        }
        if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
            return this.fsPathToEnv.get(scriptPath);
        }
        if (!path.isAbsolute(environmentPath)) {
            await this.removeStalePersistedAssociation(
                scriptPath,
                environmentPath,
                revision,
                scriptUri,
                persistedAssociation,
            );
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
                    await this.removeStalePersistedAssociation(
                        scriptPath,
                        environmentPath,
                        revision,
                        scriptUri,
                        persistedAssociation,
                    );
                }
                return undefined;
            }
        } catch (error) {
            if (this.isDefinitivelyStalePathError(error)) {
                if (!(await this.isCacheEntryBusy(envDirPath))) {
                    await this.removeStalePersistedAssociation(
                        scriptPath,
                        environmentPath,
                        revision,
                        scriptUri,
                        persistedAssociation,
                    );
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
                'inlineScript',
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
            await this.removeStalePersistedAssociation(
                scriptPath,
                environmentPath,
                revision,
                scriptUri,
                persistedAssociation,
            );
            return undefined;
        }
        if (ownership !== 'expected') {
            return undefined;
        }
        const metadataMatch = this.inspectAssociationMetadata(scriptPath, metadataIdentity, true);
        if (metadataMatch === 'mismatched') {
            return undefined;
        }
        const sidecar = await this.readCurrentCacheEntrySidecar(resolved);
        if (sidecar && !this.cacheEntryMatchesRuntimeAndMetadata(sidecar, resolved, metadata)) {
            return undefined;
        }
        const metadataIdentityProven =
            !!sidecar && this.cacheEntryProvesSourceMetadataIdentity(sidecar, resolved, metadataIdentity, metadata);
        if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
            return this.fsPathToEnv.get(scriptPath);
        }

        const current = this.fsPathToEnv.get(scriptPath);
        this.cachedAssociationValidatedAt.set(scriptPath, Date.now());
        this.lastValidatedMetadataIdentities.set(scriptPath, metadataIdentity);
        this.lastValidatedMetadataIdentityProofs.set(scriptPath, metadataIdentityProven);
        if (current && this.isSameEnvironment(current, resolved)) {
            return current;
        }
        if (!this.isCurrentAssociationRevision(scriptPath, revision) || this.fsPathToEnv.has(scriptPath)) {
            return this.fsPathToEnv.get(scriptPath);
        }
        this.fsPathToEnv.set(scriptPath, resolved);
        this._onDidChangeEnvironment.fire({ uri: scriptUri, old: undefined, new: resolved });
        return resolved;
    }

    private inspectAssociationMetadata(
        scriptPath: string,
        metadataIdentity: string,
        allowUnboundAssociation: boolean,
    ): 'matched' | 'pending' | 'legacy' | 'mismatched' {
        const persistedAssociation = this.fsPathToPersistedAssociation.get(scriptPath);
        if (!persistedAssociation) {
            return 'mismatched';
        }
        if (persistedAssociation.metadataBinding.kind === 'matched') {
            return persistedAssociation.metadataBinding.sourceIdentity === metadataIdentity ? 'matched' : 'mismatched';
        }
        if (persistedAssociation.metadataBinding.kind === 'pending') {
            return persistedAssociation.metadataBinding.sourceIdentity === metadataIdentity && allowUnboundAssociation
                ? 'pending'
                : 'mismatched';
        }
        return allowUnboundAssociation ? 'legacy' : 'mismatched';
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
        return inspectOwnedCacheEntry(environment, cacheRoot, envDir);
    }

    private async handleSavedMetadataChange(event: InlineScriptMetadataChangeEvent): Promise<void> {
        if (event.metadata === undefined) {
            this.clearValidatedRouteableState(event.uri);
            return;
        }
        await this.refreshValidatedAssociationForMetadata(
            event.uri,
            event.metadata,
            event.metadataIdentity ?? getInlineScriptMetadataRoutingIdentity(event.metadata)!,
            event.metadataRevision,
        );
    }

    private async refreshValidatedAssociationForMetadata(
        uri: Uri,
        metadata: InlineScriptMetadata,
        metadataIdentity: string,
        metadataRevision: number,
    ): Promise<void> {
        const scriptPath = normalizePath(uri.fsPath);
        const associationRevision = this.associationRevisions.get(scriptPath) ?? 0;
        const pendingRefresh = this.pendingMetadataRefreshes.get(scriptPath);
        if (
            pendingRefresh &&
            pendingRefresh.metadataIdentity === metadataIdentity &&
            pendingRefresh.metadataRevision === metadataRevision &&
            pendingRefresh.associationRevision === associationRevision
        ) {
            return pendingRefresh.promise;
        }
        const refresh = this.refreshValidatedAssociationForMetadataInternal(
            scriptPath,
            uri,
            metadata,
            metadataIdentity,
            metadataRevision,
            associationRevision,
        );
        this.pendingMetadataRefreshes.set(scriptPath, {
            metadataIdentity,
            metadataRevision,
            associationRevision,
            promise: refresh,
        });
        try {
            await refresh;
        } finally {
            if (this.pendingMetadataRefreshes.get(scriptPath)?.promise === refresh) {
                this.pendingMetadataRefreshes.delete(scriptPath);
            }
        }
    }

    private async refreshValidatedAssociationForMetadataInternal(
        scriptPath: string,
        uri: Uri,
        metadata: InlineScriptMetadata,
        metadataIdentity: string,
        metadataRevision: number,
        associationRevision: number,
    ): Promise<void> {
        const environment = await this.getAssociationForMetadata(scriptPath, uri, metadata);
        if (
            !this.isCurrentMetadataRefreshTask(uri, metadataIdentity, metadataRevision, scriptPath, associationRevision)
        ) {
            return;
        }
        if (!environment) {
            this.clearValidatedRouteableState(uri);
            return;
        }
        let metadataIdentityProven = this.lastValidatedMetadataIdentityProofs.get(scriptPath);
        if (
            this.lastValidatedMetadataIdentities.get(scriptPath) !== metadataIdentity ||
            metadataIdentityProven === undefined
        ) {
            metadataIdentityProven = await this.currentCacheEntryProvesSourceMetadataIdentity(
                environment,
                metadataIdentity,
                metadata,
            );
            if (
                !this.isCurrentMetadataRefreshTask(
                    uri,
                    metadataIdentity,
                    metadataRevision,
                    scriptPath,
                    associationRevision,
                )
            ) {
                return;
            }
            this.cachedAssociationValidatedAt.set(scriptPath, Date.now());
            this.lastValidatedMetadataIdentities.set(scriptPath, metadataIdentity);
            this.lastValidatedMetadataIdentityProofs.set(scriptPath, metadataIdentityProven);
        }
        if (metadataIdentityProven !== true) {
            this.clearValidatedRouteableState(uri);
            return;
        }
        const metadataMatch = this.inspectAssociationMetadata(scriptPath, metadataIdentity, true);
        if (metadataMatch === 'pending') {
            let bindResult = await this.bindPendingMetadataIdentity(
                scriptPath,
                environment.environmentPath.fsPath,
                metadataIdentity,
                metadataRevision,
                associationRevision,
                uri,
            );
            if (!this.isCurrentRoutingMetadata(uri, metadataIdentity, metadataRevision)) {
                return;
            }
            if (bindResult === 'stale' && !this.isCurrentAssociationRevision(scriptPath, associationRevision)) {
                const currentAssociation = this.fsPathToPersistedAssociation.get(scriptPath);
                const currentAssociationRevision = this.associationRevisions.get(scriptPath) ?? 0;
                if (
                    currentAssociation?.metadataBinding.kind === 'pending' &&
                    currentAssociation.metadataBinding.sourceIdentity === metadataIdentity &&
                    normalizePath(currentAssociation.environmentPath) ===
                        normalizePath(environment.environmentPath.fsPath)
                ) {
                    bindResult = await this.bindPendingMetadataIdentity(
                        scriptPath,
                        environment.environmentPath.fsPath,
                        metadataIdentity,
                        metadataRevision,
                        currentAssociationRevision,
                        uri,
                    );
                    if (
                        !this.isCurrentMetadataRefreshTask(
                            uri,
                            metadataIdentity,
                            metadataRevision,
                            scriptPath,
                            currentAssociationRevision,
                        )
                    ) {
                        return;
                    }
                }
            } else if (!this.isCurrentAssociationRevision(scriptPath, associationRevision)) {
                return;
            }
            if (bindResult !== 'bound') {
                const currentAssociation = this.fsPathToPersistedAssociation.get(scriptPath);
                if (
                    currentAssociation?.metadataBinding.kind === 'pending' &&
                    currentAssociation.metadataBinding.sourceIdentity === metadataIdentity &&
                    normalizePath(currentAssociation.environmentPath) ===
                        normalizePath(environment.environmentPath.fsPath)
                ) {
                    this.invalidateCachedAssociationValidation(scriptPath);
                }
                return;
            }
        } else if (metadataMatch !== 'matched') {
            this.clearValidatedRouteableState(uri);
            return;
        }
        this.routingRegistry.setValidatedAssociation(uri, true);
    }

    private async updateValidatedStateForSelection(script: ScriptReference): Promise<void> {
        const savedMetadata = await this.getSavedMetadataForPersistence(script.uri);
        if (!savedMetadata.identity) {
            this.clearValidatedRouteableState(script.uri);
            return;
        }
        if (this.inspectAssociationMetadata(script.scriptPath, savedMetadata.identity, false) !== 'matched') {
            this.clearValidatedRouteableState(script.uri);
            return;
        }
        this.cachedAssociationValidatedAt.set(script.scriptPath, Date.now());
        this.lastValidatedMetadataIdentities.set(script.scriptPath, savedMetadata.identity);
        this.routingRegistry.setValidatedAssociation(
            script.uri,
            this.routingRegistry.getMetadataIdentity(script.uri) === savedMetadata.identity,
        );
    }

    private async getSavedMetadataForPersistence(uri: Uri): Promise<SavedMetadataSnapshot> {
        for (const document of getOpenTextDocuments()) {
            if (document.uri.toString() === uri.toString() && document.isDirty) {
                return {};
            }
        }
        return this.readSavedMetadataSnapshot(uri);
    }

    private async readSavedMetadataSnapshot(uri: Uri): Promise<SavedMetadataSnapshot> {
        const metadata = await readInlineScriptMetadataFromFile(uri);
        return {
            metadata,
            identity: getInlineScriptMetadataRoutingIdentity(metadata),
        };
    }

    private async currentCacheEntryProvesSourceMetadataIdentity(
        environment: PythonEnvironment,
        metadataIdentity: string,
        metadata: InlineScriptMetadata,
    ): Promise<boolean> {
        const sidecar = await this.readCurrentCacheEntrySidecar(environment);
        return (
            !!sidecar && this.cacheEntryProvesSourceMetadataIdentity(sidecar, environment, metadataIdentity, metadata)
        );
    }

    private async readCurrentCacheEntrySidecar(
        environment: PythonEnvironment,
    ): Promise<InlineScriptEnvMeta | undefined> {
        let sidecarResult;
        try {
            sidecarResult = await inspectMetaJson(Uri.file(environment.sysPrefix));
        } catch {
            return undefined;
        }
        return sidecarResult.kind === 'valid' ? sidecarResult.metadata : undefined;
    }

    private cacheEntryProvesSourceMetadataIdentity(
        sidecar: InlineScriptEnvMeta,
        environment: PythonEnvironment,
        metadataIdentity: string,
        metadata: InlineScriptMetadata,
    ): boolean {
        if (!this.cacheEntryMatchesRuntimeAndMetadata(sidecar, environment, metadata)) {
            return false;
        }
        return (
            this.sidecarProvesSourceMetadataIdentity(sidecar, metadataIdentity) ||
            this.isMetadataOnlyCacheEntryForMetadata(sidecar, environment, metadata)
        );
    }

    private cacheEntryMatchesRuntimeAndMetadata(
        sidecar: InlineScriptEnvMeta,
        environment: PythonEnvironment,
        metadata: InlineScriptMetadata,
    ): boolean {
        if (!this.areEqualPythonReleases(environment.version, sidecar.baseInterpreterVersion)) {
            return false;
        }
        const requiresPython = metadata.requiresPython?.trim();
        return !requiresPython || this.matchesInstallConstraint(requiresPython, environment.version);
    }

    private async resolveVerifiedSourceMetadataIdentity(
        script: ScriptReference,
        environment: PythonEnvironment,
        savedMetadata: SavedMetadataSnapshot,
    ): Promise<string | undefined> {
        if (savedMetadata.identity) {
            return savedMetadata.metadata &&
                (await this.currentCacheEntryProvesSourceMetadataIdentity(
                    environment,
                    savedMetadata.identity,
                    savedMetadata.metadata,
                ))
                ? savedMetadata.identity
                : undefined;
        }

        const persistedSourceMetadataIdentity = this.getPersistedSourceMetadataIdentity(
            script.scriptPath,
            environment.environmentPath.fsPath,
        );
        if (persistedSourceMetadataIdentity) {
            const sidecar = await this.readCurrentCacheEntrySidecar(environment);
            if (sidecar && this.sidecarProvesSourceMetadataIdentity(sidecar, persistedSourceMetadataIdentity)) {
                return persistedSourceMetadataIdentity;
            }
        }

        const savedSourceMetadata = await this.readSavedMetadataSnapshot(script.uri);
        if (!savedSourceMetadata.identity || !savedSourceMetadata.metadata) {
            return undefined;
        }
        return (await this.currentCacheEntryProvesSourceMetadataIdentity(
            environment,
            savedSourceMetadata.identity,
            savedSourceMetadata.metadata,
        ))
            ? savedSourceMetadata.identity
            : undefined;
    }

    private sidecarProvesSourceMetadataIdentity(sidecar: InlineScriptEnvMeta, metadataIdentity: string): boolean {
        if (sidecar.sourceMetadataIdentityHashes === undefined) {
            return false;
        }
        const expectedHash = hashSourceMetadataIdentity(metadataIdentity);
        return sidecar.sourceMetadataIdentityHashes.includes(expectedHash);
    }

    private isMetadataOnlyCacheEntryForMetadata(
        sidecar: InlineScriptEnvMeta,
        environment: PythonEnvironment,
        metadata: InlineScriptMetadata,
    ): boolean {
        if (sidecar.sourceMetadataIdentityHashes !== undefined) {
            return false;
        }
        const expectedCacheKey = computeCacheKey({
            dependencies: metadata.dependencies ?? [],
            interpreterPath: sidecar.baseInterpreterPath,
        });
        if (
            normalizePath(getScriptEnvDir(this.globalStorageUri, expectedCacheKey).fsPath) !==
            normalizePath(environment.sysPrefix)
        ) {
            return false;
        }
        const requiresPython = metadata.requiresPython?.trim();
        return !requiresPython || this.matchesInstallConstraint(requiresPython, environment.version);
    }

    private getPersistedSourceMetadataIdentity(scriptPath: string, environmentPath: string): string | undefined {
        const persistedAssociation = this.fsPathToPersistedAssociation.get(scriptPath);
        return persistedAssociation &&
            normalizePath(persistedAssociation.environmentPath) === normalizePath(environmentPath) &&
            (persistedAssociation.metadataBinding.kind === 'matched' ||
                persistedAssociation.metadataBinding.kind === 'pending')
            ? persistedAssociation.metadataBinding.sourceIdentity
            : undefined;
    }

    private async bindPendingMetadataIdentity(
        scriptPath: string,
        environmentPath: string,
        metadataIdentity: string,
        metadataRevision: number,
        associationRevision: number,
        uri: Uri,
    ): Promise<'bound' | 'stale' | 'failed'> {
        return this.enqueueSelection(async () => {
            if (
                !this.isCurrentAssociationRevision(scriptPath, associationRevision) ||
                !this.isCurrentRoutingMetadata(uri, metadataIdentity, metadataRevision)
            ) {
                return 'stale';
            }
            const expectedAssociation: PersistedAssociationRecord = {
                environmentPath,
                metadataBinding: { kind: 'pending', sourceIdentity: metadataIdentity },
            };
            const matchedAssociation: PersistedAssociationRecord = {
                environmentPath,
                metadataBinding: { kind: 'matched', sourceIdentity: metadataIdentity },
            };
            if (
                !this.isSamePersistedAssociation(this.fsPathToPersistedAssociation.get(scriptPath), expectedAssociation)
            ) {
                return 'stale';
            }
            try {
                await this.updatePersistedAssociations([
                    {
                        scriptPath,
                        persistedAssociation: matchedAssociation,
                        expectedPersistedAssociation: expectedAssociation,
                    },
                ]);
            } catch (error) {
                this.log.warn(`Failed to bind inline-script metadata identity: ${getErrorMessage(error)}`);
                return 'failed';
            }
            if (
                !this.isCurrentAssociationRevision(scriptPath, associationRevision) ||
                !this.isCurrentRoutingMetadata(uri, metadataIdentity, metadataRevision)
            ) {
                return 'stale';
            }
            return this.isSamePersistedAssociation(
                this.fsPathToPersistedAssociation.get(scriptPath),
                matchedAssociation,
            )
                ? 'bound'
                : 'stale';
        });
    }

    private isCurrentMetadataRefreshTask(
        uri: Uri,
        metadataIdentity: string,
        metadataRevision: number,
        scriptPath: string,
        associationRevision: number,
    ): boolean {
        return (
            this.isCurrentRoutingMetadata(uri, metadataIdentity, metadataRevision) &&
            this.isCurrentAssociationRevision(scriptPath, associationRevision)
        );
    }

    private isCurrentRoutingMetadata(uri: Uri, metadataIdentity: string, metadataRevision: number): boolean {
        return (
            this.routingRegistry.getMetadataIdentity(uri) === metadataIdentity &&
            this.routingRegistry.getMetadataRevision(uri) === metadataRevision
        );
    }

    private clearValidatedRouteableState(script: Uri | string): void {
        const scriptPath = typeof script === 'string' ? script : normalizePath(script.fsPath);
        this.invalidateCachedAssociationValidation(scriptPath);
        this.routingRegistry.setValidatedAssociation(script, false);
    }

    private invalidateCachedAssociationValidation(scriptPath: string): void {
        this.cachedAssociationValidatedAt.delete(scriptPath);
        this.lastValidatedMetadataIdentities.delete(scriptPath);
        this.lastValidatedMetadataIdentityProofs.delete(scriptPath);
    }

    private loadPersistedAssociations(): Promise<void> {
        return this.enqueuePersistence(async (state) => {
            const rawAssociations = await state.get<unknown>();
            const parsed = this.parsePersistedAssociations(rawAssociations);
            this.applyPersistedAssociations(parsed?.records ?? {});
        });
    }

    private async seedRoutingMetadataFromSavedFile(uri: Uri, scriptPath: string): Promise<void> {
        if (this.routingRegistry.getMetadata(scriptPath) || this.isDocumentOpen(scriptPath)) {
            return;
        }
        const metadata = await readInlineScriptMetadataFromFile(uri);
        if (metadata && !this.routingRegistry.getMetadata(scriptPath)) {
            this.routingRegistry.setMetadata(uri, metadata);
        }
    }

    private isDocumentOpen(scriptPath: string): boolean {
        return getOpenTextDocuments().some(
            (document) => document.uri.scheme === 'file' && normalizePath(document.uri.fsPath) === scriptPath,
        );
    }

    private initializePersistedAssociations(): Promise<void> {
        return this.persistedAssociationsLoaded.then(async () => {
            await Promise.all(
                [...this.fsPathToPersistedAssociation.keys()].map(async (scriptPath) => {
                    await this.seedRoutingMetadataFromSavedFile(Uri.file(scriptPath), scriptPath);
                    const uri = this.routingRegistry.getUri(scriptPath);
                    const metadata = this.routingRegistry.getMetadata(scriptPath);
                    if (uri && metadata) {
                        await this.refreshValidatedAssociationForMetadata(
                            uri,
                            metadata,
                            getInlineScriptMetadataRoutingIdentity(metadata)!,
                            this.routingRegistry.getMetadataRevision(uri),
                        );
                    }
                }),
            );
        });
    }

    private async getPersistedAssociation(scriptPath: string): Promise<PersistedAssociationRecord | undefined> {
        const rawAssociations = await this.associationStore.read<unknown>();
        if (rawAssociations === undefined) {
            this.applyPersistedAssociations({});
            return undefined;
        }
        const parsed = this.parsePersistedAssociations(rawAssociations);
        if (!parsed) {
            await this.removeInvalidPersistedAssociation(scriptPath);
            return this.getPersistedAssociationFromMemory(scriptPath);
        }
        const rawValue = (rawAssociations as Record<string, unknown>)[scriptPath];
        if (rawValue !== undefined && this.parsePersistedAssociationValue(rawValue).kind === 'invalid') {
            await this.removeInvalidPersistedAssociation(scriptPath);
            return this.getPersistedAssociationFromMemory(scriptPath);
        }
        this.applyPersistedAssociations(parsed.records);
        return this.getPersistedAssociationFromMemory(scriptPath);
    }

    private async removeStalePersistedAssociation(
        scriptPath: string,
        expectedEnvironmentPath: string,
        revision: number,
        scriptUri?: Uri,
        expectedPersistedAssociation?: PersistedAssociationRecord,
    ): Promise<void> {
        await this.enqueueSelection(async () => {
            if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
                return;
            }
            try {
                const persistedPathBeforeUpdate = this.fsPathToPersistedAssociation.get(scriptPath)?.environmentPath;
                await this.updatePersistedAssociations([
                    {
                        scriptPath,
                        expectedEnvironmentPath,
                        expectedPersistedAssociation,
                    },
                ]);
                if (
                    normalizePath(persistedPathBeforeUpdate ?? '') === normalizePath(expectedEnvironmentPath) &&
                    !this.fsPathToPersistedAssociation.has(scriptPath) &&
                    this.isCurrentAssociationRevision(scriptPath, revision)
                ) {
                    const old = this.fsPathToEnv.get(scriptPath);
                    this.bumpAssociationRevision(scriptPath);
                    this.fsPathToEnv.delete(scriptPath);
                    this.fsPathToPersistedAssociation.delete(scriptPath);
                    this.clearValidatedRouteableState(scriptPath);
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
            const rawAssociations = await state.get<unknown>();
            if (rawAssociations === undefined) {
                this.applyPersistedAssociations({});
                return;
            }
            const parsed = this.parsePersistedAssociations(rawAssociations);
            if (!parsed) {
                await state.update({});
                this.applyPersistedAssociations({});
                return;
            }
            if (parsed.invalidKeys.has(scriptPath)) {
                delete parsed.rawEntries[scriptPath];
                delete parsed.records[scriptPath];
                parsed.invalidKeys.delete(scriptPath);
                await state.update(parsed.rawEntries);
            }
            this.applyPersistedAssociations(parsed.records);
        });
    }

    private updatePersistedAssociations(changes: readonly PersistedAssociationChange[]): Promise<void> {
        return this.enqueuePersistence(async (state) => {
            const rawAssociations = await state.get<unknown>();
            const parsed = this.parsePersistedAssociations(rawAssociations);
            const rawEntries = { ...(parsed?.rawEntries ?? {}) };
            const associations = { ...(parsed?.records ?? {}) };
            for (const change of changes) {
                const current = associations[change.scriptPath];
                if (change.persistedAssociation) {
                    if (
                        change.expectedPersistedAssociation &&
                        !this.isSamePersistedAssociation(current, change.expectedPersistedAssociation)
                    ) {
                        continue;
                    }
                    associations[change.scriptPath] = change.persistedAssociation;
                    rawEntries[change.scriptPath] = this.serializePersistedAssociation(change.persistedAssociation);
                } else if (
                    (change.expectedPersistedAssociation &&
                        this.isSamePersistedAssociation(current, change.expectedPersistedAssociation)) ||
                    (change.expectedPersistedAssociation === undefined &&
                        (change.expectedEnvironmentPath === undefined ||
                            (current !== undefined &&
                                normalizePath(current.environmentPath) ===
                                    normalizePath(change.expectedEnvironmentPath))))
                ) {
                    delete associations[change.scriptPath];
                    delete rawEntries[change.scriptPath];
                }
            }
            await state.update(rawEntries);
            this.applyPersistedAssociations(associations);
        });
    }

    private parsePersistedAssociations(value: unknown): ParsedPersistedAssociations | undefined {
        if (value === undefined) {
            return {
                rawEntries: {},
                records: {},
                invalidKeys: new Set<string>(),
            };
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return undefined;
        }
        const rawEntries = { ...(value as Record<string, unknown>) };
        const records: PersistedInlineScriptEnvironments = {};
        const invalidKeys = new Set<string>();
        for (const [scriptPath, association] of Object.entries(rawEntries)) {
            const parsed = this.parsePersistedAssociationValue(association);
            if (parsed.kind === 'valid') {
                records[scriptPath] = parsed.record;
            } else if (parsed.kind === 'invalid') {
                invalidKeys.add(scriptPath);
            }
        }
        return { rawEntries, records, invalidKeys };
    }

    private getPersistedAssociationFromMemory(scriptPath: string): PersistedAssociationRecord | undefined {
        return this.fsPathToPersistedAssociation.get(scriptPath);
    }

    private createPersistedAssociationRecord(
        environmentPath: string,
        sourceMetadataIdentity: string | undefined,
        currentMetadataIdentity: string | undefined,
    ): PersistedAssociationRecord {
        if (!sourceMetadataIdentity) {
            return {
                environmentPath,
                metadataBinding: currentMetadataIdentity
                    ? { kind: 'pending', sourceIdentity: currentMetadataIdentity }
                    : { kind: 'legacy' },
            };
        }
        return {
            environmentPath,
            metadataBinding:
                currentMetadataIdentity === sourceMetadataIdentity
                    ? { kind: 'matched', sourceIdentity: sourceMetadataIdentity }
                    : { kind: 'pending', sourceIdentity: sourceMetadataIdentity },
        };
    }

    private isSamePersistedAssociation(
        first: PersistedAssociationRecord | undefined,
        second: PersistedAssociationRecord | undefined,
    ): boolean {
        if (first === second) {
            return true;
        }
        if (!first || !second) {
            return false;
        }
        if (normalizePath(first.environmentPath) !== normalizePath(second.environmentPath)) {
            return false;
        }
        if (first.metadataBinding.kind !== second.metadataBinding.kind) {
            return false;
        }
        if (first.metadataBinding.kind === 'matched' && second.metadataBinding.kind === 'matched') {
            return first.metadataBinding.sourceIdentity === second.metadataBinding.sourceIdentity;
        }
        if (first.metadataBinding.kind === 'pending' && second.metadataBinding.kind === 'pending') {
            return first.metadataBinding.sourceIdentity === second.metadataBinding.sourceIdentity;
        }
        return true;
    }

    private parsePersistedAssociationValue(
        value: unknown,
    ):
        | { readonly kind: 'valid'; readonly record: PersistedAssociationRecord }
        | { readonly kind: 'future' }
        | { readonly kind: 'invalid' } {
        if (typeof value === 'string' && value.length > 0) {
            return {
                kind: 'valid',
                record: {
                    environmentPath: value,
                    metadataBinding: { kind: 'legacy' },
                },
            };
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return { kind: 'invalid' };
        }
        const association = value as Record<string, unknown>;
        const schemaVersion = association.schemaVersion;
        if (typeof schemaVersion !== 'number' || !Number.isSafeInteger(schemaVersion) || schemaVersion <= 0) {
            return { kind: 'invalid' };
        }
        if (schemaVersion > PERSISTED_ASSOCIATION_SCHEMA_VERSION) {
            return { kind: 'future' };
        }
        if (schemaVersion !== PERSISTED_ASSOCIATION_SCHEMA_VERSION) {
            return { kind: 'invalid' };
        }
        const environmentPath = association.environmentPath;
        const metadataBinding = association.metadataBinding;
        if (typeof environmentPath !== 'string' || environmentPath.length === 0) {
            return { kind: 'invalid' };
        }
        if (!metadataBinding || typeof metadataBinding !== 'object' || Array.isArray(metadataBinding)) {
            return { kind: 'invalid' };
        }
        const binding = metadataBinding as Record<string, unknown>;
        if (binding.kind === 'pending') {
            if (typeof binding.sourceIdentity === 'string' && binding.sourceIdentity.trim().length > 0) {
                return {
                    kind: 'valid',
                    record: {
                        environmentPath,
                        metadataBinding: { kind: 'pending', sourceIdentity: binding.sourceIdentity },
                    },
                };
            }
            return { kind: 'invalid' };
        }
        if (binding.kind === 'legacy') {
            return {
                kind: 'valid',
                record: { environmentPath, metadataBinding: { kind: 'legacy' } },
            };
        }
        if (
            binding.kind === 'matched' &&
            typeof binding.sourceIdentity === 'string' &&
            binding.sourceIdentity.trim().length > 0
        ) {
            return {
                kind: 'valid',
                record: {
                    environmentPath,
                    metadataBinding: {
                        kind: 'matched',
                        sourceIdentity: binding.sourceIdentity,
                    },
                },
            };
        }
        return { kind: 'invalid' };
    }

    private serializePersistedAssociation(
        association: PersistedAssociationRecord,
    ): PersistedInlineScriptAssociationValue {
        return {
            schemaVersion: PERSISTED_ASSOCIATION_SCHEMA_VERSION,
            environmentPath: association.environmentPath,
            metadataBinding:
                association.metadataBinding.kind === 'matched'
                    ? { kind: 'matched', sourceIdentity: association.metadataBinding.sourceIdentity }
                    : association.metadataBinding.kind === 'pending'
                      ? { kind: 'pending', sourceIdentity: association.metadataBinding.sourceIdentity }
                      : { kind: association.metadataBinding.kind },
        };
    }

    private enqueuePersistence(operation: (state: InlineAssociationAccessor) => Promise<void>): Promise<void> {
        return this.associationStore.runExclusive(operation);
    }

    /**
     * Deletes the entire inline-script association record through the inline-owned association
     * store's failure-isolated queue.
     *
     * The store issues a direct key update to `undefined` on the inline-owned queue rather than a
     * shared `PersistentState.clear`. A generic "Clear Cache" preserves this key and never mutates
     * it, so the two operations are key-disjoint; and because this deletion is an ordinary queued
     * write (never coalesced onto an in-flight shared clear) it cannot be silently dropped or
     * resurrected.
     */
    private clearPersistedAssociations(): Promise<void> {
        return this.associationStore.clear();
    }

    private runTtlEvictionOnce(): Promise<void> {
        if (!this.ttlEviction) {
            this.ttlEviction = this.enqueueCacheMaintenance(() =>
                this.enqueueSelection(() => this.evictStaleCacheEntries()),
            ).catch((error) => {
                this.log.warn(`Unable to evict stale inline-script environments: ${getErrorMessage(error)}`);
            });
        }
        return this.ttlEviction;
    }

    private async waitForCacheMaintenance<T>(operation: () => Promise<T>): Promise<T> {
        const barrier = this.cacheMaintenanceBarrier;
        if (barrier) {
            await barrier.promise;
        }
        return operation();
    }

    private enqueueCacheMaintenance<T>(operation: () => Promise<T>): Promise<T> {
        if (!this.cacheMaintenanceBarrier) {
            this.cacheMaintenanceBarrier = createDeferred<void>();
        }
        this.pendingCacheMaintenances += 1;
        const run = this.cacheMaintenanceQueue.then(operation);
        this.cacheMaintenanceQueue = run.then(
            () => undefined,
            () => undefined,
        );
        return run.finally(() => {
            this.pendingCacheMaintenances -= 1;
            if (this.pendingCacheMaintenances === 0) {
                this.cacheMaintenanceBarrier?.resolve();
                this.cacheMaintenanceBarrier = undefined;
            }
        });
    }

    private enqueueSelection<T>(operation: () => Promise<T>): Promise<T> {
        const run = this.selectionQueue.then(operation);
        this.selectionQueue = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    private clearAssociationsForScripts(scripts: readonly Uri[]): Promise<void> {
        return this.enqueueSelection(async () => {
            await this.persistedAssociationsLoaded;
            const changes = scripts
                .filter((uri) => uri.scheme === 'file')
                .map((uri) => ({
                    uri,
                    scriptPath: normalizePath(uri.fsPath),
                }))
                .filter(
                    (script, index, all) =>
                        all.findIndex((candidate) => candidate.scriptPath === script.scriptPath) === index,
                )
                .filter(
                    (script) =>
                        this.fsPathToEnv.has(script.scriptPath) ||
                        this.fsPathToPersistedAssociation.has(script.scriptPath),
                );

            if (changes.length === 0) {
                return;
            }

            await this.updatePersistedAssociations(changes.map(({ scriptPath }) => ({ scriptPath })));
            for (const change of changes) {
                this.bumpAssociationRevision(change.scriptPath);
                this.pendingRehydrations.delete(change.scriptPath);
                this.pendingMetadataRefreshes.delete(change.scriptPath);
                this.fsPathToEnv.delete(change.scriptPath);
                this.fsPathToPersistedAssociation.delete(change.scriptPath);
                this.clearValidatedRouteableState(change.uri);
            }
        });
    }

    private async isCacheEntryBusy(envDirPath: string): Promise<boolean> {
        if (this.pendingCreations.has(path.basename(envDirPath))) {
            return true;
        }
        try {
            await fs.lstat(getFileLockPath(envDirPath));
            return true;
        } catch (error) {
            return !isFileNotFoundError(error);
        }
    }

    private bumpAssociationRevision(scriptPath: string): void {
        this.associationRevisions.set(scriptPath, (this.associationRevisions.get(scriptPath) ?? 0) + 1);
    }

    private isCurrentAssociationRevision(scriptPath: string, revision: number): boolean {
        return (this.associationRevisions.get(scriptPath) ?? 0) === revision;
    }

    private isSameEnvironment(first: PythonEnvironment | undefined, second: PythonEnvironment | undefined): boolean {
        if (first === second) {
            return true;
        }
        if (!first || !second) {
            return false;
        }
        return (
            first.envId.managerId === second.envId.managerId &&
            normalizePath(first.environmentPath.fsPath) === normalizePath(second.environmentPath.fsPath) &&
            first.version === second.version
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
                errorCategory: installResult.kind === 'declined' ? 'compatible-python-declined' : 'install-failure',
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
            if (
                resolved &&
                executable &&
                pickCompatibleInterpreter([resolved], undefined) &&
                (!requiresPython || this.matchesInstallConstraint(requiresPython, resolved.version))
            ) {
                try {
                    const canonicalPath = await fs.realpath(executable);
                    this.directlyResolvedBaseInterpreters.set(canonicalPath, resolved);
                    selected = {
                        environment: resolved,
                        canonicalPath,
                    };
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
        const lowerBoundRelease = PythonVersion.tryParse(lowerBound);
        let needsCompleteCatalog = false;
        if (lowerBound && lowerBoundRelease?.major === 3) {
            if (/^>=\s*[^,]+$/.test(requiresPython) && this.matchesInstallConstraint(requiresPython, lowerBound)) {
                return { version: lowerBound };
            }
            // PEP 440 `==3.13` is exact, while uv treats `3.13` as a broad minor selector.
            if (/^==\s*[^,*]+$/.test(requiresPython) && this.matchesInstallConstraint(requiresPython, lowerBound)) {
                if (lowerBoundRelease.precision >= 3) {
                    return { version: lowerBound };
                }
                needsCompleteCatalog = true;
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
                    errorCategory: uvLookupResult === 'declined' ? 'compatible-python-declined' : 'install-failure',
                };
            }
            available = needsCompleteCatalog
                ? await uvPythonInstaller.getAvailablePythonVersions({ allVersions: true })
                : await uvPythonInstaller.getAvailablePythonVersions();
        } catch (error) {
            this.log.warn(`Unable to query Python versions available from uv: ${getErrorMessage(error)}`);
            return { errorCategory: 'install-failure' };
        }
        if (available.length === 0) {
            return { errorCategory: 'install-failure' };
        }
        const version = available
            .flatMap((candidate) => {
                const parsed = PythonVersion.tryParse(candidate.version);
                return parsed &&
                    candidate.implementation === 'cpython' &&
                    candidate.variant === 'default' &&
                    candidate.version_parts.major === 3 &&
                    this.matchesInstallConstraint(requiresPython, candidate.version)
                    ? [{ parsed, raw: candidate.version }]
                    : [];
            })
            .sort((left, right) => right.parsed.compareTo(left.parsed))[0]?.raw;
        return version ? { version } : { errorCategory: 'no-compatible-python' };
    }

    private matchesInstallConstraint(requiresPython: string, version: string): boolean {
        const candidate = PythonVersion.tryParse(version);
        const specifier = PythonVersionSpecifier.tryParse(requiresPython);
        if (!candidate || !specifier) {
            this.log.warn(`Unable to evaluate requires-python '${requiresPython}' against version '${version}'.`);
            return false;
        }
        return specifier.matches(candidate);
    }

    private extractPrereleaseLowerBound(requiresPython: string): string | undefined {
        return requiresPython
            .split(',')
            .map((clause) => splitClause(clause))
            .filter(
                (clause) =>
                    clause && (clause.operator === '>=' || clause.operator === '==' || clause.operator === '~='),
            )
            .map((clause) => PythonVersion.tryParse(clause?.literal))
            .find((version): version is PythonVersion => !!version && version.releaseLevel !== 'final')
            ?.toString();
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

    /**
     * Serializes cache-entry mutation across extension-host processes.
     * Every `writeMetaJson` call in this manager is either directly inside
     * this callback or reachable only through `createOrReuseEnvironment`,
     * which invokes it under this lock.
     */
    private async withCacheEntryLock<T>(envDir: Uri, action: (lock: AcquiredFileLock) => Promise<T>): Promise<T> {
        const lock = await acquireFileLock(envDir.fsPath, {
            timeoutMs: CACHE_LOCK_TIMEOUT_MS,
            retryIntervalMs: CACHE_LOCK_RETRY_MS,
        });
        try {
            return await action(lock);
        } finally {
            try {
                await lock.release();
            } catch (error) {
                this.log.warn(`Failed to release inline-script cache lock: ${getErrorMessage(error)}`);
            }
        }
    }

    private mergePendingCreationSourceMetadataIdentityHashes(
        existing: readonly string[] | undefined,
        pendingCreation: PendingCreationContext,
    ): readonly string[] | undefined {
        let merged = existing;
        for (const sourceMetadataIdentityHash of pendingCreation.sourceMetadataIdentityHashes ?? []) {
            merged = mergeSourceMetadataIdentityHashes(merged, sourceMetadataIdentityHash);
        }
        return merged;
    }

    private async mergeCacheEntrySourceMetadataIdentityHash(
        cacheKey: string,
        sourceMetadataIdentityHash: string,
    ): Promise<MergeCacheEntrySourceMetadataIdentityHashResult> {
        const envDir = getScriptEnvDir(this.globalStorageUri, cacheKey);
        try {
            return await this.withCacheEntryLock(envDir, async () => {
                const sidecarResult = await inspectMetaJson(envDir);
                if (sidecarResult.kind !== 'valid') {
                    return { success: false };
                }
                if (sidecarResult.metadata.sourceMetadataIdentityHashes?.includes(sourceMetadataIdentityHash)) {
                    return {
                        success: true,
                        sourceMetadataIdentityHashes: sidecarResult.metadata.sourceMetadataIdentityHashes,
                    };
                }
                const sourceMetadataIdentityHashes = mergeSourceMetadataIdentityHashes(
                    sidecarResult.metadata.sourceMetadataIdentityHashes,
                    sourceMetadataIdentityHash,
                );
                await writeMetaJson(envDir, {
                    ...sidecarResult.metadata,
                    ...(sourceMetadataIdentityHashes ? { sourceMetadataIdentityHashes } : {}),
                });
                return {
                    success: true,
                    sourceMetadataIdentityHashes,
                };
            });
        } catch (error) {
            this.log.warn(`Failed to update inline-script cache provenance: ${getErrorMessage(error)}`);
            return { success: false };
        }
    }

    private async createOrReuseEnvironment({
        cacheKey,
        packages,
        metadata,
        selectedBase,
        pendingCreation,
        scriptUri,
    }: CreateOrReuseEnvironmentOptions): Promise<PythonEnvironment | undefined> {
        const dependencyCount = this.getTelemetryDependencyCount(packages);
        const cacheRoot = getScriptEnvCacheRoot(this.globalStorageUri);
        const envDir = getScriptEnvDir(this.globalStorageUri, cacheKey);

        try {
            await fs.ensureDir(cacheRoot.fsPath);
            return await this.withCacheEntryLock(envDir, async (lock) => {
                const cached = await this.inspectCacheEntry(cacheRoot, envDir, metadata, selectedBase, pendingCreation);
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
                const build = await this.buildCacheEntry(
                    envDir,
                    cacheRoot,
                    packages,
                    selectedBase,
                    pendingCreation,
                    scriptUri,
                );
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
            });
        } catch (error) {
            this.sendInlineScriptEnvErrorTelemetry(this.getCreateOrReuseErrorCategory(error));
            this.log.error(`Failed to create or reuse inline-script cache entry: ${getErrorMessage(error)}`);
            return undefined;
        }
    }

    private async inspectCacheEntry(
        cacheRoot: Uri,
        envDir: Uri,
        metadata: InlineScriptMetadata,
        selectedBase: SelectedBaseInterpreter,
        pendingCreation: PendingCreationContext,
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
            if (sidecarResult.kind === 'missing') {
                sidecarResult = await restoreMetaJsonBackupUnderLock(envDir, (candidate) =>
                    this.matchesSelectedBase(candidate, selectedBase),
                );
            }
        } catch {
            return { kind: 'uncertain' };
        }
        if (sidecarResult.kind !== 'valid') {
            return {
                kind:
                    sidecarResult.kind === 'unavailable' || sidecarResult.kind === 'unsupported'
                        ? 'uncertain'
                        : 'stale',
            };
        }
        const sidecar = sidecarResult.metadata;
        if (!this.matchesSelectedBase(sidecar, selectedBase)) {
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
            'inlineScript',
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
            pendingCreation.hasStartedRecordingSourceMetadataIdentityHashes = true;
            const sourceMetadataIdentityHashes = this.mergePendingCreationSourceMetadataIdentityHashes(
                sidecar.sourceMetadataIdentityHashes,
                pendingCreation,
            );
            await writeMetaJson(envDir, {
                ...sidecar,
                lastUsedAt: new Date().toISOString(),
                ...(sourceMetadataIdentityHashes ? { sourceMetadataIdentityHashes } : {}),
            });
            pendingCreation.recordedSourceMetadataIdentityHashes = sourceMetadataIdentityHashes;
        } catch (error) {
            this.log.warn(`Failed to update inline-script cache metadata: ${getErrorMessage(error)}`);
        }
        return { kind: 'reusable', environment };
    }

    private matchesSelectedBase(sidecar: InlineScriptEnvMeta, selectedBase: SelectedBaseInterpreter): boolean {
        return (
            normalizePath(sidecar.baseInterpreterPath) === normalizePath(selectedBase.canonicalPath) &&
            this.areEqualPythonReleases(sidecar.baseInterpreterVersion, selectedBase.environment.version)
        );
    }

    private async buildCacheEntry(
        envDir: Uri,
        cacheRoot: Uri,
        packages: ReadonlyArray<string>,
        selectedBase: SelectedBaseInterpreter,
        pendingCreation: PendingCreationContext,
        scriptUri: Uri,
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
                {
                    progressTitle: l10n.t('Setting up environment for {0}', path.basename(scriptUri.fsPath)),
                    nameStyle: 'inlineScript',
                },
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
            pendingCreation.hasStartedRecordingSourceMetadataIdentityHashes = true;
            const sourceMetadataIdentityHashes = this.mergePendingCreationSourceMetadataIdentityHashes(
                undefined,
                pendingCreation,
            );
            await writeMetaJson(envDir, {
                schemaVersion: META_SCHEMA_VERSION,
                baseInterpreterPath: selectedBase.canonicalPath,
                baseInterpreterVersion: selectedBase.environment.version,
                lastUsedAt: new Date().toISOString(),
                ...(sourceMetadataIdentityHashes ? { sourceMetadataIdentityHashes } : {}),
            });
            pendingCreation.recordedSourceMetadataIdentityHashes = sourceMetadataIdentityHashes;
        } catch (error) {
            this.log.error(`Failed to record inline-script cache metadata: ${getErrorMessage(error)}`);
            await this.removeCacheEntry(envDir);
            return { errorCategory: 'setup-failure' };
        }

        return { environment: result.environment };
    }

    private async evictStaleCacheEntries(): Promise<void> {
        const cacheRoot = getScriptEnvCacheRoot(this.globalStorageUri);
        const physicalCacheRootPath = await this.getPhysicalOwnedCacheRootPath(cacheRoot);
        if (!physicalCacheRootPath) {
            return;
        }

        let entryNames: string[];
        try {
            entryNames = await fs.readdir(physicalCacheRootPath);
        } catch (error) {
            if (isFileNotFoundError(error)) {
                return;
            }
            throw error;
        }

        const now = new Date();
        const entries: CacheEntrySummary[] = [];
        for (const entryName of entryNames.sort()) {
            if (entryName.endsWith(FILE_LOCK_DIR_SUFFIX)) {
                continue;
            }
            const entryPath = path.join(physicalCacheRootPath, entryName);
            try {
                const stat = await fs.lstat(entryPath);
                if (!stat.isDirectory() || stat.isSymbolicLink()) {
                    continue;
                }
                const sidecar = await inspectMetaJson(Uri.file(entryPath));
                if (sidecar.kind === 'valid') {
                    entries.push({
                        envDirPath: entryPath,
                        lastUsedAt: new Date(sidecar.metadata.lastUsedAt),
                    });
                }
            } catch (error) {
                if (!isFileNotFoundError(error)) {
                    this.log.warn(
                        `Unable to inspect inline-script cache entry for TTL eviction ${entryPath}: ${getErrorMessage(error)}`,
                    );
                }
            }
        }

        const staleEntries = selectStaleEntries(entries, now, CACHE_TTL_MS);
        if (staleEntries.length === 0) {
            return;
        }

        const persistedAssociations = await this.getPersistedAssociationSnapshot();
        const scriptPaths = this.getTrackedScriptPaths(persistedAssociations);
        const priorSelections = this.getPriorSelections(scriptPaths);
        // Never evict an environment that a script association still points to. `lastUsedAt` is only
        // refreshed when an environment is created or reused (never when it is resolved for run, debug,
        // or Pylance), so an actively-used environment can look stale here. Reclaim only orphaned entries
        // (e.g. superseded by a dependency change, or left behind by a deleted or deselected script).
        const referencedEnvDirs = this.getReferencedCacheEntryDirs(persistedAssociations, scriptPaths);
        const evictableStaleEntries = staleEntries.filter(
            (staleEntry) => !referencedEnvDirs.has(normalizePath(staleEntry)),
        );
        if (evictableStaleEntries.length === 0) {
            return;
        }
        const removedCacheEntries = new Set<string>();
        for (const staleEntry of evictableStaleEntries) {
            try {
                const removed = await this.removeCacheEntryForClear(
                    cacheRoot,
                    physicalCacheRootPath,
                    path.basename(staleEntry),
                    {
                        reclaimRetainedLock: false,
                        afterRemove: () => {
                            this.cacheMutationRevision += 1;
                        },
                        shouldRemove: async (entryPath) => {
                            const sidecar = await inspectMetaJson(Uri.file(entryPath));
                            return (
                                sidecar.kind === 'valid' &&
                                selectStaleEntries(
                                    [
                                        {
                                            envDirPath: entryPath,
                                            lastUsedAt: new Date(sidecar.metadata.lastUsedAt),
                                        },
                                    ],
                                    now,
                                    CACHE_TTL_MS,
                                ).length === 1
                            );
                        },
                    },
                );
                if (removed) {
                    removedCacheEntries.add(normalizePath(removed));
                } else if (await this.isCacheEntryDefinitelyMissing(staleEntry)) {
                    this.cacheMutationRevision += 1;
                    removedCacheEntries.add(normalizePath(staleEntry));
                }
            } catch (error) {
                this.log.warn(
                    `Unable to evict stale inline-script cache entry ${staleEntry}: ${getErrorMessage(error)}`,
                );
                if (await this.isCacheEntryDefinitelyMissing(staleEntry)) {
                    this.cacheMutationRevision += 1;
                    removedCacheEntries.add(normalizePath(staleEntry));
                }
            }
        }

        if (removedCacheEntries.size === 0) {
            return;
        }

        this.replaceDiscoveredEnvironments(
            this.collection.filter((environment) => !removedCacheEntries.has(normalizePath(environment.sysPrefix))),
        );
        const invalidatedScriptPaths = await this.getInvalidatedAssociationPaths(
            scriptPaths,
            persistedAssociations,
            removedCacheEntries,
        );
        await this.clearInvalidatedAssociations(invalidatedScriptPaths, persistedAssociations, priorSelections);
    }

    private async isCacheEntryDefinitelyMissing(entryPath: string): Promise<boolean> {
        try {
            await fs.lstat(entryPath);
            return false;
        } catch (error) {
            if (isFileNotFoundError(error)) {
                return true;
            }
            this.log.warn(`Unable to verify stale inline-script cache entry ${entryPath}: ${getErrorMessage(error)}`);
            return false;
        }
    }

    private async clearCacheInternal(activeCreatesAtStart: number): Promise<void> {
        if (activeCreatesAtStart > 0) {
            const message = l10n.t(
                'Cannot clear the script environment cache while script environments are being created.',
            );
            this.log.error(message);
            throw new Error(message);
        }

        const cacheRoot = getScriptEnvCacheRoot(this.globalStorageUri);
        const physicalCacheRootPath = await this.getPhysicalOwnedCacheRootPath(cacheRoot);
        const persistedAssociations = await this.getPersistedAssociationSnapshot();
        const scriptPaths = this.getTrackedScriptPaths(persistedAssociations);
        const priorSelections = this.getPriorSelections(scriptPaths);

        const removedCacheEntries = new Set<string>();
        const deletionErrors: unknown[] = [];
        if (physicalCacheRootPath) {
            let entryNames: string[];
            try {
                entryNames = await fs.readdir(physicalCacheRootPath);
            } catch (error) {
                if (isFileNotFoundError(error)) {
                    entryNames = [];
                } else {
                    throw error;
                }
            }

            const cacheEntryNames = new Set<string>();
            for (const entryName of entryNames) {
                if (entryName.endsWith(FILE_LOCK_DIR_SUFFIX)) {
                    const envName = entryName.slice(0, -FILE_LOCK_DIR_SUFFIX.length);
                    if (envName.length === 0) {
                        const message = l10n.t(
                            'Refusing to clear the script environment cache because a lock entry is malformed.',
                        );
                        this.log.error(`${message} (${path.join(physicalCacheRootPath, entryName)})`);
                        throw new Error(message);
                    }
                    cacheEntryNames.add(envName);
                } else {
                    cacheEntryNames.add(entryName);
                }
            }

            for (const entryName of cacheEntryNames) {
                try {
                    const removed = await this.removeCacheEntryForClear(cacheRoot, physicalCacheRootPath, entryName);
                    if (removed) {
                        removedCacheEntries.add(normalizePath(removed));
                    }
                } catch (error) {
                    deletionErrors.push(error);
                    this.log.error(
                        `Failed to remove inline-script cache entry ${path.join(physicalCacheRootPath, entryName)}: ${getErrorMessage(error)}`,
                    );
                }
            }
        }

        const invalidatedScriptPaths = await this.getInvalidatedAssociationPaths(
            scriptPaths,
            persistedAssociations,
            removedCacheEntries,
        );
        const persistenceError = await this.clearInvalidatedAssociations(
            invalidatedScriptPaths,
            persistedAssociations,
            priorSelections,
        );
        if (persistenceError) {
            deletionErrors.push(persistenceError);
        }
        if (deletionErrors.length > 0) {
            throw new Error(
                `Failed to completely clear the inline-script environment cache: ${deletionErrors
                    .map((error) => getErrorMessage(error))
                    .join('; ')}`,
            );
        }
    }

    private async removeCacheEntryForClear(
        cacheRoot: Uri,
        originalPhysicalCacheRootPath: string,
        entryName: string,
        options: CacheEntryRemovalOptions = {},
    ): Promise<string | undefined> {
        const envDirPath = path.join(originalPhysicalCacheRootPath, entryName);
        let lock: AcquiredFileLock | undefined;
        try {
            lock = await this.acquireCacheEntryLockForClear(envDirPath, options.reclaimRetainedLock !== false);
            const currentPhysicalCacheRootPath = await this.getPhysicalOwnedCacheRootPath(cacheRoot);
            if (!currentPhysicalCacheRootPath) {
                return undefined;
            }
            if (normalizePath(currentPhysicalCacheRootPath) !== normalizePath(originalPhysicalCacheRootPath)) {
                const message = l10n.t(
                    'Refusing to clear the script environment cache because its physical root changed during cleanup.',
                );
                this.log.error(`${message} (${originalPhysicalCacheRootPath} -> ${currentPhysicalCacheRootPath})`);
                throw new Error(message);
            }

            const entryPath = await this.getClearableCacheEntryPath(
                Uri.file(currentPhysicalCacheRootPath),
                path.join(currentPhysicalCacheRootPath, entryName),
            );
            if (!entryPath) {
                return undefined;
            }
            if (options.shouldRemove && !(await options.shouldRemove(entryPath))) {
                return undefined;
            }
            await this.deleteCacheEntryForClear(entryPath);
            options.afterRemove?.();
            return entryPath;
        } finally {
            if (lock) {
                await lock.release();
            }
        }
    }

    private async acquireCacheEntryLockForClear(
        envDirPath: string,
        reclaimRetainedLock: boolean = true,
    ): Promise<AcquiredFileLock> {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                return await acquireFileLock(envDirPath, { timeoutMs: 0, retryIntervalMs: CACHE_LOCK_RETRY_MS });
            } catch (error) {
                if (!this.isLockContentionError(error)) {
                    throw error;
                }
                const lockState = await inspectFileLock(envDirPath);
                if (lockState === 'stale' || (lockState === 'retained' && reclaimRetainedLock)) {
                    await reclaimFileLock(envDirPath);
                    continue;
                }
                if (lockState === 'retained') {
                    throw error;
                }
                if (lockState === 'missing') {
                    continue;
                }
                this.throwClearCacheLockError(envDirPath, lockState);
            }
        }

        const lockState = await inspectFileLock(envDirPath);
        this.throwClearCacheLockError(envDirPath, lockState);
    }

    private isLockContentionError(error: unknown): boolean {
        const code =
            typeof error === 'object' && error !== null && 'code' in error
                ? (error as NodeJS.ErrnoException).code
                : undefined;
        return code === 'ELOCKED' || code === 'ELOCKRETAINED';
    }

    private throwClearCacheLockError(envDirPath: string, lockState: string): never {
        if (lockState === 'held') {
            const message = l10n.t(
                'Cannot clear the script environment cache while a cached environment is being created.',
            );
            this.log.error(`${message} (${getFileLockPath(envDirPath)})`);
            throw new Error(message);
        }
        if (lockState === 'unavailable') {
            const message = l10n.t(
                'Cannot clear the script environment cache because a cached environment lock could not be verified.',
            );
            this.log.error(`${message} (${getFileLockPath(envDirPath)})`);
            throw new Error(message);
        }

        const message = l10n.t(
            'Refusing to clear the script environment cache because a lock entry is incomplete or malformed.',
        );
        this.log.error(`${message} (${getFileLockPath(envDirPath)})`);
        throw new Error(message);
    }

    private async getPhysicalOwnedCacheRootPath(cacheRoot: Uri): Promise<string | undefined> {
        const globalStoragePath = path.resolve(this.globalStorageUri.fsPath);
        const cacheRootPath = path.resolve(cacheRoot.fsPath);
        if (
            path.basename(cacheRootPath) !== INLINE_SCRIPT_CACHE_DIR_NAME ||
            normalizePath(path.dirname(cacheRootPath)) !== normalizePath(globalStoragePath)
        ) {
            this.log.error(`Refusing to clear inline-script cache from unsafe root: ${cacheRootPath}`);
            throw new Error(l10n.t('Refusing to clear the script environment cache from an unsafe cache root.'));
        }
        if (isDriveRoot(globalStoragePath) || !hasMinimumPathDepth(cacheRootPath, 3)) {
            this.log.error(`Refusing to clear inline-script cache from unsafe root: ${cacheRootPath}`);
            throw new Error(l10n.t('Refusing to clear the script environment cache from an unsafe cache root.'));
        }

        let globalStorageStat;
        try {
            globalStorageStat = await fs.lstat(globalStoragePath);
        } catch (error) {
            if (isFileNotFoundError(error)) {
                return undefined;
            }
            throw error;
        }

        if (!globalStorageStat.isDirectory() || globalStorageStat.isSymbolicLink()) {
            this.log.error(
                `Refusing to clear inline-script cache from redirected globalStorage root: ${globalStoragePath}`,
            );
            throw new Error(
                l10n.t(
                    'Refusing to clear the script environment cache because the global storage root is not a normal directory.',
                ),
            );
        }

        let cacheRootStat;
        try {
            cacheRootStat = await fs.lstat(cacheRootPath);
        } catch (error) {
            if (isFileNotFoundError(error)) {
                return undefined;
            }
            throw error;
        }

        if (!cacheRootStat.isDirectory() || cacheRootStat.isSymbolicLink()) {
            this.log.error(`Refusing to clear inline-script cache from redirected cache root: ${cacheRootPath}`);
            throw new Error(
                l10n.t(
                    'Refusing to clear the script environment cache because the cache root is not a normal directory.',
                ),
            );
        }

        let resolvedGlobalStoragePath: string;
        let resolvedCacheRootPath: string;
        try {
            [resolvedGlobalStoragePath, resolvedCacheRootPath] = await Promise.all([
                fs.realpath(globalStoragePath),
                fs.realpath(cacheRootPath),
            ]);
        } catch (error) {
            if (isFileNotFoundError(error)) {
                return undefined;
            }
            this.log.error(`Failed to resolve inline-script cache root physically: ${getErrorMessage(error)}`);
            throw new Error(
                l10n.t(
                    'Refusing to clear the script environment cache because its physical location could not be verified.',
                ),
            );
        }

        const expectedResolvedCacheRootPath = path.join(resolvedGlobalStoragePath, INLINE_SCRIPT_CACHE_DIR_NAME);
        if (
            normalizePath(resolvedCacheRootPath) !== normalizePath(expectedResolvedCacheRootPath) ||
            normalizePath(path.dirname(resolvedCacheRootPath)) !== normalizePath(resolvedGlobalStoragePath)
        ) {
            this.log.error(
                `Refusing to clear inline-script cache from redirected physical root: ${resolvedCacheRootPath}`,
            );
            throw new Error(
                l10n.t('Refusing to clear the script environment cache because the cache root is redirected.'),
            );
        }
        return resolvedCacheRootPath;
    }

    private async getClearableCacheEntryPath(cacheRoot: Uri, entryPath: string): Promise<string | undefined> {
        let stat;
        try {
            stat = await fs.lstat(entryPath);
        } catch (error) {
            if (isFileNotFoundError(error)) {
                return undefined;
            }
            throw error;
        }

        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            this.log.error(`Refusing to clear inline-script cache entry from unsafe path: ${entryPath}`);
            throw new Error(
                l10n.t(
                    'Refusing to clear the script environment cache because a cache entry is not a normal directory.',
                ),
            );
        }

        const resolvedEntryPath = await resolveCacheEntryPath(cacheRoot, Uri.file(entryPath));
        if (!resolvedEntryPath) {
            this.log.error(`Refusing to clear inline-script cache entry outside the expected root: ${entryPath}`);
            throw new Error(
                l10n.t(
                    'Refusing to clear the script environment cache because a cache entry is outside the expected root.',
                ),
            );
        }

        return resolvedEntryPath;
    }

    private deleteCacheEntryForClear(entryPath: string): Promise<void> {
        return fs.remove(entryPath);
    }

    private getReferencedCacheEntryDirs(
        persistedAssociations: PersistedInlineScriptEnvironments,
        scriptPaths: ReadonlySet<string>,
    ): Set<string> {
        const referenced = new Set<string>();
        for (const scriptPath of scriptPaths) {
            const environmentPaths = [
                persistedAssociations[scriptPath]?.environmentPath,
                this.fsPathToPersistedAssociation.get(scriptPath)?.environmentPath,
                this.fsPathToEnv.get(scriptPath)?.environmentPath.fsPath,
            ].filter((value): value is string => value !== undefined);
            for (const environmentPath of environmentPaths) {
                // Mirror isRemovedOrMissingCacheAssociation: the cache-entry dir is two levels above the
                // interpreter executable (e.g. <envDir>/bin/python -> <envDir>).
                referenced.add(normalizePath(path.dirname(path.dirname(environmentPath))));
            }
        }
        return referenced;
    }

    private async getInvalidatedAssociationPaths(
        scriptPaths: ReadonlySet<string>,
        persistedAssociations: PersistedInlineScriptEnvironments,
        removedCacheEntries: ReadonlySet<string>,
    ): Promise<Set<string>> {
        const invalidatedScriptPaths = new Set<string>();
        for (const scriptPath of scriptPaths) {
            const environmentPaths = [
                persistedAssociations[scriptPath]?.environmentPath,
                this.fsPathToPersistedAssociation.get(scriptPath)?.environmentPath,
                this.fsPathToEnv.get(scriptPath)?.environmentPath.fsPath,
            ].filter((value): value is string => value !== undefined);
            const states = await Promise.all(
                environmentPaths.map((environmentPath) =>
                    this.isRemovedOrMissingCacheAssociation(environmentPath, removedCacheEntries),
                ),
            );
            if (states.some((state) => state)) {
                invalidatedScriptPaths.add(scriptPath);
            }
        }
        return invalidatedScriptPaths;
    }

    private async isRemovedOrMissingCacheAssociation(
        environmentPath: string,
        removedCacheEntries: ReadonlySet<string>,
    ): Promise<boolean> {
        const envDirPath = path.dirname(path.dirname(environmentPath));
        if (removedCacheEntries.has(normalizePath(envDirPath))) {
            return true;
        }
        try {
            return !(await fs.pathExists(environmentPath));
        } catch (error) {
            this.log.warn(
                `Unable to verify inline-script environment association ${environmentPath}: ${getErrorMessage(error)}`,
            );
            return false;
        }
    }

    private async clearInvalidatedAssociations(
        invalidatedScriptPaths: ReadonlySet<string>,
        persistedAssociations: PersistedInlineScriptEnvironments,
        priorSelections: ReadonlyMap<string, PythonEnvironment | undefined>,
    ): Promise<unknown | undefined> {
        if (invalidatedScriptPaths.size === 0) {
            if (Object.keys(persistedAssociations).length > 0) {
                return undefined;
            }
            try {
                await this.clearPersistedAssociations();
                return undefined;
            } catch (error) {
                this.log.error(`Failed to clear inline-script environment associations: ${getErrorMessage(error)}`);
                return error;
            }
        }

        let persistenceError: unknown;
        const persistedPathsToClear = Array.from(invalidatedScriptPaths).filter(
            (scriptPath) => persistedAssociations[scriptPath] !== undefined,
        );
        try {
            if (persistedPathsToClear.length === Object.keys(persistedAssociations).length) {
                await this.clearPersistedAssociations();
            } else if (persistedPathsToClear.length > 0) {
                await this.updatePersistedAssociations(
                    persistedPathsToClear.map((scriptPath) => ({
                        scriptPath,
                        expectedEnvironmentPath: persistedAssociations[scriptPath].environmentPath,
                        expectedPersistedAssociation: persistedAssociations[scriptPath],
                    })),
                );
            }
        } catch (error) {
            persistenceError = error;
            this.log.error(`Failed to clear inline-script environment associations: ${getErrorMessage(error)}`);
        }

        for (const scriptPath of invalidatedScriptPaths) {
            this.bumpAssociationRevision(scriptPath);
            this.pendingRehydrations.delete(scriptPath);
            this.pendingMetadataRefreshes.delete(scriptPath);
            this.fsPathToEnv.delete(scriptPath);
            this.fsPathToPersistedAssociation.delete(scriptPath);
            this.clearValidatedRouteableState(scriptPath);

            const environment = priorSelections.get(scriptPath);
            if (environment) {
                this._onDidChangeEnvironment.fire({
                    uri: Uri.file(scriptPath),
                    old: environment,
                    new: undefined,
                });
            }
        }
        return persistenceError;
    }

    private async getPersistedAssociationSnapshot(): Promise<PersistedInlineScriptEnvironments> {
        return this.parsePersistedAssociations(await this.associationStore.read<unknown>())?.records ?? {};
    }

    private getTrackedScriptPaths(persistedAssociations: PersistedInlineScriptEnvironments): Set<string> {
        return new Set([
            ...Object.keys(persistedAssociations),
            ...this.associationRevisions.keys(),
            ...this.cachedAssociationValidatedAt.keys(),
            ...this.lastValidatedMetadataIdentities.keys(),
            ...this.lastValidatedMetadataIdentityProofs.keys(),
            ...this.fsPathToEnv.keys(),
            ...this.fsPathToPersistedAssociation.keys(),
            ...this.pendingRehydrations.keys(),
            ...this.pendingMetadataRefreshes.keys(),
        ]);
    }

    private getPriorSelections(scriptPaths: ReadonlySet<string>): Map<string, PythonEnvironment | undefined> {
        return new Map(Array.from(scriptPaths, (scriptPath) => [scriptPath, this.fsPathToEnv.get(scriptPath)]));
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
        const actualVersion = PythonVersion.tryParse(actual);
        const expectedVersion = PythonVersion.tryParse(expected);
        return !!actualVersion && !!expectedVersion && actualVersion.compareTo(expectedVersion) === 0;
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
        this.disposed = true;
        this.stopActivationDiscovery();
        this.pendingMetadataRefreshes.clear();
        this.subscriptions.forEach((subscription) => subscription.dispose());
        this._onDidChangeEnvironments.dispose();
        this._onDidChangeEnvironment.dispose();
    }

    private applyPersistedAssociations(associations: PersistedInlineScriptEnvironments): void {
        const nextPaths = new Set(Object.keys(associations));
        for (const scriptPath of this.fsPathToPersistedAssociation.keys()) {
            if (!nextPaths.has(scriptPath)) {
                this.fsPathToPersistedAssociation.delete(scriptPath);
                this.clearValidatedRouteableState(scriptPath);
            }
        }
        for (const [scriptPath, association] of Object.entries(associations)) {
            this.fsPathToPersistedAssociation.set(scriptPath, association);
        }
    }
}

type PersistedInlineScriptEnvironments = Record<string, PersistedAssociationRecord>;
type PersistedInlineScriptAssociationValue = string | PersistedInlineScriptAssociationObject;

type PersistedMetadataBinding =
    | { readonly kind: 'legacy' }
    | { readonly kind: 'pending'; readonly sourceIdentity: string }
    | { readonly kind: 'matched'; readonly sourceIdentity: string };

interface PersistedInlineScriptAssociationObject {
    readonly schemaVersion: typeof PERSISTED_ASSOCIATION_SCHEMA_VERSION;
    readonly environmentPath: string;
    readonly metadataBinding: PersistedMetadataBinding;
}

interface PersistedAssociationRecord {
    readonly environmentPath: string;
    readonly metadataBinding: PersistedMetadataBinding;
}

interface PersistedAssociationChange {
    readonly scriptPath: string;
    readonly persistedAssociation?: PersistedAssociationRecord;
    readonly expectedPersistedAssociation?: PersistedAssociationRecord;
    readonly expectedEnvironmentPath?: string;
}

interface ScriptReference {
    readonly uri: Uri;
    readonly scriptPath: string;
}

interface PendingScriptUpdate extends ScriptReference {
    readonly before: PythonEnvironment | undefined;
    readonly persistedAssociation?: PersistedAssociationRecord;
    readonly needsPersistence: boolean;
    readonly shouldNotify: boolean;
}

type DiscoveredCacheEntryResult =
    | { readonly kind: 'preserve' | 'skip'; readonly fingerprint?: string }
    | {
          readonly kind: 'resolved';
          readonly environment: PythonEnvironment;
          readonly fingerprint: string;
      };
