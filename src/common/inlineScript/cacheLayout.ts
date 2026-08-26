// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as crypto from 'crypto';
import * as fsapi from 'fs-extra';
import * as path from 'path';
import { Uri } from 'vscode';
import type { PythonEnvironment } from '../../api';
import { INLINE_SCRIPT_MANAGER_ID } from '../constants';
import { traceWarn } from '../logging';
import { isFileNotFoundError } from '../utils/filesystem';
import { normalizePath } from '../utils/pathUtils';
import { isWindows } from '../utils/platformUtils';
import { getVenvPythonPath } from '../utils/virtualEnvironment';

/** Bump this and {@link META_SCHEMA_VERSION} together for incompatible cache formats. */
export const INLINE_SCRIPT_CACHE_DIR_NAME = 'script-envs-v1';

export const META_JSON_FILENAME = '.meta.json';

/**
 * Schema version embedded in every {@link InlineScriptEnvMeta}.
 */
export const META_SCHEMA_VERSION = 1 as const;
export const SOURCE_METADATA_IDENTITY_HASH_HEX_LENGTH = 64;
export const MAX_SOURCE_METADATA_IDENTITY_HASHES = 128;

const MAX_META_JSON_BYTES = 1024 * 1024;
const META_JSON_BACKUP_FILENAME_RE = /^\.meta\.json\.backup-[0-9a-f]{12}$/;
const pendingMetaJsonWrites = new Map<string, Promise<void>>();

/**
 * Validated on-disk schema for a cached inline-script environment's
 * `.meta.json` sidecar.
 */
export interface InlineScriptEnvMeta {
    /** Version of the serialized metadata schema. */
    readonly schemaVersion: typeof META_SCHEMA_VERSION;
    /** Canonical base-interpreter path. */
    readonly baseInterpreterPath: string;
    /** Base-interpreter version. */
    readonly baseInterpreterVersion: string;
    /** Last successful use as a canonical UTC string produced by `Date.toISOString()`. */
    readonly lastUsedAt: string;
    /** Bounded SHA-256 hashes of metadata identities proven for this cache entry. */
    readonly sourceMetadataIdentityHashes?: readonly string[];
}

export type InlineScriptMetaReadResult =
    | { readonly kind: 'valid'; readonly metadata: InlineScriptEnvMeta }
    | { readonly kind: 'missing' | 'invalid' | 'unsupported' | 'unavailable' };

export type BaseInterpreterStatus = 'available' | 'missing' | 'unavailable';
export type CacheEnvironmentInspection = 'expected' | 'stale' | 'uncertain';

/**
 * In-memory summary of one cached entry, populated by the separate disk walk.
 */
export interface CacheEntrySummary {
    /** Filesystem path of the cached environment directory. */
    readonly envDirPath: string;
    /** Parsed last-use time, or `undefined` when no valid timestamp is available. */
    readonly lastUsedAt: Date | undefined;
}

export function getScriptEnvCacheRoot(globalStorageUri: Uri): Uri {
    return Uri.joinPath(globalStorageUri, INLINE_SCRIPT_CACHE_DIR_NAME);
}

export function getScriptEnvDir(globalStorageUri: Uri, cacheKey: string): Uri {
    return Uri.joinPath(getScriptEnvCacheRoot(globalStorageUri), cacheKey);
}

export function getMetaJsonPath(envDir: Uri): Uri {
    return Uri.joinPath(envDir, META_JSON_FILENAME);
}

/** Resolve a cache entry only when it is the requested direct child of the physical cache root. */
export async function resolveCacheEntryPath(cacheRoot: Uri, envDir: Uri): Promise<string | undefined> {
    const [resolvedRoot, resolvedEntry] = await Promise.all([
        fsapi.realpath(cacheRoot.fsPath),
        fsapi.realpath(envDir.fsPath),
    ]);
    const expectedEntry = path.join(resolvedRoot, path.basename(envDir.fsPath));
    return isDescendantPath(resolvedRoot, resolvedEntry) &&
        normalizePath(path.resolve(resolvedEntry)) === normalizePath(path.resolve(expectedEntry))
        ? resolvedEntry
        : undefined;
}

