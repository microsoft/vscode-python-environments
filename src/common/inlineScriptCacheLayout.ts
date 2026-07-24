// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as crypto from 'crypto';
import * as fsapi from 'fs-extra';
import * as path from 'path';
import { Uri } from 'vscode';
import type { PythonEnvironment } from '../api';
import { INLINE_SCRIPT_MANAGER_ID } from './constants';
import { traceWarn } from './logging';
import { normalizePath } from './utils/pathUtils';
import { isWindows } from './utils/platformUtils';
import { getVenvPythonPath } from './utils/virtualEnvironment';

/** Bump this and {@link META_SCHEMA_VERSION} together for incompatible cache formats. */
export const INLINE_SCRIPT_CACHE_DIR_NAME = 'script-envs-v1';

export const META_JSON_FILENAME = '.meta.json';

/**
 * Schema version embedded in every {@link InlineScriptEnvMeta}.
 */
export const META_SCHEMA_VERSION = 1 as const;

const MAX_META_JSON_BYTES = 1024 * 1024;

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
}

export type InlineScriptMetaReadResult =
    | { readonly kind: 'valid'; readonly metadata: InlineScriptEnvMeta }
    | { readonly kind: 'missing' | 'invalid' | 'unavailable' };

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
    const metaPath = getMetaJsonPath(envDir).fsPath;

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
    if (!validated) {
        traceWarn(`inline-script meta: invalid shape in ${metaPath}`);
        return { kind: 'invalid' };
    }
    return { kind: 'valid', metadata: validated };
}

/**
 * Atomically write the `.meta.json` sidecar via temp-file + rename.
 */
export async function writeMetaJson(envDir: Uri, meta: InlineScriptEnvMeta): Promise<void> {
    await fsapi.ensureDir(envDir.fsPath);
    const finalPath = getMetaJsonPath(envDir).fsPath;
    const tmpSuffix = crypto.randomBytes(6).toString('hex');
    const tmpPath = `${finalPath}.tmp-${tmpSuffix}`;
    const payload = JSON.stringify(meta, undefined, 2);
    try {
        await fsapi.writeFile(tmpPath, payload, 'utf8');
        await fsapi.rename(tmpPath, finalPath);
    } catch (err) {
        await fsapi.remove(tmpPath).catch(() => undefined);
        throw err;
    }
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
 * Verify that a cached env's base interpreter still exists on disk.
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

function isFileNotFoundError(err: unknown): boolean {
    return typeof err === 'object' && err !== null && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function isDescendantPath(rootPath: string, candidatePath: string): boolean {
    const relative = path.relative(rootPath, candidatePath);
    return (
        relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    );
}

function validateMeta(value: unknown): InlineScriptEnvMeta | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined;
    }
    const obj = value as Record<string, unknown>;
    if (obj.schemaVersion !== META_SCHEMA_VERSION) {
        return undefined;
    }
    if (
        typeof obj.baseInterpreterPath !== 'string' ||
        obj.baseInterpreterPath.length === 0 ||
        obj.baseInterpreterPath.trim() !== obj.baseInterpreterPath ||
        !path.isAbsolute(obj.baseInterpreterPath)
    ) {
        return undefined;
    }
    if (
        typeof obj.baseInterpreterVersion !== 'string' ||
        obj.baseInterpreterVersion.trim().length === 0 ||
        obj.baseInterpreterVersion.trim() !== obj.baseInterpreterVersion
    ) {
        return undefined;
    }
    if (!isCanonicalIsoTimestamp(obj.lastUsedAt)) {
        return undefined;
    }

    return {
        schemaVersion: META_SCHEMA_VERSION,
        baseInterpreterPath: obj.baseInterpreterPath,
        baseInterpreterVersion: obj.baseInterpreterVersion,
        lastUsedAt: obj.lastUsedAt,
    };
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
