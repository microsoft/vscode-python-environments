// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import fsExtra from 'fs-extra';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import {
    acquireFileLock,
    AcquireFileLockOptions,
    FILE_LOCK_OWNER_MARKER_PREFIX,
    FILE_LOCK_RETAINED_MARKER,
    FILE_LOCK_RETAINED_MARKER_PREFIX,
    getFileLockPath,
    inspectFileLock,
    reclaimFileLock,
} from '../../common/lockfile.apis';

const OPTIONS: AcquireFileLockOptions = {
    timeoutMs: 40,
    retryIntervalMs: 5,
};

const LOCK_MODULE_PATH = path.resolve(__dirname, '..', '..', 'common', 'lockfile.apis.js');

suite('lockfile APIs', () => {
    let tempRoot: string;
    let targetPath: string;

    setup(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'python-envs-lock-'));
        targetPath = path.join(tempRoot, 'cache-entry');
    });

    teardown(async () => {
        sinon.restore();
        await fs.remove(tempRoot);
    });

    function startLockingChild(exitWithoutRelease: boolean): ChildProcessWithoutNullStreams {
        const script = `
            const { acquireFileLock } = require(process.argv[1]);
            acquireFileLock(process.argv[2], { timeoutMs: 1000, retryIntervalMs: 10 })
                .then((lock) => {
                    process.stdout.write('locked\\n');
                    if (${exitWithoutRelease}) {
                        process.exit(0);
                    }
                    process.stdin.once('data', async () => {
                        await lock.release();
                        process.exit(0);
                    });
                })
                .catch((error) => {
                    process.stderr.write(String(error && error.stack ? error.stack : error));
                    process.exit(1);
                });
        `;
        return spawn(process.execPath, ['-e', script, LOCK_MODULE_PATH, targetPath]);
    }

    async function waitForLocked(child: ChildProcessWithoutNullStreams): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (data) => {
                stdout += data.toString();
                if (stdout.includes('locked')) {
                    resolve();
                }
            });
            child.stderr.on('data', (data) => {
                stderr += data.toString();
            });
            child.once('error', reject);
            child.once('exit', (code) => {
                if (!stdout.includes('locked')) {
                    reject(new Error(`locking child exited with code ${code}: ${stderr}`));
                }
            });
        });
    }

    async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
        if (child.exitCode !== null) {
            assert.strictEqual(child.exitCode, 0);
            return;
        }
        await new Promise<void>((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`locking child exited with code ${code}`));
                }
            });
        });
    }

    test('excludes a second owner until the first releases the lock', async () => {
        const lock = await acquireFileLock(targetPath, OPTIONS);
        await assert.rejects(acquireFileLock(targetPath, OPTIONS), (error: NodeJS.ErrnoException) => {
            return error.code === 'ELOCKED';
        });

        await lock.release();
        const lockAfterRetry = await acquireFileLock(targetPath, OPTIONS);
        await lockAfterRetry.release();
        assert.strictEqual(await fs.pathExists(`${path.resolve(targetPath)}.lock`), false);
    });

    test('excludes another process until the owner explicitly releases', async () => {
        const child = startLockingChild(false);
        await waitForLocked(child);

        await assert.rejects(acquireFileLock(targetPath, OPTIONS), (error: NodeJS.ErrnoException) => {
            return error.code === 'ELOCKED';
        });

        child.stdin.write('release\n');
        await waitForExit(child);
        const lock = await acquireFileLock(targetPath, OPTIONS);
        await lock.release();
    });

    test('leaves the lock fail-closed when the owner process exits without release', async () => {
        const child = startLockingChild(true);
        await waitForLocked(child);
        await waitForExit(child);

        await assert.rejects(acquireFileLock(targetPath, OPTIONS), (error: NodeJS.ErrnoException) => {
            return error.code === 'ELOCKED';
        });
        assert.strictEqual(await fs.pathExists(`${path.resolve(targetPath)}.lock`), true);
    });

    test('an old release cannot remove a successor lock generation', async () => {
        const lock = await acquireFileLock(targetPath, OPTIONS);
        const lockPath = `${path.resolve(targetPath)}.lock`;
        await fs.remove(lockPath);
        await fs.ensureDir(lockPath);
        const successorMarker = path.join(lockPath, 'successor-owner');
        await fs.writeFile(successorMarker, '');

        await assert.rejects(lock.release(), (error: NodeJS.ErrnoException) => {
            return error.code === 'ECOMPROMISED';
        });
        assert.strictEqual(await fs.pathExists(successorMarker), true);
    });

    test('release is idempotent', async () => {
        const lock = await acquireFileLock(targetPath, OPTIONS);

        await lock.release();
        await lock.release();

        assert.strictEqual(await fs.pathExists(`${path.resolve(targetPath)}.lock`), false);
    });

    test('retained locks fail fast without waiting for the acquisition timeout', async () => {
        const lock = await acquireFileLock(targetPath, OPTIONS);
        await lock.retain();
        const startedAt = Date.now();

        await assert.rejects(
            acquireFileLock(targetPath, { timeoutMs: 10_000, retryIntervalMs: 1_000 }),
            (error: NodeJS.ErrnoException) => error.code === 'ELOCKRETAINED',
        );

        assert.ok(Date.now() - startedAt < 1_000);
        const lockPath = `${path.resolve(targetPath)}.lock`;
        const retainedEntries = await fs.readdir(lockPath);
        assert.strictEqual(retainedEntries.length, 1);
        assert.ok(retainedEntries[0].startsWith(`${FILE_LOCK_RETAINED_MARKER_PREFIX}${process.pid}-`));

        await lock.release();
        assert.deepStrictEqual(await fs.readdir(lockPath), retainedEntries);
    });

    test('atomically converts the owner marker into a generation-specific retained marker', async () => {
        const lock = await acquireFileLock(targetPath, OPTIONS);

        await lock.retain();

        const lockPath = `${path.resolve(targetPath)}.lock`;
        const entries = await fs.readdir(lockPath);
        assert.strictEqual(entries.length, 1);
        assert.ok(entries[0].startsWith(`${FILE_LOCK_RETAINED_MARKER_PREFIX}${process.pid}-`));
        await assert.rejects(acquireFileLock(targetPath, OPTIONS), (error: NodeJS.ErrnoException) => {
            return error.code === 'ELOCKRETAINED';
        });
    });

    test('remains fail-closed when retaining the generation marker fails', async () => {
        const lock = await acquireFileLock(targetPath, OPTIONS);
        sinon.stub(fsExtra, 'rename').rejects(Object.assign(new Error('rename failed'), { code: 'EBUSY' }));

        await assert.rejects(lock.retain(), (error: NodeJS.ErrnoException) => error.code === 'ERETAINFAILED');
        await lock.release();

        const lockPath = `${path.resolve(targetPath)}.lock`;
        const lockEntries = await fs.readdir(lockPath);
        assert.strictEqual(lockEntries.filter((entry) => entry.startsWith('owner-')).length, 1);
        await assert.rejects(acquireFileLock(targetPath, OPTIONS), (error: NodeJS.ErrnoException) => {
            return error.code === 'ELOCKED';
        });
    });

    test('reports an owner-less lock when initialization cleanup fails', async () => {
        sinon.stub(fsExtra, 'writeFile').rejects(Object.assign(new Error('write failed'), { code: 'EIO' }));
        sinon.stub(fsExtra, 'rmdir').rejects(Object.assign(new Error('cleanup failed'), { code: 'EACCES' }));

        await assert.rejects(acquireFileLock(targetPath, OPTIONS), (error: NodeJS.ErrnoException) => {
            return error.code === 'ELOCKORPHANED' && error.path === `${path.resolve(targetPath)}.lock`;
        });
    });

    test('classifies a live owner marker as held using the liveness probe', async () => {
        const lockPath = getFileLockPath(targetPath);
        await fs.ensureDir(lockPath);
        await fs.writeFile(path.join(lockPath, `${FILE_LOCK_OWNER_MARKER_PREFIX}${process.pid}-live`), '');
        const checkProcessLiveness = sinon.stub().resolves('live');

        assert.strictEqual(await inspectFileLock(targetPath, { checkProcessLiveness }), 'held');
        sinon.assert.calledOnceWithExactly(checkProcessLiveness, process.pid);
    });

    test('classifies a retained lock after retain()', async () => {
        const lock = await acquireFileLock(targetPath, OPTIONS);
        await lock.retain();

        assert.strictEqual(await inspectFileLock(targetPath), 'retained');
    });

    test('reclaims a generation-specific retained lock', async () => {
        const lock = await acquireFileLock(targetPath, OPTIONS);
        await lock.retain();

        assert.strictEqual(await reclaimFileLock(targetPath), true);
        assert.strictEqual(await inspectFileLock(targetPath), 'missing');
        const replacement = await acquireFileLock(targetPath, OPTIONS);
        await replacement.release();
    });

    test('refuses to reclaim the ambiguous legacy retained marker', async () => {
        const lockPath = getFileLockPath(targetPath);
        await fs.ensureDir(lockPath);
        await fs.writeFile(path.join(lockPath, `${FILE_LOCK_OWNER_MARKER_PREFIX}${process.pid}-legacy`), '');
        await fs.writeFile(path.join(lockPath, FILE_LOCK_RETAINED_MARKER), '');

        assert.strictEqual(await inspectFileLock(targetPath), 'retained');
        assert.strictEqual(await reclaimFileLock(targetPath), false);
        assert.strictEqual(await fs.pathExists(path.join(lockPath, FILE_LOCK_RETAINED_MARKER)), true);
        await assert.rejects(acquireFileLock(targetPath, OPTIONS), (error: NodeJS.ErrnoException) => {
            return error.code === 'ELOCKRETAINED';
        });
    });

    test('does not touch a new generation when a delayed reclaimer loses its marker claim', async () => {
        const lockPath = getFileLockPath(targetPath);
        const staleMarker = `${FILE_LOCK_OWNER_MARKER_PREFIX}424242-dead`;
        await fs.ensureDir(targetPath);
        await fs.ensureDir(lockPath);
        await fs.writeFile(path.join(lockPath, staleMarker), '');
        const rename = fsExtra.rename;
        let releaseFirstClaim: (() => void) | undefined;
        let firstClaimStarted: (() => void) | undefined;
        const firstClaim = new Promise<void>((resolve) => {
            firstClaimStarted = resolve;
        });
        const releaseClaim = new Promise<void>((resolve) => {
            releaseFirstClaim = resolve;
        });
        let renameCount = 0;
        sinon.stub(fsExtra, 'rename').callsFake(async (source, destination) => {
            renameCount += 1;
            if (renameCount === 1) {
                firstClaimStarted!();
                await releaseClaim;
            }
            await rename(source, destination);
        });

        const staleInspection = { checkProcessLiveness: sinon.stub().resolves('dead') };
        const delayedReclaimer = reclaimFileLock(targetPath, staleInspection);
        await firstClaim;
        assert.strictEqual(await reclaimFileLock(targetPath, staleInspection), true);
        const replacement = await acquireFileLock(targetPath, OPTIONS);
        const replacementEntries = await fs.readdir(lockPath);

        releaseFirstClaim!();
        assert.strictEqual(await delayedReclaimer, false);
        assert.deepStrictEqual(await fs.readdir(lockPath), replacementEntries);
        assert.strictEqual(await fs.pathExists(targetPath), true);

        await replacement.release();
    });

    test('classifies a dead owner marker as stale using the liveness probe', async () => {
        const lockPath = getFileLockPath(targetPath);
        await fs.ensureDir(lockPath);
        await fs.writeFile(path.join(lockPath, `${FILE_LOCK_OWNER_MARKER_PREFIX}424242-dead`), '');
        const checkProcessLiveness = sinon.stub().resolves('dead');

        assert.strictEqual(await inspectFileLock(targetPath, { checkProcessLiveness }), 'stale');
        sinon.assert.calledOnceWithExactly(checkProcessLiveness, 424242);
    });

    test('classifies an unavailable owner probe conservatively', async () => {
        const lockPath = getFileLockPath(targetPath);
        await fs.ensureDir(lockPath);
        await fs.writeFile(path.join(lockPath, `${FILE_LOCK_OWNER_MARKER_PREFIX}${process.pid}-busy`), '');
        const checkProcessLiveness = sinon.stub().resolves('unavailable');

        assert.strictEqual(await inspectFileLock(targetPath, { checkProcessLiveness }), 'unavailable');
        sinon.assert.calledOnceWithExactly(checkProcessLiveness, process.pid);
    });

    test('classifies an owner-less lock directory as orphaned', async () => {
        await fs.ensureDir(getFileLockPath(targetPath));

        assert.strictEqual(await inspectFileLock(targetPath), 'orphaned');
    });

    test('classifies a malformed owner marker as malformed', async () => {
        const lockPath = getFileLockPath(targetPath);
        await fs.ensureDir(lockPath);
        await fs.writeFile(path.join(lockPath, `${FILE_LOCK_OWNER_MARKER_PREFIX}not-a-pid-live`), '');

        assert.strictEqual(await inspectFileLock(targetPath), 'malformed');
    });

    test('classifies a lock directory with unexpected entries as malformed', async () => {
        const lockPath = getFileLockPath(targetPath);
        await fs.ensureDir(lockPath);
        await fs.writeFile(path.join(lockPath, 'unexpected.txt'), '');

        assert.strictEqual(await inspectFileLock(targetPath), 'malformed');
    });
});