/** Verify that a resolved environment is owned by the expected physical cache entry. */
export async function inspectOwnedCacheEntry(
    environment: PythonEnvironment,
    cacheRoot: Uri,
    envDir: Uri,
): Promise<CacheEnvironmentInspection> {
    if (environment.envId.managerId !== INLINE_SCRIPT_MANAGER_ID) {
        return 'uncertain';
    }
    try {
        const [expectedDir, resolvedPrefix, expectedPython, resolvedPython] = await Promise.all([
            resolveCacheEntryPath(cacheRoot, envDir),
            fsapi.realpath(environment.sysPrefix),
            fsapi.realpath(getVenvPythonPath(envDir.fsPath)),
            fsapi.realpath(environment.environmentPath.fsPath),
        ]);
        if (!expectedDir) {
            return 'uncertain';
        }
        return normalizePath(expectedDir) === normalizePath(resolvedPrefix) &&
            normalizePath(expectedPython) === normalizePath(resolvedPython)
            ? 'expected'
            : 'stale';
    } catch (error) {
        traceWarn('inline-script env: failed to inspect cache-entry ownership:', error);
        return 'uncertain';
    }
}

/** Read validated sidecar metadata, returning `undefined` for non-valid state. */
export async function readMetaJson(envDir: Uri): Promise<InlineScriptEnvMeta | undefined> {
    const result = await inspectMetaJson(envDir);
    return result.kind === 'valid' ? result.metadata : undefined;
}

/** Classify sidecar state; only `unavailable` denotes transient I/O. */
export async function inspectMetaJson(envDir: Uri): Promise<InlineScriptMetaReadResult> {
    return inspectMetaJsonFile(getMetaJsonPath(envDir).fsPath);
}

/**
 * Restore the most recently-used compatible sidecar backup while the caller
 * owns the cache-entry lock. General readers must use {@link inspectMetaJson}.
 */
