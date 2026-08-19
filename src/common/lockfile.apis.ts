// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as crypto from 'crypto';
import * as fsapi from 'fs-extra';
import * as path from 'path';

export interface AcquireFileLockOptions {
    readonly timeoutMs: number;
    readonly retryIntervalMs: number;
}

export interface AcquiredFileLock {
    readonly release: () => Promise<void>;
    /** Keep the lock and make later acquisition attempts fail immediately. */
    readonly retain: () => Promise<void>;
}

export const FILE_LOCK_DIR_SUFFIX = '.lock';
export const FILE_LOCK_OWNER_MARKER_PREFIX = 'owner-';
export const FILE_LOCK_RETAINED_MARKER_PREFIX = 'retained-';
/** Legacy retained marker. It remains recognizable but cannot be safely reclaimed. */
export const FILE_LOCK_RETAINED_MARKER = 'retained';

export type ProcessLiveness = 'live' | 'dead' | 'unavailable';
export type FileLockState = 'missing' | 'held' | 'retained' | 'stale' | 'orphaned' | 'malformed' | 'unavailable';

export interface InspectFileLockOptions {
    readonly checkProcessLiveness?: (pid: number) => Promise<ProcessLiveness>;
}

type LockState = 'held' | 'released' | 'retained';

export function getFileLockPath(filePath: string): string {
    return `${path.resolve(filePath)}${FILE_LOCK_DIR_SUFFIX}`;
}

/** Acquire an atomic lock released only explicitly; interrupted operations remain locked. */
export async function acquireFileLock(filePath: string, options: AcquireFileLockOptions): Promise<AcquiredFileLock> {
    const lockPath = getFileLockPath(filePath);
    const ownerMarker = path.join(
        lockPath,
        `${FILE_LOCK_OWNER_MARKER_PREFIX}${process.pid}-${crypto.randomBytes(16).toString('hex')}`,
    );
    const retainedMarker = path.join(lockPath, getRetainedMarkerName(path.basename(ownerMarker)));
    const deadline = Date.now() + options.timeoutMs;

    while (true) {
        try {
            await fsapi.mkdir(lockPath);
            try {
                await fsapi.writeFile(ownerMarker, '', { flag: 'wx' });
            } catch (error) {
                try {
                    await fsapi.rmdir(lockPath);
                } catch {
                    throw createLockError(
                        'Lock initialization failed and left an owner-less lock directory',
                        'ELOCKORPHANED',
                        lockPath,
                    );
                }
                throw error;
            }

            let state: LockState = 'held';
            return {
                retain: async () => {
                    if (state !== 'held') {
                        return;
                    }
                    state = 'retained';
                    try {
                        await fsapi.rename(ownerMarker, retainedMarker);
                    } catch (_error) {
                        throw createLockError('Failed to mark the lock as retained', 'ERETAINFAILED', lockPath);
                    }
                },
                release: async () => {
                    if (state !== 'held') {
                        return;
                    }
                    state = 'released';
                    try {
                        await fsapi.unlink(ownerMarker);
                    } catch (error) {
                        if (hasErrorCode(error, 'ENOENT')) {
                            throw createLockError('Lock ownership was compromised', 'ECOMPROMISED', lockPath);
                        }
                        throw error;
                    }
                    await fsapi.rmdir(lockPath);
                },
            };
        } catch (error) {
            if (!hasErrorCode(error, 'EEXIST')) {
                throw error;
            }
            if (await isRetainedLock(lockPath)) {
                throw createLockError('Lock was retained after an interrupted operation', 'ELOCKRETAINED', lockPath);
            }
            if (Date.now() >= deadline) {
                throw createLockError('Lock is already being held', 'ELOCKED', lockPath);
            }
            await delay(Math.min(options.retryIntervalMs, Math.max(0, deadline - Date.now())));
        }
    }
}

export async function inspectFileLock(filePath: string, options?: InspectFileLockOptions): Promise<FileLockState> {
    return (await inspectFileLockSnapshot(filePath, options)).state;
}

interface FileLockSnapshot {
    readonly state: FileLockState;
    readonly marker?: string;
    readonly markerKind?: 'owner' | 'retained';
}

