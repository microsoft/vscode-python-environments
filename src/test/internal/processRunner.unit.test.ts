// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as cp from 'child_process';
import * as sinon from 'sinon';
import { CancellationError, CancellationTokenSource } from 'vscode';
import * as childProcesses from '../../common/childProcess.apis';
import { createDeferred } from '../../common/utils/deferred';
import * as platformUtils from '../../common/utils/platformUtils';
import {
    PROCESS_TERMINATION_TIMEOUT_MS,
    ProcessTerminationError,
    ProcessTimeoutError,
    runLoggedProcess,
} from '../../common/utils/processRunner';
import { MockChildProcess } from '../mocks/mockChildProcess';

suite('Python tool process ownership', () => {
    let source: CancellationTokenSource;

    setup(() => {
        source = new CancellationTokenSource();
    });
    teardown(() => {
        source.dispose();
        sinon.restore();
    });

    test('does not spawn when already cancelled', async () => {
        const spawn = sinon.stub(childProcesses, 'spawnProcess');
        source.cancel();
        await assert.rejects(runLoggedProcess('python', [], {}, undefined, source.token), CancellationError);
        assert.ok(spawn.notCalled);
    });

    test('distinguishes timeout and disposes the cancellation subscription on completion', async () => {
        const clock = sinon.useFakeTimers();
        const process = new MockChildProcess('python', []);
        const kill = sinon.stub(process, 'kill').callsFake(() => {
            process.emit('exit', null, 'SIGTERM');
            process.emit('close', null, 'SIGTERM');
            return true;
        });
        const spawn: sinon.SinonStub = sinon.stub(childProcesses, 'spawnProcess');
        spawn.returns(process);
        const pending = assert.rejects(
            runLoggedProcess('python', [], {}, undefined, source.token, 50),
            ProcessTimeoutError,
        );
        await clock.tickAsync(51);
        await pending;
        source.cancel();
        assert.ok(kill.calledOnce);
    });

    test('reports failed termination explicitly instead of claiming cancellation completed', async () => {
        const process = new MockChildProcess('python', []);
        sinon.stub(process, 'kill').returns(false);
        const spawn: sinon.SinonStub = sinon.stub(childProcesses, 'spawnProcess');
        spawn.returns(process);
        const pending = runLoggedProcess('python', [], {}, undefined, source.token);
        source.cancel();
        await assert.rejects(
            pending,
            (error: unknown) =>
                error instanceof ProcessTerminationError && error.operationError instanceof CancellationError,
        );
    });

    test('does not signal a reused Windows pid or claim its descendants were cleaned up', async () => {
        sinon.stub(platformUtils, 'isWindows').returns(true);
        const process = new MockChildProcess('python', []);
        Object.defineProperty(process, 'pid', { value: 1234 });
        Object.defineProperty(process, 'exitCode', { value: 0 });
        const kill = sinon.stub(process, 'kill').returns(true);
        const spawn: sinon.SinonStub = sinon.stub(childProcesses, 'spawnProcess');
        spawn.returns(process);
        const pending = runLoggedProcess('python', [], {}, undefined, source.token);
        let completed = false;
        void pending.then(
            () => {
                completed = true;
            },
            () => {
                completed = true;
            },
        );
        source.cancel();
        await Promise.resolve();
        assert.strictEqual(completed, false);
        process.emit('close', 0, null);
        await assert.rejects(
            pending,
            (error: unknown) =>
                error instanceof ProcessTerminationError &&
                error.operationError instanceof CancellationError &&
                error.cause instanceof Error &&
                error.cause.message.includes('child-process cleanup cannot be confirmed'),
        );
        assert.ok(spawn.calledOnce);
        assert.ok(kill.notCalled);
    });

    test('does not treat an externally signalled process as successful', async () => {
        const process = new MockChildProcess('python', []);
        const spawn: sinon.SinonStub = sinon.stub(childProcesses, 'spawnProcess');
        spawn.returns(process);
        const pending = runLoggedProcess('python', [], {});
        process.emit('exit', null, 'SIGTERM');
        process.emit('close', null, 'SIGTERM');
        await assert.rejects(pending, /SIGTERM/);
    });

    test('failed Windows tree termination stays a cleanup failure after the parent exits and closes', async () => {
        sinon.stub(platformUtils, 'isWindows').returns(true);
        const child = new MockChildProcess('python', []);
        Object.defineProperty(child, 'pid', { value: 1234 });
        const killer = new MockChildProcess('taskkill.exe', []);
        const spawn: sinon.SinonStub = sinon.stub(childProcesses, 'spawnProcess');
        spawn.onFirstCall().returns(child);
        spawn.onSecondCall().returns(killer);
        const pending = runLoggedProcess('python', [], {}, undefined, source.token);
        const rejected = assert.rejects(
            pending,
            (error: unknown) =>
                error instanceof ProcessTerminationError &&
                error.operationError instanceof CancellationError &&
                error.cause instanceof Error &&
                error.cause.message.includes('taskkill exit 1'),
        );
        source.cancel();
        Object.defineProperty(child, 'exitCode', { value: 0 });
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
        killer.emit('close', 1, null);
        await rejected;
        assert.ok(spawn.secondCall.calledWith('taskkill.exe', ['/PID', '1234', '/T', '/F']));
    });

    test('a nonzero exited parent retaining pipes keeps its timeout and reports bounded cleanup failure', async () => {
        const clock = sinon.useFakeTimers();
        sinon.stub(platformUtils, 'isWindows').returns(true);
        const process = new MockChildProcess('python', []);
        Object.defineProperty(process, 'pid', { value: 1234 });
        const spawn: sinon.SinonStub = sinon.stub(childProcesses, 'spawnProcess');
        spawn.returns(process);
        const pending = runLoggedProcess('python', [], {}, undefined, source.token, 50);
        const rejected = assert.rejects(
            pending,
            (error: unknown) =>
                error instanceof ProcessTerminationError && error.operationError instanceof ProcessTimeoutError,
        );
        Object.defineProperty(process, 'exitCode', { value: 1 });
        process.emit('exit', 1, null);
        await clock.tickAsync(50 + PROCESS_TERMINATION_TIMEOUT_MS + 1);
        await rejected;
        assert.ok(spawn.calledOnce, 'Do not issue taskkill for an exited, potentially reused parent PID');
    });

    test('POSIX cancellation waits for close and owned group disappearance even after its leader exits', async () => {
        const clock = sinon.useFakeTimers();
        sinon.stub(platformUtils, 'isWindows').returns(false);
        const child = new MockChildProcess('python', []);
        Object.defineProperty(child, 'pid', { value: 1234 });
        Object.defineProperty(child, 'exitCode', { value: 0 });
        const spawn: sinon.SinonStub = sinon.stub(childProcesses, 'spawnProcess');
        spawn.returns(child);
        let groupAlive = true;
        const signal = sinon.stub(process, 'kill').callsFake((_pid, value) => {
            if (value === 0 && !groupAlive) {
                throw Object.assign(new Error('No such process group'), { code: 'ESRCH' });
            }
            return true;
        });
        const pending = runLoggedProcess('python', [], {}, undefined, source.token);
        let completed = false;
        void pending.then(
            () => {
                completed = true;
            },
            () => {
                completed = true;
            },
        );
        source.cancel();
        await clock.tickAsync(1);
        assert.ok(signal.calledWithExactly(-1234, 'SIGKILL'));
        assert.strictEqual(completed, false);
        child.emit('close', 0, null);
        await clock.tickAsync(25);
        assert.strictEqual(completed, false, 'Closed pipes alone do not prove the owned group has exited');
        groupAlive = false;
        await clock.tickAsync(25);
        await assert.rejects(pending, CancellationError);
        assert.ok(signal.calledWithExactly(-1234, 0));
    });

    test('stops a real owned subprocess before reporting cancellation', async function () {
        this.timeout(15_000);
        const spawned = createDeferred<cp.ChildProcess>();
        sinon.stub(childProcesses, 'spawnProcess').callsFake((executable, args, options) => {
            const child = cp.spawn(executable, args, options ?? {});
            if (executable === process.execPath) {
                child.on('spawn', () => spawned.resolve(child));
                child.on('error', (error) => spawned.reject(error));
            }
            return child;
        });
        const pending = runLoggedProcess(
            process.execPath,
            ['-e', 'setInterval(() => {}, 1000)'],
            {},
            undefined,
            source.token,
        );
        const child = await spawned.promise;
        let closed = false;
        child.on('close', () => {
            closed = true;
        });
        try {
            source.cancel();
            await assert.rejects(pending, CancellationError);
            assert.ok(closed, 'Cancellation must not resolve before the real close event');
            assert.ok(child.exitCode !== null || child.signalCode !== null);
        } finally {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
            }
        }
    });

    (process.platform === 'win32' ? test.skip : test)(
        'real POSIX exited parent with a live child retaining pipes cannot report an early successful cleanup',
        async function () {
            this.timeout(20_000);
            const parentExited = createDeferred<void>();
            const descendantPid = createDeferred<number>();
            let parent: cp.ChildProcess | undefined;
            let closed = false;
            sinon.stub(childProcesses, 'spawnProcess').callsFake((executable, args, options) => {
                const child = cp.spawn(executable, args, options ?? {});
                if (executable === process.execPath) {
                    parent = child;
                    let output = '';
                    child.stdout?.on('data', (data) => {
                        output += data.toString();
                        const match = /CHILD:(\d+)/.exec(output);
                        if (match) {
                            descendantPid.resolve(Number(match[1]));
                        }
                    });
                    child.on('exit', () => parentExited.resolve());
                    child.on('close', () => {
                        closed = true;
                    });
                }
                return child;
            });
            const script = [
                "const child = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],",
                "{ stdio: ['ignore', process.stdout, process.stderr] });",
                "child.on('spawn', () => { child.unref(); process.stdout.write('CHILD:' + child.pid + '\\n', () => process.exit(1)); });",
            ].join('\n');
            const pending = runLoggedProcess(process.execPath, ['-e', script], {}, undefined, source.token);
            let pid: number | undefined;
            try {
                pid = await descendantPid.promise;
                await parentExited.promise;
                assert.strictEqual(closed, false, 'The child must still own the inherited output pipes');
                source.cancel();
                await assert.rejects(pending, CancellationError);
                assert.strictEqual(closed, true);
            } finally {
                if (pid) {
                    try {
                        process.kill(pid, 'SIGKILL');
                    } catch (error) {
                        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
                            throw error;
                        }
                    }
                }
                if (parent && !closed) {
                    await new Promise<void>((resolve) => parent!.once('close', () => resolve()));
                }
            }
        },
    );
});
