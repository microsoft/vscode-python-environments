// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as sinon from 'sinon';
import { CancellationError, CancellationToken, CancellationTokenSource } from 'vscode';
import * as childProcessApis from '../../../common/childProcess.apis';
import { runPython, runUV } from '../../../managers/builtin/helpers';
import { MockChildProcess } from '../../mocks/mockChildProcess';

suite('process helper cancellation safety', () => {
    let spawnStub: sinon.SinonStub;

    setup(() => {
        spawnStub = sinon.stub(childProcessApis, 'spawnProcess');
    });

    teardown(() => {
        sinon.restore();
    });

    async function expectCancellation(
        process: MockChildProcess,
        run: (token: CancellationToken) => Promise<string>,
        killBehavior: 'emitError' | 'throw',
    ): Promise<void> {
        spawnStub.returns(process);
        const killStub = sinon.stub(process, 'kill');
        if (killBehavior === 'emitError') {
            killStub.callsFake(() => {
                process.emit('error', new Error('kill EPERM'));
                return false;
            });
        } else {
            killStub.throws(new Error('kill EPERM'));
        }

        const tokenSource = new CancellationTokenSource();
        const result = run(tokenSource.token);
        tokenSource.cancel();

        await assert.rejects(result, (error: Error) => {
            assert.ok(error instanceof CancellationError);
            return true;
        });
        assert.ok(killStub.calledOnce);
        tokenSource.dispose();
    }

    test('runUV remains cancelled when kill emits an error synchronously', async () => {
        const process = new MockChildProcess('uv', ['pip', 'install', 'requests']);
        await expectCancellation(
            process,
            (token) => runUV(['pip', 'install', 'requests'], undefined, undefined, token),
            'emitError',
        );
    });

    test('runUV remains cancelled when kill throws', async () => {
        const process = new MockChildProcess('uv', ['pip', 'install', 'requests']);
        await expectCancellation(
            process,
            (token) => runUV(['pip', 'install', 'requests'], undefined, undefined, token),
            'throw',
        );
    });

    test('runPython remains cancelled when kill emits an error synchronously', async () => {
        const process = new MockChildProcess('python', ['-m', 'pip', 'install', 'requests']);
        await expectCancellation(
            process,
            (token) => runPython('python', ['-m', 'pip', 'install', 'requests'], undefined, undefined, token),
            'emitError',
        );
    });

    test('runPython remains cancelled when kill throws', async () => {
        const process = new MockChildProcess('python', ['-m', 'pip', 'install', 'requests']);
        await expectCancellation(
            process,
            (token) => runPython('python', ['-m', 'pip', 'install', 'requests'], undefined, undefined, token),
            'throw',
        );
    });
});