export async function restoreMetaJsonBackupUnderLock(
    envDir: Uri,
    isCompatible: (metadata: InlineScriptEnvMeta) => boolean = () => true,
): Promise<InlineScriptMetaReadResult> {
    const finalPath = getMetaJsonPath(envDir).fsPath;
    const initial = await inspectMetaJsonFile(finalPath);
    if (initial.kind !== 'missing') {
        return initial;
    }

    let entries: string[];
    try {
        entries = await fsapi.readdir(envDir.fsPath);
    } catch (error) {
        traceWarn(`inline-script meta: failed to scan backup sidecars in ${envDir.fsPath}:`, error);
        return { kind: 'unavailable' };
    }

    const validBackups: Array<{ readonly path: string; readonly metadata: InlineScriptEnvMeta }> = [];
    for (const entry of entries.filter((name) => META_JSON_BACKUP_FILENAME_RE.test(name))) {
        const result = await inspectMetaJsonFile(path.join(envDir.fsPath, entry));
        if (result.kind === 'valid' && isCompatible(result.metadata)) {
            validBackups.push({ path: path.join(envDir.fsPath, entry), metadata: result.metadata });
        } else if (result.kind === 'unavailable' || result.kind === 'missing') {
            // A listed candidate changing or becoming unreadable is an
            // uncertain scan; preserve the entry rather than rebuilding it.
            return { kind: 'unavailable' };
        }
    }

    if (validBackups.length === 0) {
        return { kind: 'missing' };
    }

    // `lastUsedAt` is schema-validated canonical ISO text. Prefer the newest
    // compatible backup; use the path as a stable tie-breaker.
    validBackups.sort((a, b) => {
        if (a.metadata.lastUsedAt !== b.metadata.lastUsedAt) {
            return a.metadata.lastUsedAt < b.metadata.lastUsedAt ? 1 : -1;
        }
        return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    const selected = validBackups[0];

    // Native rename may replace an existing destination on some platforms,
    // so recheck under the caller's entry lock before restoring.
    const current = await inspectMetaJsonFile(finalPath);
    if (current.kind !== 'missing') {
        return current;
    }
    try {
        await fsapi.rename(selected.path, finalPath);
    } catch (error) {
        traceWarn(`inline-script meta: failed to restore backup ${selected.path}:`, error);
        return { kind: 'unavailable' };
    }
    return { kind: 'valid', metadata: selected.metadata };
}

async function inspectMetaJsonFile(metaPath: string): Promise<InlineScriptMetaReadResult> {
    try {
        const stat = await fsapi.lstat(metaPath);
        if (!stat.isFile()) {
            traceWarn(`inline-script meta: not a regular file at ${metaPath}`);
            return { kind: 'invalid' };
        }
        if (stat.size > MAX_META_JSON_BYTES) {
            traceWarn(`inline-script meta: refusing to read ${metaPath} (${stat.size} bytes > cap)`);
            return { kind: 'invalid' };
        }
    } catch (err) {
        if (isFileNotFoundError(err)) {
            traceWarn(`inline-script meta: not found at ${metaPath}`);
            return { kind: 'missing' };
        } else {
            const code = (err as NodeJS.ErrnoException | undefined)?.code ?? 'unknown';
            traceWarn(`inline-script meta: failed to stat ${metaPath} (code=${code}):`, err);
            return { kind: 'unavailable' };
        }
    }

    let raw: string;
    try {
        raw = await fsapi.readFile(metaPath, 'utf8');
    } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code ?? 'unknown';
        traceWarn(`inline-script meta: failed to read ${metaPath} (code=${code}):`, err);
        return { kind: isFileNotFoundError(err) ? 'missing' : 'unavailable' };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        traceWarn(`inline-script meta: malformed JSON in ${metaPath}:`, err);
        return { kind: 'invalid' };
    }

    const validated = validateMeta(parsed);
    if (validated === 'unsupported') {
        traceWarn(`inline-script meta: unsupported schema in ${metaPath}`);
        return { kind: 'unsupported' };
    }
    if (!validated) {
        traceWarn(`inline-script meta: invalid shape in ${metaPath}`);
        return { kind: 'invalid' };
    }
    return { kind: 'valid', metadata: validated };
}

/**
 * Queue writes for a single sidecar in this process. Production callers also
 * hold the cache-entry file lock, which serializes this operation across
 * extension-host processes.
 */
export function writeMetaJson(envDir: Uri, meta: InlineScriptEnvMeta): Promise<void> {
    const finalPath = getMetaJsonPath(envDir).fsPath;
    const key = normalizePath(path.resolve(finalPath));
    const previous = pendingMetaJsonWrites.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => writeMetaJsonOnce(envDir, meta, finalPath));
    let queued: Promise<void>;
    queued = operation.finally(() => {
        if (pendingMetaJsonWrites.get(key) === queued) {
            pendingMetaJsonWrites.delete(key);
        }
    });
    pendingMetaJsonWrites.set(key, queued);
    return queued;
}

