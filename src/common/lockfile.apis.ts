// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as crypto from 'crypto';
import * as fsapi from 'fs-extra';
import * as path from 'path';

/** Acquire an atomic lock released only explicitly; interrupted operations remain locked. */
export async function acquireFileLock(filePath: string, options: AcquireFileLockOptions): Promise<AcquiredFileLock> {
    const lockPath = `${path.resolve(filePath)}.lock`;
    const ownerMarker = path.join(lockPath, `owner-${process.pid}-${crypto.randomBytes(16).toString('hex')}`);
    const retainedMarker = path.join(lockPath, 'retained');
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
                        if (isAlreadyExistsError(error)) {
                            return;
                        }
                        try {
                            await fsapi.rename(ownerMarker, retainedMarker);
                        } catch (renameError) {
                            if (!isAlreadyExistsError(renameError)) {
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
                        if (isFileNotFoundError(error)) {
                            throw createLockError('Lock ownership was compromised', 'ECOMPROMISED', lockPath);
                        }
                        throw error;
                    }
                    await fsapi.rmdir(lockPath);
                },
            };
        } catch (error) {
            if (!isAlreadyExistsError(error)) {
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

function isAlreadyExistsError(error: unknown): boolean {
    return hasErrorCode(error, 'EEXIST');
}

function isFileNotFoundError(error: unknown): boolean {
    return hasErrorCode(error, 'ENOENT');
}

async function isRetainedLock(lockPath: string): Promise<boolean> {
    try {
        await fsapi.lstat(path.join(lockPath, 'retained'));
        return true;
    } catch (error) {
        if (isFileNotFoundError(error)) {
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

function createLockError(message: string, code: string, lockPath: string): NodeJS.ErrnoException {
    return Object.assign(new Error(message), { code, path: lockPath });
}

async function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface AcquireFileLockOptions {
    readonly timeoutMs: number;
    readonly retryIntervalMs: number;
}

export interface AcquiredFileLock {
    readonly release: () => Promise<void>;
    /** Keep the lock and make later acquisition attempts fail immediately. */
    readonly retain: () => Promise<void>;
}

type LockState = 'held' | 'released' | 'retained';
