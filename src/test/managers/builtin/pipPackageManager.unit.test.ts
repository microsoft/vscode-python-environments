// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { LogOutputChannel, Uri } from 'vscode';
import {
    Package,
    PythonEnvironment,
    PythonEnvironmentApi,
    isPackageVersionLookupNotSupportedError,
} from '../../../api';
import * as helpers from '../../../managers/builtin/helpers';
import { PipPackageManager } from '../../../managers/builtin/pipPackageManager';
import * as builtinUtils from '../../../managers/builtin/utils';
import { VenvManager } from '../../../managers/builtin/venvManager';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

suite('PipPackageManager', () => {
    teardown(() => {
        sinon.restore();
    });

    test('preserves cached packages when a forced refresh fails', async () => {
        const environment = {
            envId: { id: 'test-environment', managerId: 'test-manager' },
            environmentPath: Uri.file('/path/to/environment'),
        } as PythonEnvironment;
        const cachedPackage = { name: 'pip', version: '25.0' } as Package;
        const api = {
            createPackageItem: sinon.stub().returns(cachedPackage),
        } as unknown as PythonEnvironmentApi;
        const log = {
            error: sinon.stub(),
            info: sinon.stub(),
        } as unknown as LogOutputChannel;
        const manager = new PipPackageManager(api, log, {} as VenvManager);
        const refreshPackages = sinon.stub(builtinUtils, 'refreshPipPackages');
        refreshPackages
            .onFirstCall()
            .resolves([{ name: 'pip', version: '25.0', displayName: 'pip', description: '25.0' }]);
        refreshPackages.onSecondCall().resolves(undefined);

        const initial = await manager.getPackages(environment);
        const afterFailedRefresh = await manager.getPackages(environment, { skipCache: true });

        assert.deepStrictEqual(initial, [cachedPackage]);
        assert.deepStrictEqual(afterFailedRefresh, [cachedPackage]);
    });

    test('preserves undefined when an uncached refresh fails', async () => {
        const environment = {
            envId: { id: 'test-environment', managerId: 'test-manager' },
            environmentPath: Uri.file('/path/to/environment'),
        } as PythonEnvironment;
        const manager = new PipPackageManager(
            { createPackageItem: sinon.stub() } as unknown as PythonEnvironmentApi,
            { error: sinon.stub(), info: sinon.stub() } as unknown as LogOutputChannel,
            {} as VenvManager,
        );
        const refreshPackages = sinon.stub(builtinUtils, 'refreshPipPackages').resolves(undefined);

        const firstResult = await manager.getPackages(environment);
        const secondResult = await manager.getPackages(environment);

        assert.strictEqual(firstResult, undefined);
        assert.strictEqual(secondResult, undefined);
        assert.strictEqual(refreshPackages.callCount, 2, 'A failed refresh should not populate the package cache');
    });

    test('reports version lookup as unsupported for pip older than 21.2', async () => {
        const manager = createManager();
        const environment = createEnvironment();
        sinon.stub(helpers, 'shouldUseUv').resolves(false);
        sinon.stub(helpers, 'runPython').resolves('pip 20.3.4 from /path/to/pip (python 3.12)');

        await assert.rejects(
            manager.getPackageAvailableVersions(environment, 'requests'),
            isPackageVersionLookupNotSupportedError,
        );
    });

    test('propagates version lookup command failures for supported pip', async () => {
        const manager = createManager();
        const environment = createEnvironment();
        const lookupError = new Error('pip index failed');
        sinon.stub(helpers, 'shouldUseUv').resolves(false);
        const runPython = sinon.stub(helpers, 'runPython');
        runPython.onFirstCall().resolves('pip 25.1 from /path/to/pip (python 3.12)');
        runPython.onSecondCall().rejects(lookupError);

        await assert.rejects(
            manager.getPackageAvailableVersions(environment, 'requests'),
            (error: unknown) => error === lookupError,
        );
    });

    test('normalizes discovered Python versions for pip lookup', async () => {
        const manager = createManager();
        const environment = {
            ...createEnvironment(),
            version: '3.13.14.final.0',
        };
        sinon.stub(helpers, 'shouldUseUv').resolves(false);
        const runPython = sinon.stub(helpers, 'runPython');
        runPython.onFirstCall().resolves('pip 25.1 from /path/to/pip (python 3.13)');
        runPython.onSecondCall().resolves(JSON.stringify({ versions: ['2.32.5'] }));

        await manager.getPackageAvailableVersions(environment, 'requests');

        assert.deepStrictEqual(runPython.secondCall.args[1], [
            '-m',
            'pip',
            'index',
            'versions',
            'requests',
            '--json',
            '--python-version',
            '3.13.14',
        ]);
    });

    test('rejects package management for Python 2 environments', async () => {
        const shouldUseUvStub = sinon.stub(helpers, 'shouldUseUv');
        const environment = createMockPythonEnvironment({
            envPath: path.join(process.cwd(), 'python2'),
            version: '2.7.18',
            managerId: 'ms-python.python:venv',
        });
        const manager = new PipPackageManager(
            {} as PythonEnvironmentApi,
            {} as LogOutputChannel,
            {} as VenvManager,
        );

        await assert.rejects(
            manager.manage(environment, { install: ['flask'] }),
            /Python 2\.\* is not supported \(deprecated\)/,
        );
        assert.strictEqual(shouldUseUvStub.callCount, 0);
    });

    function createManager(): PipPackageManager {
        return new PipPackageManager(
            { createPackageItem: sinon.stub() } as unknown as PythonEnvironmentApi,
            { error: sinon.stub(), info: sinon.stub() } as unknown as LogOutputChannel,
            {} as VenvManager,
        );
    }

    function createEnvironment(): PythonEnvironment {
        return {
            envId: { id: 'test-environment', managerId: 'test-manager' },
            environmentPath: Uri.file('/path/to/environment'),
            execInfo: { run: { executable: 'python', args: [] } },
            version: '3.12.0',
        } as unknown as PythonEnvironment;
    }
});