async function writeMetaJsonOnce(envDir: Uri, meta: InlineScriptEnvMeta, finalPath: string): Promise<void> {
    await fsapi.ensureDir(envDir.fsPath);
    const tmpSuffix = crypto.randomBytes(6).toString('hex');
    const tmpPath = `${finalPath}.tmp-${tmpSuffix}`;
    const backupPath = `${finalPath}.backup-${tmpSuffix}`;
    const payload = JSON.stringify(meta, undefined, 2);
    let hasBackup = false;
    let finalKnownToExist = false;

    try {
        await fsapi.writeFile(tmpPath, payload, 'utf8');
        try {
            await fsapi.rename(tmpPath, finalPath);
            finalKnownToExist = true;
            return;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException | undefined)?.code;
            if (!['EPERM', 'EEXIST', 'EBUSY'].includes(code ?? '')) {
                throw err;
            }
        }

        try {
            await fsapi.rename(finalPath, backupPath);
            hasBackup = true;
        } catch (err) {
            if (!isFileNotFoundError(err)) {
                throw err;
            }
        }

        try {
            await fsapi.rename(tmpPath, finalPath);
            finalKnownToExist = true;
        } catch (replaceError) {
            if (hasBackup) {
                try {
                    await fsapi.rename(backupPath, finalPath);
                    finalKnownToExist = true;
                } catch {
                    // Keep the backup: it is the only known copy when
                    // restoration cannot prove the final sidecar exists.
                }
            }
            throw replaceError;
        }
    } finally {
        await fsapi.remove(tmpPath).catch(() => undefined);
        if (hasBackup && finalKnownToExist) {
            await fsapi.remove(backupPath).catch(() => undefined);
        }
    }
}

export function hashSourceMetadataIdentity(identity: string): string {
    return crypto.createHash('sha256').update(identity, 'utf8').digest('hex');
}

export function mergeSourceMetadataIdentityHashes(
    existing: readonly string[] | undefined,
    current: string | undefined,
): readonly string[] | undefined {
    const ordered = [...(existing ?? [])];
    if (current && !ordered.includes(current)) {
        ordered.push(current);
    }
    if (ordered.length === 0) {
        return undefined;
    }
    return Object.freeze(ordered.slice(-MAX_SOURCE_METADATA_IDENTITY_HASHES));
}

/**
 * Pure selector: returns the env-dir paths whose age exceeds `ttlMs`.
 */
export function selectStaleEntries(entries: ReadonlyArray<CacheEntrySummary>, now: Date, ttlMs: number): string[] {
    const stale: string[] = [];
    const nowMs = now.getTime();
    for (const entry of entries) {
        if (entry.lastUsedAt === undefined) {
            continue;
        }
        const ageMs = nowMs - entry.lastUsedAt.getTime();
        if (ageMs > ttlMs) {
            stale.push(entry.envDirPath);
        }
    }
    return stale;
}

/**
 * Verify that a cached env's launcher and base interpreter still exist on disk.
 */
export async function verifyBaseInterpreterExists(envDir: Uri): Promise<boolean> {
    return (await getBaseInterpreterStatus(envDir)) === 'available';
}

/** Classify the base interpreter; `unavailable` denotes transient I/O. */
export async function getBaseInterpreterStatus(envDir: Uri): Promise<BaseInterpreterStatus> {
    return isWindows() ? getWindowsBaseInterpreterStatus(envDir) : getPosixBaseInterpreterStatus(envDir);
}

async function getPosixBaseInterpreterStatus(envDir: Uri): Promise<BaseInterpreterStatus> {
    const launcherPath = Uri.joinPath(envDir, 'bin', 'python').fsPath;
    return getRegularFileStatus(launcherPath, 'base interpreter');
}

async function getWindowsBaseInterpreterStatus(envDir: Uri): Promise<BaseInterpreterStatus> {
    const launcherStatus = await getRegularFileStatus(getVenvPythonPath(envDir.fsPath), 'cached interpreter launcher');
    if (launcherStatus !== 'available') {
        return launcherStatus;
    }

    const pyvenvPath = Uri.joinPath(envDir, 'pyvenv.cfg').fsPath;
    let raw: string;
    try {
        raw = await fsapi.readFile(pyvenvPath, 'utf8');
    } catch (err) {
        if (isFileNotFoundError(err)) {
            traceWarn(`inline-script env: missing pyvenv.cfg at ${pyvenvPath}`);
            return 'missing';
        } else {
            const code = (err as NodeJS.ErrnoException | undefined)?.code ?? 'unknown';
            traceWarn(`inline-script env: failed to read ${pyvenvPath} (code=${code}):`, err);
            return 'unavailable';
        }
    }
    const home = parsePyvenvHome(raw);
    if (home === undefined) {
        traceWarn(`inline-script env: no 'home =' line in ${pyvenvPath}`);
        return 'missing';
    }
    const launcherPath = path.join(home, 'python.exe');
    return getRegularFileStatus(launcherPath, 'base interpreter');
}

