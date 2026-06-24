// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as sinon from 'sinon';
import { LogOutputChannel, Uri } from 'vscode';
import { EnvironmentManager, PythonEnvironment } from '../../../api';
import { InlineScriptEnvManager } from '../../../managers/builtin/inlineScriptEnvManager';

function makeFakeLog(): LogOutputChannel {
    return sinon.createStubInstance(
        class {
            info() {}
            warn() {}
            error() {}
            debug() {}
            trace() {}
            show() {}
            dispose() {}
            append() {}
            appendLine() {}
            replace() {}
            clear() {}
            hide() {}
        },
    ) as unknown as LogOutputChannel;
}

function makeEnv(): PythonEnvironment {
    return {
        envId: { id: 'fake', managerId: 'ms-python.python:inline-script' },
        name: 'fake',
        displayName: 'fake',
        displayPath: '/fake',
        version: '3.12.0',
        environmentPath: Uri.file('/fake'),
        execInfo: { run: { executable: '/fake' } },
        sysPrefix: '/fake',
    };
}

suite('InlineScriptEnvManager (skeleton)', () => {
    let mgr: InlineScriptEnvManager;

    setup(() => {
        mgr = new InlineScriptEnvManager(makeFakeLog());
    });

    teardown(() => {
        mgr.dispose();
        sinon.restore();
    });

    suite('static metadata', () => {
        test('name is "inline-script"', () => {
            assert.strictEqual(mgr.name, 'inline-script');
        });

        test('displayName is set (for the picker section header)', () => {
            assert.ok(mgr.displayName);
            assert.ok(mgr.displayName.length > 0);
        });

        test('preferredPackageManagerId is the standard pip manager id', () => {
            assert.strictEqual(mgr.preferredPackageManagerId, 'ms-python.python:pip');
        });

        test('iconPath is defined (renders in the picker)', () => {
            assert.ok(mgr.iconPath);
        });

        test('tooltip is defined (shown on hover in the picker)', () => {
            assert.ok(mgr.tooltip);
        });
    });

    suite('skeleton method behavior', () => {
        test('getEnvironments("all") returns []', async () => {
            assert.deepStrictEqual(await mgr.getEnvironments('all'), []);
        });

        test('getEnvironments("global") returns []', async () => {
            assert.deepStrictEqual(await mgr.getEnvironments('global'), []);
        });

        test('getEnvironments(Uri) returns []', async () => {
            assert.deepStrictEqual(await mgr.getEnvironments(Uri.file('/tmp/script.py')), []);
        });

        test('get(undefined) returns undefined', async () => {
            assert.strictEqual(await mgr.get(undefined), undefined);
        });

        test('get(Uri) returns undefined', async () => {
            assert.strictEqual(await mgr.get(Uri.file('/tmp/script.py')), undefined);
        });

        test('set(scope, env) is a no-op and does not throw', async () => {
            await assert.doesNotReject(mgr.set(Uri.file('/tmp/script.py'), makeEnv()));
            await assert.doesNotReject(mgr.set(undefined, undefined));
        });

        test('refresh(scope) is a no-op and does not throw', async () => {
            await assert.doesNotReject(mgr.refresh(undefined));
            await assert.doesNotReject(mgr.refresh(Uri.file('/tmp/script.py')));
        });

        test('resolve(Uri) returns undefined', async () => {
            assert.strictEqual(await mgr.resolve(Uri.file('/tmp/script.py')), undefined);
        });

        test('does not implement optional create / remove / quickCreateConfig', () => {
            // Cast via the interface to probe optional methods (the concrete class type doesn't declare them).
            const asInterface: EnvironmentManager = mgr;
            assert.strictEqual(asInterface.create, undefined);
            assert.strictEqual(asInterface.remove, undefined);
            assert.strictEqual(asInterface.quickCreateConfig, undefined);
        });
    });

    suite('events', () => {
        test('onDidChangeEnvironments is exposed and subscribable', () => {
            const disposable = mgr.onDidChangeEnvironments(() => undefined);
            assert.ok(disposable);
            disposable.dispose();
        });

        test('onDidChangeEnvironment is exposed and subscribable', () => {
            const disposable = mgr.onDidChangeEnvironment(() => undefined);
            assert.ok(disposable);
            disposable.dispose();
        });

        test('skeleton methods do not fire any events', async () => {
            const envsListener = sinon.spy();
            const envListener = sinon.spy();
            mgr.onDidChangeEnvironments(envsListener);
            mgr.onDidChangeEnvironment(envListener);

            await mgr.getEnvironments('all');
            await mgr.get(undefined);
            await mgr.set(Uri.file('/tmp/script.py'), makeEnv());
            await mgr.refresh(undefined);
            await mgr.resolve(Uri.file('/tmp/script.py'));

            assert.strictEqual(envsListener.callCount, 0, 'getEnvironments/refresh must not fire envs event');
            assert.strictEqual(envListener.callCount, 0, 'set must not fire env event in the skeleton');
        });
    });

    suite('disposal', () => {
        test('dispose() does not throw', () => {
            assert.doesNotThrow(() => mgr.dispose());
        });

        test('dispose() is idempotent', () => {
            mgr.dispose();
            assert.doesNotThrow(() => mgr.dispose());
        });
    });
});
