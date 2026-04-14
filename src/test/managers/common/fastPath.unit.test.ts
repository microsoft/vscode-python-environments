// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import { PythonEnvironment } from '../../../api';
import { EventNames } from '../../../common/telemetry/constants';
import * as telemetrySender from '../../../common/telemetry/sender';
import { createDeferred } from '../../../common/utils/deferred';
import { FastPathOptions, tryFastPathGet } from '../../../managers/common/fastPath';

function createMockEnv(envPath: string): PythonEnvironment {
    return {
        envId: { id: 'test-env', managerId: 'test' },
        name: 'Test Env',
        displayName: 'Test Env',
        version: '3.11.0',
        displayPath: envPath,
        environmentPath: Uri.file(envPath),
        sysPrefix: envPath,
        execInfo: { run: { executable: envPath } },
    };
}

interface FastPathTestOptions {
    opts: FastPathOptions;
    setInitialized: sinon.SinonStub;
}

function createOpts(overrides?: Partial<FastPathOptions>): FastPathTestOptions {
    const setInitialized = sinon.stub();
    const persistedPath = path.resolve('persisted', 'path');
    return {
        opts: {
            initialized: undefined,
            setInitialized,
            scope: Uri.file(path.resolve('test', 'workspace')),
            label: 'test',
            getProjectFsPath: (s) => s.fsPath,
            getPersistedPath: sinon.stub().resolves(persistedPath),
            resolve: sinon.stub().resolves(createMockEnv(persistedPath)),
            startBackgroundInit: sinon.stub().resolves(),
            ...overrides,
        },
        setInitialized,
    };
}

