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
    const retainedMarker = path.join(lockPath, FILE_LOCK_RETAINED_MARKER);
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
                        await fsapi.writeFile(retainedMarker, '', { flag: 'wx' });
                    } catch (error) {
                        if (hasErrorCode(error, 'EEXIST')) {
                            return;
                        }
                        try {
                            await fsapi.rename(ownerMarker, retainedMarker);
                        } catch (renameError) {
                            if (!hasErrorCode(renameError, 'EEXIST')) {
                                throw createLockError(
                                    'Failed to mark the lock as retained',
                                    'ERETAINFAILED',
                                    lockPath,
                                );
                            }
                        }
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
    const lockPath = getFileLockPath(filePath);

    let stat;
    try {
        stat = await fsapi.lstat(lockPath);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
            return 'missing';
        }
        throw error;
    }

    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return 'malformed';
    }

    const entries = await fsapi.readdir(lockPath);
    const ownerEntries = entries.filter((entry) => entry.startsWith(FILE_LOCK_OWNER_MARKER_PREFIX));
    const retainedEntries = entries.filter((entry) => entry === FILE_LOCK_RETAINED_MARKER);
    const unknownEntries = entries.filter(
        (entry) => !entry.startsWith(FILE_LOCK_OWNER_MARKER_PREFIX) && entry !== FILE_LOCK_RETAINED_MARKER,
    );

    if (unknownEntries.length > 0 || ownerEntries.length > 1 || retainedEntries.length > 1) {
        return 'malformed';
    }
    if (retainedEntries.length === 1) {
        return 'retained';
    }
    if (ownerEntries.length === 1) {
        const ownerPid = parseOwnerPid(ownerEntries[0]);
        if (ownerPid === undefined) {
            return 'malformed';
        }
        const liveness = await (options?.checkProcessLiveness ?? getProcessLiveness)(ownerPid);
        if (liveness === 'dead') {
            return 'stale';
        }
        return liveness === 'live' ? 'held' : 'unavailable';
    }
    return 'orphaned';
}

/**
 * Move a stale or retained lock out of the lock name before a replacement owner is acquired.
 * The rename prevents a newly-created lock from being removed based on an earlier inspection.
 */
export async function reclaimFileLock(filePath: string): Promise<boolean> {
    const lockPath = getFileLockPath(filePath);
    const state = await inspectFileLock(filePath);
    if (state !== 'stale' && state !== 'retained') {
        return false;
    }

    const quarantinedLockPath = `${lockPath}.reclaimed-${process.pid}-${crypto.randomBytes(16).toString('hex')}`;
    try {
        await fsapi.rename(lockPath, quarantinedLockPath);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
            return false;
        }
        throw error;
    }

    await fsapi.remove(quarantinedLockPath);
    return true;
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
        await fsapi.lstat(path.join(lockPath, FILE_LOCK_RETAINED_MARKER));
        return true;
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

function parseOwnerPid(entry: string): number | undefined {
    const match = entry.match(new RegExp(`^${escapeRegExp(FILE_LOCK_OWNER_MARKER_PREFIX)}(\\d+)-`));
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
