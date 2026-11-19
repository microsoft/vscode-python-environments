// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import { ChildProcess, ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import * as sinon from 'sinon';
import { PassThrough } from 'stream';
import { CancellationError, CancellationToken, CancellationTokenSource, Disposable } from 'vscode';
import * as childProcessApis from '../../common/childProcess.apis';
import { InstallerProcessError, runInstallerProcess } from '../../common/installerProcess';
import * as logging from '../../common/logging';

suite('installerProcess', () => {
    const executable = path.join(process.cwd(), 'installer fixtures', 'pymanager.exe');
    let child: ChildProcessWithoutNullStreams & { stdin: PassThrough };
    let spawn: sinon.SinonStub;
    let kill: sinon.SinonStub;
    let clock: sinon.SinonFakeTimers;
    let tokens: CancellationTokenSource[];

    setup(() => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        child = Object.assign(new ChildProcess(), {
            stdin,
            stdout,
            stderr,
            stdio: [stdin, stdout, stderr, undefined, undefined] as ChildProcessWithoutNullStreams['stdio'],
        });
        spawn = sinon.stub(childProcessApis, 'spawnProcess').returns(child);
        kill = sinon.stub(child, 'kill').returns(true);
        sinon.stub(logging, 'traceVerbose');
        clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        tokens = [];
    });

    teardown(() => {
        for (const token of tokens) {
            token.dispose();
        }
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        sinon.restore();
    });

    function tokenSource(): CancellationTokenSource {
        const source = new CancellationTokenSource();
        tokens.push(source);
        return source;
    }

    function assertCleanedUp(): void {
        assert.strictEqual(clock.countTimers(), 0);
        assert.strictEqual(child.listenerCount('close'), 0);
        assert.strictEqual(child.listenerCount('exit'), 0);
        assert.strictEqual(child.stdout.listenerCount('data'), 0);
        assert.strictEqual(child.stderr.listenerCount('data'), 0);
        for (const emitter of [child, child.stdin, child.stdout, child.stderr]) {
            assert.strictEqual(emitter.listenerCount('error'), 1, 'Only the stateless late-error guard remains');
        }
    }

    function expectFailure(
        promise: Promise<unknown>,
        kind: InstallerProcessError['kind'],
        uncertain: boolean,
    ): Promise<void> {
        return assert.rejects(promise, (error: unknown) => {
            assert.ok(error instanceof InstallerProcessError);
            assert.strictEqual(error.kind, kind);
            assert.strictEqual(error.processMayStillBeRunning, uncertain);
            return true;
        });
    }

    function expectCancellation(promise: Promise<unknown>, uncertain: boolean): Promise<void> {
        return assert.rejects(promise, (error: unknown) => {
            assert.ok(error instanceof CancellationError);
            assert.ok('processMayStillBeRunning' in error);
            assert.strictEqual(error.processMayStillBeRunning, uncertain);
            return true;
        });
    }

    test('uses argv and explicit pipes without replacing the wrapper environment', async () => {
        const args = Object.freeze(['list', '<3.15', 'a b & c']);
        const pending = runInstallerProcess(executable, args);
        sinon.assert.calledOnceWithExactly(spawn, executable, args, {
            shell: false,
            windowsHide: true,
            stdio: 'pipe',
        });
        assert.notStrictEqual(spawn.firstCall.args[1], args);
        assert.strictEqual(child.stdin.writableEnded, true);
        assert.strictEqual(child.stdin.read(), null);
        child.emit('close', 0, null);
        assert.deepStrictEqual(await pending, { stdout: '', stderr: '' });
        sinon.assert.notCalled(kill);
        assertCleanedUp();
    });

    test('waits for close and captures output that arrives after exit, separately', async () => {
        let completed = false;
        const pending = runInstallerProcess(executable, []).then((value) => {
            completed = true;
            return value;
        });
        child.stdout.emit('data', Buffer.from('first'));
        child.stderr.emit('data', Buffer.from('diagnostic'));
        child.emit('exit', 0, null);
        await Promise.resolve();
        assert.strictEqual(completed, false);
        child.stdout.emit('data', Buffer.from(' last'));
        child.stderr.emit('data', Buffer.from(' last'));
        child.emit('close', 0, null);
        assert.deepStrictEqual(await pending, { stdout: 'first last', stderr: 'diagnostic last' });
        assertCleanedUp();
    });

    test('decodes split UTF-8 independently for each stream and forwards only on opt-in', async () => {
        const onOutput = sinon.spy();
        const pending = runInstallerProcess(executable, [], { onOutput });
        const snake = Buffer.from('🐍');
        const accent = Buffer.from('é');
        child.stdout.emit('data', snake.subarray(0, 2));
        child.stderr.emit('data', accent.subarray(0, 1));
        child.stdout.emit('data', snake.subarray(2));
        child.stderr.emit('data', accent.subarray(1));
        child.stdout.emit('data', '!');
        child.emit('close', 0, null);
        assert.deepStrictEqual(await pending, { stdout: '🐍!', stderr: 'é' });
        assert.deepStrictEqual(onOutput.args, [['🐍'], ['é'], ['!']]);
        assertCleanedUp();
    });

    test('flushes incomplete UTF-8 at close', async () => {
        const onOutput = sinon.spy();
        const pending = runInstallerProcess(executable, [], { onOutput });
        child.stdout.emit('data', Buffer.from([0xe2]));
        child.emit('close', 0, null);
        assert.deepStrictEqual(await pending, { stdout: '\ufffd', stderr: '' });
        sinon.assert.calledOnceWithExactly(onOutput, '\ufffd');
    });

    test('wraps synchronous spawn failures without disclosing native details', async () => {
        const cause = new Error('sensitive-spawn-detail');
        spawn.throws(cause);
        await assert.rejects(runInstallerProcess(executable, ['sensitive-argument']), (error: unknown) => {
            assert.ok(error instanceof InstallerProcessError);
            assert.strictEqual(error.kind, 'spawn');
            assert.strictEqual(error.cause, cause);
            assert.strictEqual(error.processMayStillBeRunning, false);
            assert.ok(!error.message.includes('sensitive'));
            return true;
        });
        assert.strictEqual(clock.countTimers(), 0);
        sinon.assert.notCalled(kill);
    });

    test('handles asynchronous spawn failure, closes and then cleans up', async () => {
        const checked = expectFailure(runInstallerProcess(executable, []), 'spawn', false);
        child.emit('error', new Error('ENOENT'));
        child.emit('close', -2, null);
        await checked;
        sinon.assert.notCalled(kill);
        assertCleanedUp();
    });

    test('bounds the wait for close after a spawn failure', async () => {
        const checked = expectFailure(runInstallerProcess(executable, []), 'spawn', false);
        child.emit('error', new Error('ENOENT'));
        await clock.tickAsync(1000);
        await checked;
        sinon.assert.notCalled(kill);
        assertCleanedUp();
    });

    test('rejects nonzero close without exposing stderr or arguments', async () => {
        const pending = runInstallerProcess(executable, ['sensitive-argument']);
        const checked = assert.rejects(pending, (error: unknown) => {
            assert.ok(error instanceof InstallerProcessError);
            assert.strictEqual(error.kind, 'exit');
            assert.strictEqual(error.exitCode, 23);
            assert.strictEqual(error.processMayStillBeRunning, false);
            assert.ok(!error.message.includes('sensitive'));
            return true;
        });
        child.stderr.emit('data', Buffer.from('sensitive-stderr'));
        child.emit('exit', 23, null);
        child.emit('close', 23, null);
        await checked;
        assertCleanedUp();
    });

    test('reports a signal-only exit as failure with uncertainty', async () => {
        const checked = expectFailure(runInstallerProcess(executable, []), 'exit', true);
        child.emit('close', null, 'SIGTERM');
        await checked;
    });

    test('signals only the child on timeout and still waits for close', async () => {
        let completed = false;
        const checked = expectFailure(runInstallerProcess(executable, [], { timeoutMs: 20 }), 'timeout', true).then(
            () => {
                completed = true;
            },
        );
        await clock.tickAsync(20);
        sinon.assert.calledOnceWithExactly(kill);
        assert.strictEqual(completed, false);
        child.emit('close', null, 'SIGTERM');
        await checked;
        assertCleanedUp();
    });

    test('settles after a bounded termination grace and safely handles late events', async () => {
        const onOutput = sinon.spy();
        const checked = expectFailure(
            runInstallerProcess(executable, [], { timeoutMs: 20, onOutput }),
            'timeout',
            true,
        );
        await clock.tickAsync(1020);
        await checked;
        assertCleanedUp();
        assert.doesNotThrow(() => {
            child.emit('error', new Error('late process error'));
            child.stdin.emit('error', Object.assign(new Error('late input error'), { code: 'EPIPE' }));
            child.stdout.emit('error', new Error('late stdout error'));
            child.stderr.emit('error', new Error('late stderr error'));
            child.stdout.emit('data', Buffer.from('late output'));
            child.emit('close', 0, null);
        });
        sinon.assert.notCalled(onOutput);
    });

    test('does not signal an already exited child when its streams never close', async () => {
        const checked = expectFailure(runInstallerProcess(executable, [], { timeoutMs: 20 }), 'timeout', true);
        child.emit('exit', 0, null);
        await clock.tickAsync(1020);
        await checked;
        sinon.assert.notCalled(kill);
        assertCleanedUp();
    });

    test('rejects an already-cancelled token before spawning or allocating timers', async () => {
        const source = tokenSource();
        source.cancel();
        await expectCancellation(runInstallerProcess(executable, [], { cancellationToken: source.token }), false);
        sinon.assert.notCalled(spawn);
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('waits for close on cancellation and disposes the token subscription', async () => {
        const source = tokenSource();
        const registration = sinon.spy(source.token, 'onCancellationRequested');
        let completed = false;
        const checked = expectCancellation(
            runInstallerProcess(executable, [], { cancellationToken: source.token }),
            true,
        ).then(() => {
            completed = true;
        });
        const subscription: Disposable = registration.firstCall.returnValue;
        const dispose = sinon.spy(subscription, 'dispose');
        source.cancel();
        await Promise.resolve();
        assert.strictEqual(completed, false);
        sinon.assert.calledOnceWithExactly(kill);
        child.emit('close', null, 'SIGTERM');
        await checked;
        sinon.assert.calledOnce(dispose);
        source.cancel();
        sinon.assert.calledOnce(kill);
        assertCleanedUp();
    });

    test('disposes cancellation after success so later cancellation cannot kill another process', async () => {
        const source = tokenSource();
        const pending = runInstallerProcess(executable, [], { cancellationToken: source.token });
        child.emit('close', 0, null);
        await pending;
        source.cancel();
        sinon.assert.notCalled(kill);
        assertCleanedUp();
    });

    test('catches cancellation that occurs between the initial check and subscribing', async () => {
        let reads = 0;
        const dispose = sinon.spy();
        const token: CancellationToken = {
            get isCancellationRequested() {
                return reads++ > 0;
            },
            onCancellationRequested: () => ({ dispose }),
        };
        const checked = expectCancellation(runInstallerProcess(executable, [], { cancellationToken: token }), true);
        child.emit('close', null, 'SIGTERM');
        await checked;
        sinon.assert.calledOnce(kill);
        sinon.assert.calledOnce(dispose);
        assertCleanedUp();
    });

    test('disposes a synchronously firing cancellation registration even when kill synchronously closes', async () => {
        const dispose = sinon.spy();
        const token: CancellationToken = {
            isCancellationRequested: false,
            onCancellationRequested: (listener) => {
                listener(undefined);
                return { dispose };
            },
        };
        kill.callsFake(() => {
            child.emit('close', null, 'SIGTERM');
            return true;
        });
        await expectCancellation(runInstallerProcess(executable, [], { cancellationToken: token }), true);
        sinon.assert.calledOnce(dispose);
        assertCleanedUp();
    });

    for (const behavior of ['throws', 'emits-error', 'returns-false'] as const) {
        test(`preserves cancellation and uncertainty when kill ${behavior}`, async () => {
            const source = tokenSource();
            if (behavior === 'throws') {
                kill.throws(new Error('EPERM'));
            } else if (behavior === 'emits-error') {
                kill.callsFake(() => {
                    child.emit('error', new Error('EPERM'));
                    return false;
                });
            } else {
                kill.returns(false);
            }
            const checked = expectCancellation(
                runInstallerProcess(executable, [], { cancellationToken: source.token }),
                true,
            );
            source.cancel();
            await clock.tickAsync(1000);
            await checked;
            sinon.assert.calledOnce(kill);
            assertCleanedUp();
        });
    }

    test('tolerates stdin EPIPE while waiting for the real process result', async () => {
        const pending = runInstallerProcess(executable, []);
        child.stdin.emit('error', Object.assign(new Error('input closed'), { code: 'EPIPE' }));
        child.emit('close', 0, null);
        await pending;
        sinon.assert.notCalled(kill);
        assertCleanedUp();
    });

    test('converts a synchronous stdin write error into a bounded failure', async () => {
        sinon.stub(child.stdin, 'end').throws(new Error('write failed'));
        const checked = expectFailure(runInstallerProcess(executable, []), 'exit', true);
        await clock.tickAsync(1000);
        await checked;
        sinon.assert.calledOnce(kill);
        assertCleanedUp();
    });

    test('handles output stream errors without unhandled error events', async () => {
        const checked = expectFailure(runInstallerProcess(executable, []), 'exit', true);
        child.stdout.emit('error', new Error('read failed'));
        child.emit('close', null, 'SIGTERM');
        await checked;
        assertCleanedUp();
    });

    test('bounds the combined byte count of stdout and stderr without forwarding excess data', async () => {
        const onOutput = sinon.spy();
        const checked = expectFailure(
            runInstallerProcess(executable, [], { maxOutputBytes: 5, onOutput }),
            'output-limit',
            true,
        );
        child.stdout.emit('data', Buffer.from('é'));
        child.stderr.emit('data', Buffer.from('abc'));
        sinon.assert.notCalled(kill);
        child.stderr.emit('data', Buffer.from('overflow'));
        child.stdout.emit('data', Buffer.from('ignored'));
        child.emit('close', null, 'SIGTERM');
        await checked;
        assert.deepStrictEqual(onOutput.args, [['é'], ['abc']]);
        sinon.assert.calledOnce(kill);
        assertCleanedUp();
    });

    test('allows output exactly at the configured bound', async () => {
        const pending = runInstallerProcess(executable, [], { maxOutputBytes: 3 });
        child.stdout.emit('data', Buffer.from('é'));
        child.stderr.emit('data', Buffer.from('a'));
        child.emit('close', 0, null);
        assert.deepStrictEqual(await pending, { stdout: 'é', stderr: 'a' });
    });

    test('enforces a default four MiB output bound', async () => {
        const checked = expectFailure(runInstallerProcess(executable, []), 'output-limit', true);
        child.stdout.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1));
        child.emit('close', null, 'SIGTERM');
        await checked;
        assertCleanedUp();
    });

    test('handles exceptions from output forwarding without leaking listeners', async () => {
        const onOutput = sinon.stub().throws(new Error('forwarding failed'));
        const checked = expectFailure(runInstallerProcess(executable, [], { onOutput }), 'exit', true);
        child.stdout.emit('data', Buffer.from('progress'));
        await clock.tickAsync(1000);
        await checked;
        assertCleanedUp();
    });

    for (const timeoutMs of [-1, Infinity, NaN, 0.5, 2147483648]) {
        test(`rejects invalid timeout ${timeoutMs} before spawning`, async () => {
            await assert.rejects(runInstallerProcess(executable, [], { timeoutMs }), RangeError);
            sinon.assert.notCalled(spawn);
        });
    }

    for (const maxOutputBytes of [-1, Infinity, NaN, 0.5]) {
        test(`rejects invalid output bound ${maxOutputBytes} before spawning`, async () => {
            await assert.rejects(runInstallerProcess(executable, [], { maxOutputBytes }), RangeError);
            sinon.assert.notCalled(spawn);
        });
    }
});