suite('tryFastPathGet', () => {
    let sendTelemetryStub: sinon.SinonStub;

    setup(() => {
        sendTelemetryStub = sinon.stub(telemetrySender, 'sendTelemetryEvent');
    });

    teardown(() => {
        sinon.restore();
    });

    test('returns resolved env when persisted path exists and init not started', async () => {
        const { opts } = createOpts();
        const result = await tryFastPathGet(opts);

        assert.ok(result, 'Should return a result');
        assert.strictEqual(result!.env.envId.id, 'test-env');
        assert.ok(sendTelemetryStub.notCalled, 'Should not emit global cache telemetry for workspace scope');
    });

    test('returns undefined when scope is undefined and no getGlobalPersistedPath', async () => {
        const { opts } = createOpts({ scope: undefined });
        const result = await tryFastPathGet(opts);

        assert.strictEqual(result, undefined);
        assert.ok((opts.getPersistedPath as sinon.SinonStub).notCalled);
    });

    test('returns resolved env for global scope when getGlobalPersistedPath returns a path', async () => {
        const globalPath = path.resolve('usr', 'bin', 'python3');
        const resolve = sinon.stub().resolves(createMockEnv(globalPath));
        const { opts } = createOpts({
            scope: undefined,
            getGlobalPersistedPath: sinon.stub().resolves(globalPath),
            resolve,
        });
        const result = await tryFastPathGet(opts);

        assert.ok(result, 'Should return a result for global scope');
        assert.strictEqual(result!.env.envId.id, 'test-env');
        assert.ok(resolve.calledOnceWith(globalPath), 'Should resolve the global persisted path');
        assert.ok((opts.getPersistedPath as sinon.SinonStub).notCalled, 'Should not call workspace getPersistedPath');

        // Verify cache hit telemetry
        assert.ok(sendTelemetryStub.calledOnce, 'Should send telemetry for global cache hit');
        const [eventName, , props] = sendTelemetryStub.firstCall.args;
        assert.strictEqual(eventName, EventNames.GLOBAL_ENV_CACHE);
        assert.strictEqual(props.result, 'hit');
        assert.strictEqual(props.managerLabel, 'test');
    });

    test('returns undefined for global scope when getGlobalPersistedPath returns undefined', async () => {
        const { opts } = createOpts({
            scope: undefined,
            getGlobalPersistedPath: sinon.stub().resolves(undefined),
        });
        const result = await tryFastPathGet(opts);

        assert.strictEqual(result, undefined);

        // Verify cache miss telemetry
        assert.ok(sendTelemetryStub.calledOnce, 'Should send telemetry for global cache miss');
        const [eventName, , props] = sendTelemetryStub.firstCall.args;
        assert.strictEqual(eventName, EventNames.GLOBAL_ENV_CACHE);
        assert.strictEqual(props.result, 'miss');
    });

    test('reports stale when global cached path resolves to undefined', async () => {
        const globalPath = path.resolve('usr', 'bin', 'python3');
        const { opts } = createOpts({
            scope: undefined,
            getGlobalPersistedPath: sinon.stub().resolves(globalPath),
            resolve: sinon.stub().resolves(undefined),
        });
        const result = await tryFastPathGet(opts);

        assert.strictEqual(result, undefined, 'Should fall through when cached env resolves to undefined');
        assert.ok(sendTelemetryStub.calledOnce, 'Should send telemetry for stale cache');
        const [eventName, , props] = sendTelemetryStub.firstCall.args;
        assert.strictEqual(eventName, EventNames.GLOBAL_ENV_CACHE);
        assert.strictEqual(props.result, 'stale');
    });

    test('returns undefined for global scope when cached path resolve fails', async () => {
        const globalPath = path.resolve('usr', 'bin', 'python3');
        const { opts } = createOpts({
            scope: undefined,
            getGlobalPersistedPath: sinon.stub().resolves(globalPath),
            resolve: sinon.stub().rejects(new Error('python was uninstalled')),
        });
        const result = await tryFastPathGet(opts);

        assert.strictEqual(result, undefined, 'Should fall through when cached global env is stale');

        // Verify cache stale telemetry
        assert.ok(sendTelemetryStub.calledOnce, 'Should send telemetry for stale global cache');
        const [eventName, , props] = sendTelemetryStub.firstCall.args;
        assert.strictEqual(eventName, EventNames.GLOBAL_ENV_CACHE);
        assert.strictEqual(props.result, 'stale');
    });

    test('global scope fast path starts background init when initialized is undefined', async () => {
        const globalPath = path.resolve('usr', 'bin', 'python3');
        const startBackgroundInit = sinon.stub().resolves();
        const { opts, setInitialized } = createOpts({
            scope: undefined,
            getGlobalPersistedPath: sinon.stub().resolves(globalPath),
            startBackgroundInit,
        });
        const result = await tryFastPathGet(opts);

        assert.ok(result, 'Should return fast-path result');
        assert.ok(startBackgroundInit.calledOnce, 'Should start background init for global scope');
        assert.ok(setInitialized.calledOnce, 'Should set initialized for global scope');
    });

    test('returns undefined when init is already completed', async () => {
        const deferred = createDeferred<void>();
        deferred.resolve();
        const { opts } = createOpts({ initialized: deferred });
        const result = await tryFastPathGet(opts);

        assert.strictEqual(result, undefined);
        assert.ok((opts.getPersistedPath as sinon.SinonStub).notCalled);
    });

    test('returns undefined when no persisted path', async () => {
        const { opts } = createOpts({
            getPersistedPath: sinon.stub().resolves(undefined),
        });
        const result = await tryFastPathGet(opts);

        assert.strictEqual(result, undefined);
    });

    test('returns undefined when resolve returns undefined', async () => {
        const { opts } = createOpts({
            resolve: sinon.stub().resolves(undefined),
        });
        const result = await tryFastPathGet(opts);

        assert.strictEqual(result, undefined);
    });

    test('returns undefined when resolve throws', async () => {
        const { opts } = createOpts({
            resolve: sinon.stub().rejects(new Error('resolve failed')),
        });
        const result = await tryFastPathGet(opts);

        assert.strictEqual(result, undefined);
    });

    test('calls getProjectFsPath with the scope Uri', async () => {
        const scope = Uri.file(path.resolve('my', 'project'));
        const getProjectFsPath = sinon.stub().returns(scope.fsPath);
        const { opts } = createOpts({ scope, getProjectFsPath });
        await tryFastPathGet(opts);

        assert.ok(getProjectFsPath.calledOnce);
        assert.strictEqual(getProjectFsPath.firstCall.args[0], scope);
    });

    test('passes project fsPath to getPersistedPath', async () => {
        const projectPath = path.resolve('project', 'path');
        const getProjectFsPath = sinon.stub().returns(projectPath);
        const getPersistedPath = sinon.stub().resolves(path.resolve('persisted'));
        const { opts } = createOpts({
            getProjectFsPath,
            getPersistedPath,
            resolve: sinon.stub().resolves(undefined),
        });
        await tryFastPathGet(opts);

        assert.strictEqual(getPersistedPath.firstCall.args[0], projectPath);
    });

    test('does not call startBackgroundInit when initialized already exists (in-progress)', async () => {
        const existing = createDeferred<void>(); // not resolved
        const startBackgroundInit = sinon.stub().resolves();
        const { opts, setInitialized } = createOpts({ initialized: existing, startBackgroundInit });
        const result = await tryFastPathGet(opts);

        assert.ok(result, 'Should return env');
        assert.ok(startBackgroundInit.notCalled, 'Should not start background init');
        assert.ok(setInitialized.notCalled, 'Should not update initialized state');
    });

    test('kicks off background init and sets initialized when initialized is undefined', async () => {
        const startBackgroundInit = sinon.stub().resolves();
        const { opts, setInitialized } = createOpts({ startBackgroundInit });
        const result = await tryFastPathGet(opts);

        assert.ok(result, 'Should return fast-path result');
        assert.ok(startBackgroundInit.calledOnce, 'Should call startBackgroundInit');
        assert.ok(setInitialized.calledOnce, 'Should set initialized immediately');
    });

    test('background init failure resets initialized for retry', async () => {
        const startBackgroundInit = sinon.stub().rejects(new Error('init crashed'));
        const { opts, setInitialized } = createOpts({ startBackgroundInit });
        const result = await tryFastPathGet(opts);

        assert.ok(result, 'Should still return resolved env');
        assert.ok(setInitialized.called, 'Should set initialized before async work');

        // Allow background init promise rejection handler to run.
        await new Promise((resolve) => setImmediate(resolve));

        const lastCallArg = setInitialized.lastCall.args[0] as unknown;
        assert.strictEqual(lastCallArg, undefined, 'Should clear initialized after background init failure');
    });

    test('sets initialized before awaiting persisted path', async () => {
        let releasePersistedRead: (() => void) | undefined;
        const getPersistedPath = sinon.stub().callsFake(
            () =>
                new Promise<string | undefined>((resolve) => {
                    releasePersistedRead = () => resolve(path.resolve('persisted', 'path'));
                }),
        );
        const { opts, setInitialized } = createOpts({ getPersistedPath });
        const pending = tryFastPathGet(opts);

        assert.ok(setInitialized.calledOnce, 'Should set initialized before hitting first await');

        releasePersistedRead!();
        await pending;
    });

    test('works with Thenable return from startBackgroundInit', async () => {
        // Simulate withProgress returning a Thenable (not a full Promise)
        const thenable = { then: (resolve: () => void) => resolve() };
        const { opts } = createOpts({
            startBackgroundInit: sinon.stub().returns(thenable),
        });
        const result = await tryFastPathGet(opts);

        assert.ok(result, 'Should resolve successfully with Thenable init');
    });

    test('synchronous background init failure resets initialized for retry', async () => {
        const startBackgroundInit = sinon.stub().throws(new Error('init crashed sync'));
        const { opts, setInitialized } = createOpts({ startBackgroundInit });
        const result = await tryFastPathGet(opts);

        assert.ok(result, 'Should still return resolved env even when background init throws synchronously');
        assert.ok(
            setInitialized.called,
            'Should set initialized before attempting background init even when it throws synchronously',
        );

        // Allow any background init error handling to run.
        await new Promise((resolve) => setImmediate(resolve));

        const lastCallArg = setInitialized.lastCall.args[0] as unknown;
        assert.strictEqual(
            lastCallArg,
            undefined,
            'Should clear initialized after synchronous background init failure',
        );
    });
});
