// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as crypto from 'crypto';
import * as fsapi from 'fs-extra';
import * as path from 'path';
import { Uri } from 'vscode';
import { traceWarn } from './logging';
import { isWindows } from './utils/platformUtils';

/**
 * Versioned name of the cache root under the extension's `globalStorageUri`.
 *
 * Bump the `-v1` suffix together with {@link META_SCHEMA_VERSION} on any
 * incompatible on-disk change, so old envs sit unread and TTL out naturally
 * instead of being migrated in place.
 */
export const INLINE_SCRIPT_CACHE_DIR_NAME = 'script-envs-v1';

export const META_JSON_FILENAME = '.meta.json';

/**
 * Schema version embedded in every {@link InlineScriptEnvMeta}.
 */
export const META_SCHEMA_VERSION = 1 as const;
export interface InlineScriptEnvMeta {
    readonly schemaVersion: typeof META_SCHEMA_VERSION;
    readonly scriptFsPath: string;
    readonly lastUsedAt: string;
    readonly requiresPython?: string;
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

const MAX_META_JSON_BYTES = 1024 * 1024;

export async function readMetaJson(envDir: Uri): Promise<InlineScriptEnvMeta | undefined> {
    const metaPath = getMetaJsonPath(envDir).fsPath;

    try {
        const stat = await fsapi.stat(metaPath);
        if (!stat.isFile()) {
            traceWarn(`inline-script meta: not a regular file at ${metaPath}`);
            return undefined;
        }
        if (stat.size > MAX_META_JSON_BYTES) {
            traceWarn(`inline-script meta: refusing to read ${metaPath} (${stat.size} bytes > cap)`);
            return undefined;
        }
    } catch (err) {
        if (isFileNotFoundError(err)) {
            traceWarn(`inline-script meta: not found at ${metaPath}`);
        } else {
            const code = (err as NodeJS.ErrnoException | undefined)?.code ?? 'unknown';
            traceWarn(`inline-script meta: failed to stat ${metaPath} (code=${code}):`, err);
        }
        return undefined;
    }

    let raw: string;
    try {
        raw = await fsapi.readFile(metaPath, 'utf8');
    } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code ?? 'unknown';
        traceWarn(`inline-script meta: failed to read ${metaPath} (code=${code}):`, err);
        return undefined;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        traceWarn(`inline-script meta: malformed JSON in ${metaPath}:`, err);
        return undefined;
    }

    const validated = validateMeta(parsed);
    if (!validated) {
        traceWarn(`inline-script meta: invalid shape in ${metaPath}`);
        return undefined;
    }
    return validated;
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
 * Snapshot of one cached entry, populated by the (separate, I/O-doing) disk
 * walk.
 */
export interface CacheEntrySummary {
    readonly envDirPath: string;
    readonly lastUsedAt: Date | undefined;
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
export async function verifyEnvUsable(envDir: Uri): Promise<boolean> {
    if (isWindows()) {
        return verifyWindowsBaseInterpreter(envDir);
    }
    return verifyPosixBaseInterpreter(envDir);
}

async function verifyPosixBaseInterpreter(envDir: Uri): Promise<boolean> {
    const launcherPath = Uri.joinPath(envDir, 'bin', 'python').fsPath;
    return statRegularFile(launcherPath, 'base interpreter');
}

async function verifyWindowsBaseInterpreter(envDir: Uri): Promise<boolean> {
    const pyvenvPath = Uri.joinPath(envDir, 'pyvenv.cfg').fsPath;
    let raw: string;
    try {
        raw = await fsapi.readFile(pyvenvPath, 'utf8');
    } catch (err) {
        if (isFileNotFoundError(err)) {
            traceWarn(`inline-script env: missing pyvenv.cfg at ${pyvenvPath}`);
        } else {
            const code = (err as NodeJS.ErrnoException | undefined)?.code ?? 'unknown';
            traceWarn(`inline-script env: failed to read ${pyvenvPath} (code=${code}):`, err);
        }
        return false;
    }
    const home = parsePyvenvHome(raw);
    if (home === undefined) {
        traceWarn(`inline-script env: no 'home =' line in ${pyvenvPath}`);
        return false;
    }
    const launcherPath = path.join(home, 'python.exe');
    return statRegularFile(launcherPath, 'base interpreter');
}

async function statRegularFile(filePath: string, label: string): Promise<boolean> {
    try {
        const stat = await fsapi.stat(filePath);
        if (!stat.isFile()) {
            traceWarn(`inline-script env: ${label} is not a regular file at ${filePath}`);
            return false;
        }
        return true;
    } catch (err) {
        if (isFileNotFoundError(err)) {
            traceWarn(`inline-script env: ${label} missing at ${filePath}`);
        } else {
            const code = (err as NodeJS.ErrnoException | undefined)?.code ?? 'unknown';
            traceWarn(`inline-script env: failed to stat ${filePath} (code=${code}):`, err);
        }
        return false;
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

function validateMeta(value: unknown): InlineScriptEnvMeta | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined;
    }
    const obj = value as Record<string, unknown>;
    if (obj.schemaVersion !== META_SCHEMA_VERSION) {
        return undefined;
    }
    if (typeof obj.scriptFsPath !== 'string' || obj.scriptFsPath.length === 0) {
        return undefined;
    }
    if (!isCanonicalIsoTimestamp(obj.lastUsedAt)) {
        return undefined;
    }
    if (obj.requiresPython !== undefined && typeof obj.requiresPython !== 'string') {
        return undefined;
    }

    return {
        schemaVersion: META_SCHEMA_VERSION,
        scriptFsPath: obj.scriptFsPath,
        lastUsedAt: obj.lastUsedAt,
        requiresPython: obj.requiresPython,
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
