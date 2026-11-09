// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { It, Mock } from 'typemoq';
import type { ExtensionContext, LogOutputChannel } from 'vscode';
import { activate, deactivate, disposeAll } from '../extension';
import * as extVersion from '../common/extVersion';
import * as logging from '../common/logging';
import * as windowApis from '../common/window.apis';
import * as settingHelpers from '../features/settings/settingHelpers';
import * as workspacePythonContext from '../features/views/workspacePythonContext';

suite('Extension lifecycle', () => {
    teardown(async () => {
        await deactivate();
        sinon.restore();
    });

    function context(subscriptions: ExtensionContext['subscriptions']): ExtensionContext {
        const mock = Mock.ofType<ExtensionContext>();
        mock.setup((value) => value.subscriptions).returns(() => subscriptions);
        return mock.object;
    }

    test('zero-argument shutdown is safe before activation and on repeated calls', async () => {
        await deactivate();
        await deactivate();
    });

    test('explicit opt-out still skips activation and subsequent framework shutdown is safe', async () => {
        sinon.stub(settingHelpers, 'isEnvironmentsExtensionEnabled').returns(false);
        const dispose = sinon.spy();
        const subscriptions = [{ dispose }];

        assert.strictEqual(await activate(context(subscriptions)), undefined);
        sinon.assert.calledOnce(dispose);
        assert.strictEqual(subscriptions.length, 0);

        await deactivate();
        await deactivate();
        sinon.assert.calledOnce(dispose);
    });

    test('framework shutdown disposes subscriptions captured before a failed startup exactly once', async () => {
        const failure = new Error('stop before provider initialization');
        sinon.stub(settingHelpers, 'isEnvironmentsExtensionEnabled').throws(failure);
        const dispose = sinon.spy();
        const subscriptions = [{ dispose }];

        await assert.rejects(activate(context(subscriptions)), (error) => error === failure);
        await deactivate();
        await deactivate();

        sinon.assert.calledOnce(dispose);
        assert.strictEqual(subscriptions.length, 0);
    });

    test('opt-out cleanup waits for asynchronous subscriptions', async () => {
        sinon.stub(settingHelpers, 'isEnvironmentsExtensionEnabled').returns(false);
        let release: (() => void) | undefined;
        const pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        const dispose = sinon.stub().returns(pending);
        const subscriptions = [{ dispose }];
        const activation = activate(context(subscriptions));
        let completed = false;
        void activation.then(() => {
            completed = true;
        });

        await Promise.resolve();
        sinon.assert.calledOnce(dispose);
        assert.strictEqual(completed, false);
        assert.ok(release);
        release();
        await activation;
        assert.strictEqual(completed, true);
        assert.strictEqual(subscriptions.length, 0);
    });

    test('disposal waits for remaining cleanup and surfaces synchronous and asynchronous failures', async () => {
        const syncFailure = new Error('synchronous cleanup failure');
        const asyncFailure = new Error('asynchronous cleanup failure');
        const errors = sinon.stub(logging, 'traceError');
        let release: (() => void) | undefined;
        const pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        const shutdown = disposeAll([
            { dispose: () => { throw syncFailure; } },
            { dispose: async () => { throw asyncFailure; } },
            { dispose: () => pending },
        ]);
        let completed = false;
        void shutdown.catch(() => {
            completed = true;
        });

        await Promise.resolve();
        assert.strictEqual(completed, false);
        assert.ok(release);
        release();
        await assert.rejects(shutdown, (error) => error === syncFailure);
        sinon.assert.calledWith(errors, sinon.match.string, syncFailure);
        sinon.assert.calledWith(errors, sinon.match.string, asyncFailure);
    });

    test('failed shutdown clears captured subscriptions without silently retrying disposal', async () => {
        const startupFailure = new Error('stop before provider initialization');
        const disposalFailure = new Error('cleanup failure');
        sinon.stub(settingHelpers, 'isEnvironmentsExtensionEnabled').throws(startupFailure);
        sinon.stub(logging, 'traceError');
        const dispose = sinon.stub().throws(disposalFailure);
        const subscriptions = [{ dispose }];

        await assert.rejects(activate(context(subscriptions)), (error) => error === startupFailure);
        await assert.rejects(deactivate(), (error) => error === disposalFailure);
        assert.strictEqual(subscriptions.length, 0);
        await deactivate();
        sinon.assert.calledOnce(dispose);
    });

    test('concurrent framework callbacks share and await the same asynchronous shutdown', async () => {
        const startupFailure = new Error('stop before provider initialization');
        sinon.stub(settingHelpers, 'isEnvironmentsExtensionEnabled').throws(startupFailure);
        let release: (() => void) | undefined;
        const pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        const dispose = sinon.stub().returns(pending);
        await assert.rejects(activate(context([{ dispose }])), (error) => error === startupFailure);

        const first = deactivate();
        const second = deactivate();
        assert.strictEqual(first, second);
        let completed = false;
        void second.then(() => {
            completed = true;
        });
        await Promise.resolve();
        assert.strictEqual(completed, false);
        assert.ok(release);
        release();
        await Promise.all([first, second]);
        sinon.assert.calledOnce(dispose);
        assert.strictEqual(completed, true);
    });

    test('concurrent callbacks both receive the same cleanup rejection', async () => {
        const startupFailure = new Error('stop before provider initialization');
        const disposalFailure = new Error('pending cleanup failure');
        sinon.stub(settingHelpers, 'isEnvironmentsExtensionEnabled').throws(startupFailure);
        sinon.stub(logging, 'traceError');
        let reject: ((error: Error) => void) | undefined;
        const pending = new Promise<void>((_resolve, fail) => {
            reject = fail;
        });
        const dispose = sinon.stub().returns(pending);
        await assert.rejects(activate(context([{ dispose }])), (error) => error === startupFailure);

        const first = deactivate();
        const second = deactivate();
        const assertions = [
            assert.rejects(first, (error) => error === disposalFailure),
            assert.rejects(second, (error) => error === disposalFailure),
        ];
        assert.strictEqual(first, second);
        assert.ok(reject);
        reject(disposalFailure);
        await Promise.all(assertions);
        sinon.assert.calledOnce(dispose);
        await deactivate();
    });

    test('real logger stays active until resource cleanup failures are reported', async () => {
        const startupFailure = new Error('stop after logger registration');
        const disposalFailure = new Error('resource cleanup failure');
        sinon.stub(settingHelpers, 'isEnvironmentsExtensionEnabled').returns(true);
        sinon.stub(extVersion, 'ensureCorrectVersion').throws(startupFailure);
        const order: string[] = [];
        const output = Mock.ofType<LogOutputChannel>();
        output.setup((channel) => channel.error(It.isAnyString())).callback(() => {
            order.push('error');
        });
        output.setup((channel) => channel.dispose()).callback(() => {
            order.push('channel-disposed');
        });
        sinon.stub(windowApis, 'createLogOutputChannel').returns(output.object);
        sinon.stub(workspacePythonContext, 'registerWorkspacePythonContext').callsFake((subscriptions) => {
            subscriptions.push({ dispose: () => { throw disposalFailure; } });
        });

        await assert.rejects(activate(context([])), (error) => error === startupFailure);
        await assert.rejects(deactivate(), (error) => error === disposalFailure);
        assert.deepStrictEqual(order, ['error', 'channel-disposed']);
        await deactivate();
        assert.deepStrictEqual(order, ['error', 'channel-disposed']);
    });

    test('late subscriptions remain with the context owner instead of being silently dropped', async () => {
        const startupFailure = new Error('stop before provider initialization');
        sinon.stub(settingHelpers, 'isEnvironmentsExtensionEnabled').throws(startupFailure);
        let release: (() => void) | undefined;
        const pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        const subscriptions = [{ dispose: sinon.stub().returns(pending) }];
        await assert.rejects(activate(context(subscriptions)), (error) => error === startupFailure);

        const shutdown = deactivate();
        const late = { dispose: sinon.stub() };
        subscriptions.push(late);
        assert.ok(release);
        release();
        await shutdown;

        assert.deepStrictEqual(subscriptions, [late]);
        sinon.assert.notCalled(late.dispose);
        await deactivate();
        assert.deepStrictEqual(subscriptions, [late]);
    });
});