async function getRegularFileStatus(filePath: string, label: string): Promise<BaseInterpreterStatus> {
    try {
        const stat = await fsapi.stat(filePath);
        if (!stat.isFile()) {
            traceWarn(`inline-script env: ${label} is not a regular file at ${filePath}`);
            return 'missing';
        }
        return 'available';
    } catch (err) {
        if (isFileNotFoundError(err)) {
            traceWarn(`inline-script env: ${label} missing at ${filePath}`);
            return 'missing';
        } else {
            const code = (err as NodeJS.ErrnoException | undefined)?.code ?? 'unknown';
            traceWarn(`inline-script env: failed to stat ${filePath} (code=${code}):`, err);
            return 'unavailable';
        }
    }
}

function parsePyvenvHome(raw: string): string | undefined {
    for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^\s*home\s*=\s*(.+?)\s*$/);
        if (m) {
            return m[1];
        }
    }
    return undefined;
}

function isDescendantPath(rootPath: string, candidatePath: string): boolean {
    const relative = path.relative(rootPath, candidatePath);
    return (
        relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    );
}

function isNonEmptyTrimmedString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function validateMeta(value: unknown): InlineScriptEnvMeta | 'unsupported' | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined;
    }
    const obj = value as Record<string, unknown>;
    if (
        typeof obj.schemaVersion !== 'number' ||
        !Number.isSafeInteger(obj.schemaVersion) ||
        obj.schemaVersion <= 0
    ) {
        return undefined;
    }
    if (obj.schemaVersion > META_SCHEMA_VERSION) {
        return 'unsupported';
    }
    if (obj.schemaVersion !== META_SCHEMA_VERSION) {
        return undefined;
    }
    if (!isNonEmptyTrimmedString(obj.baseInterpreterPath) || !path.isAbsolute(obj.baseInterpreterPath)) {
        return undefined;
    }
    if (!isNonEmptyTrimmedString(obj.baseInterpreterVersion)) {
        return undefined;
    }
    if (!isCanonicalIsoTimestamp(obj.lastUsedAt)) {
        return undefined;
    }
    const sourceMetadataIdentityHashes = validateSourceMetadataIdentityHashes(obj.sourceMetadataIdentityHashes);
    if (obj.sourceMetadataIdentityHashes !== undefined && sourceMetadataIdentityHashes === undefined) {
        return undefined;
    }

    return {
        schemaVersion: META_SCHEMA_VERSION,
        baseInterpreterPath: obj.baseInterpreterPath,
        baseInterpreterVersion: obj.baseInterpreterVersion,
        lastUsedAt: obj.lastUsedAt,
        ...(sourceMetadataIdentityHashes ? { sourceMetadataIdentityHashes } : {}),
    };
}

function validateSourceMetadataIdentityHashes(value: unknown): readonly string[] | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SOURCE_METADATA_IDENTITY_HASHES) {
        return undefined;
    }
    const hashes: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        if (
            typeof item !== 'string' ||
            item.length !== SOURCE_METADATA_IDENTITY_HASH_HEX_LENGTH ||
            !/^[0-9a-f]+$/.test(item) ||
            seen.has(item)
        ) {
            return undefined;
        }
        seen.add(item);
        hashes.push(item);
    }
    return Object.freeze(hashes);
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
    if (typeof value !== 'string') {
        return false;
    }
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) {
        return false;
    }
    return new Date(ms).toISOString() === value;
}
