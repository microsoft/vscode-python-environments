// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import { PythonEnvironment } from '../../../api';
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

function createOpts(overrides?: Partial<FastPathOptions>): FastPathOptions {
    return {
        initialized: undefined,
        scope: Uri.file('/test/workspace'),
        label: 'test',
        getProjectFsPath: (s) => s.fsPath,
        getPersistedPath: sinon.stub().resolves('/persisted/path'),
        resolve: sinon.stub().resolves(createMockEnv('/persisted/path')),
        startBackgroundInit: sinon.stub().resolves(),
        ...overrides,
    };
}

suite('tryFastPathGet', () => {
    test('returns resolved env when persisted path exists and init not started', async () => {
        const opts = createOpts();
        const result = await tryFastPathGet(opts);

        assert.ok(result, 'Should return a result');
        assert.strictEqual(result!.env.envId.id, 'test-env');
        assert.ok(result!.newDeferred, 'Should create a new deferred');
    });

    test('returns undefined when scope is undefined', async () => {
        const opts = createOpts({ scope: undefined });
        const result = await tryFastPathGet(opts);

        assert.strictEqual(result, undefined);
        assert.ok((opts.getPersistedPath as sinon.SinonStub).notCalled);
    });

    test('returns undefined when init is already completed', async () => {
        const deferred = createDeferred<void>();
        deferred.resolve();
        const opts = createOpts({ initialized: deferred });
        const result = await tryFastPathGet(opts);

        assert.strictEqual(result, undefined);
        assert.ok((opts.getPersistedPath as sinon.SinonStub).notCalled);
    });

    test('returns undefined when no persisted path', async () => {
        const opts = createOpts({
            getPersistedPath: sinon.stub().resolves(undefined),
        });
        const result = await tryFastPathGet(opts);

        assert.strictEqual(result, undefined);
    });

    test('returns undefined when resolve returns undefined', async () => {
        const opts = createOpts({
            resolve: sinon.stub().resolves(undefined),
        });
        const result = await tryFastPathGet(opts);

        assert.strictEqual(result, undefined);
    });

    test('returns undefined when resolve throws', async () => {
        const opts = createOpts({
            resolve: sinon.stub().rejects(new Error('resolve failed')),
        });
        const result = await tryFastPathGet(opts);

        assert.strictEqual(result, undefined);
    });

    test('calls getProjectFsPath with the scope Uri', async () => {
        const scope = Uri.file('/my/project');
        const getProjectFsPath = sinon.stub().returns('/my/project');
        const opts = createOpts({ scope, getProjectFsPath });
        await tryFastPathGet(opts);

        assert.ok(getProjectFsPath.calledOnce);
        assert.strictEqual(getProjectFsPath.firstCall.args[0], scope);
    });

    test('passes project fsPath to getPersistedPath', async () => {
        const getProjectFsPath = sinon.stub().returns('/project/path');
        const getPersistedPath = sinon.stub().resolves('/persisted');
        const opts = createOpts({
            getProjectFsPath,
            getPersistedPath,
            resolve: sinon.stub().resolves(undefined),
        });
        await tryFastPathGet(opts);

        assert.strictEqual(getPersistedPath.firstCall.args[0], '/project/path');
    });

    test('does not create deferred when initialized already exists (in-progress)', async () => {
        const existing = createDeferred<void>(); // not resolved
        const opts = createOpts({ initialized: existing });
        const result = await tryFastPathGet(opts);

        assert.ok(result, 'Should return env');
        assert.strictEqual(result!.newDeferred, undefined, 'Should not create new deferred');
        assert.ok((opts.startBackgroundInit as sinon.SinonStub).notCalled, 'Should not start background init');
    });

    test('kicks off background init and creates deferred when initialized is undefined', async () => {
        const startBackgroundInit = sinon.stub().resolves();
        const opts = createOpts({ startBackgroundInit });
        const result = await tryFastPathGet(opts);

        assert.ok(result?.newDeferred, 'Should create a new deferred');
        assert.ok(startBackgroundInit.calledOnce, 'Should call startBackgroundInit');
    });

    test('background init failure resolves deferred (does not reject)', async () => {
        const startBackgroundInit = sinon.stub().rejects(new Error('init crashed'));
        const opts = createOpts({ startBackgroundInit });
        const result = await tryFastPathGet(opts);

        assert.ok(result?.newDeferred, 'Should have deferred');
        // Wait for the background init to settle
        await result!.newDeferred!.promise;
        assert.ok(result!.newDeferred!.completed, 'Deferred should resolve despite error');
        assert.ok(result!.newDeferred!.resolved, 'Should be resolved, not rejected');
    });

    test('background init success resolves deferred', async () => {
        const opts = createOpts();
        const result = await tryFastPathGet(opts);

        assert.ok(result?.newDeferred);
        await result!.newDeferred!.promise;
        assert.ok(result!.newDeferred!.resolved);
    });

    test('works with Thenable return from startBackgroundInit', async () => {
        // Simulate withProgress returning a Thenable (not a full Promise)
        const thenable = { then: (resolve: () => void) => resolve() };
        const opts = createOpts({
            startBackgroundInit: sinon.stub().returns(thenable),
        });
        const result = await tryFastPathGet(opts);

        assert.ok(result?.newDeferred);
        await result!.newDeferred!.promise;
        assert.ok(result!.newDeferred!.resolved);
    });
});