async function inspectFileLockSnapshot(
    filePath: string,
    options?: InspectFileLockOptions,
): Promise<FileLockSnapshot> {
    const lockPath = getFileLockPath(filePath);

    let stat;
    try {
        stat = await fsapi.lstat(lockPath);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
            return { state: 'missing' };
        }
        throw error;
    }

    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return { state: 'malformed' };
    }

    const entries = await fsapi.readdir(lockPath);
    const ownerEntries = entries.filter((entry) => entry.startsWith(FILE_LOCK_OWNER_MARKER_PREFIX));
    const generationRetainedEntries = entries.filter((entry) => entry.startsWith(FILE_LOCK_RETAINED_MARKER_PREFIX));
    const retainedEntries = entries.filter((entry) => entry === FILE_LOCK_RETAINED_MARKER);
    const unknownEntries = entries.filter(
        (entry) =>
            !entry.startsWith(FILE_LOCK_OWNER_MARKER_PREFIX) &&
            !entry.startsWith(FILE_LOCK_RETAINED_MARKER_PREFIX) &&
            entry !== FILE_LOCK_RETAINED_MARKER,
    );

    if (
        unknownEntries.length > 0 ||
        ownerEntries.length > 1 ||
        generationRetainedEntries.length > 1 ||
        retainedEntries.length > 1 ||
        generationRetainedEntries.length + retainedEntries.length > 1 ||
        generationRetainedEntries.length + ownerEntries.length > 1
    ) {
        return { state: 'malformed' };
    }
    if (retainedEntries.length === 1) {
        return { state: 'retained' };
    }
    if (generationRetainedEntries.length === 1) {
        const retainedPid = parseMarkerPid(generationRetainedEntries[0], FILE_LOCK_RETAINED_MARKER_PREFIX);
        if (retainedPid === undefined) {
            return { state: 'malformed' };
        }
        return { state: 'retained', marker: generationRetainedEntries[0], markerKind: 'retained' };
    }
    if (ownerEntries.length === 1) {
        const ownerPid = parseMarkerPid(ownerEntries[0], FILE_LOCK_OWNER_MARKER_PREFIX);
        if (ownerPid === undefined) {
            return { state: 'malformed' };
        }
        const liveness = await (options?.checkProcessLiveness ?? getProcessLiveness)(ownerPid);
        if (liveness === 'dead') {
            return { state: 'stale', marker: ownerEntries[0], markerKind: 'owner' };
        }
        return { state: liveness === 'live' ? 'held' : 'unavailable', marker: ownerEntries[0], markerKind: 'owner' };
    }
    return { state: 'orphaned' };
}

/**
 * Claim and remove the exact observed stale or retained generation without releasing the lock directory.
 */
export async function reclaimFileLock(filePath: string, options?: InspectFileLockOptions): Promise<boolean> {
    const lockPath = getFileLockPath(filePath);
    const snapshot = await inspectFileLockSnapshot(filePath, options);
    if (
        (snapshot.state !== 'stale' && snapshot.state !== 'retained') ||
        !snapshot.marker ||
        !snapshot.markerKind
    ) {
        return false;
    }

    const claimedMarker = path.join(
        lockPath,
        `.reclaim-${process.pid}-${crypto.randomBytes(16).toString('hex')}-${snapshot.marker}`,
    );
    try {
        await fsapi.rename(path.join(lockPath, snapshot.marker), claimedMarker);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'EEXIST')) {
            return false;
        }
        throw error;
    }

    try {
        await fsapi.unlink(claimedMarker);
        await fsapi.rmdir(lockPath);
        return true;
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTEMPTY')) {
            return false;
        }
        throw error;
    }
}

export async function getProcessLiveness(pid: number): Promise<ProcessLiveness> {
    try {
        process.kill(pid, 0);
        return 'live';
    } catch (error) {
        if (hasErrorCode(error, 'ESRCH')) {
            return 'dead';
        }
        if (hasErrorCode(error, 'EPERM') || hasErrorCode(error, 'EACCES')) {
            return 'unavailable';
        }
        return 'unavailable';
    }
}

async function isRetainedLock(lockPath: string): Promise<boolean> {
    try {
        const entries = await fsapi.readdir(lockPath);
        return entries.some(
            (entry) => entry === FILE_LOCK_RETAINED_MARKER || entry.startsWith(FILE_LOCK_RETAINED_MARKER_PREFIX),
        );
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
            return false;
        }
        throw error;
    }
}

function hasErrorCode(error: unknown, code: string): boolean {
    return (
        typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === code
    );
}

function getRetainedMarkerName(ownerMarker: string): string {
    return `${FILE_LOCK_RETAINED_MARKER_PREFIX}${ownerMarker.slice(FILE_LOCK_OWNER_MARKER_PREFIX.length)}`;
}

function parseMarkerPid(entry: string, prefix: string): number | undefined {
    const match = entry.match(new RegExp(`^${escapeRegExp(prefix)}(\\d+)-.+$`));
    if (!match) {
        return undefined;
    }
    const pid = Number(match[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createLockError(message: string, code: string, lockPath: string): NodeJS.ErrnoException {
    return Object.assign(new Error(message), { code, path: lockPath });
}

async function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
