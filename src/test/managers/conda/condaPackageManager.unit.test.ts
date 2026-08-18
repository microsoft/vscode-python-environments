// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { LogOutputChannel, Uri } from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi } from '../../../api';
import * as errorUtils from '../../../common/errors/utils';
import * as windowApis from '../../../common/window.apis';
import { CondaAvailableVersionsCommand } from '../../../managers/conda/commands/availableVersions';
import { CondaInstallCommand } from '../../../managers/conda/commands/install';
import { CondaListCommand } from '../../../managers/conda/commands/list';
import { CondaPackageManager } from '../../../managers/conda/condaPackageManager';

suite('CondaPackageManager', () => {
    teardown(() => {
        sinon.restore();
    });

    test('headless package failures reject without showing error UI', async () => {
        const environment = {
            envId: { id: 'test-environment', managerId: 'test-manager' },
            environmentPath: Uri.file('.'),
        } as PythonEnvironment;
        const logError = sinon.stub();
        const log = {
            error: logError,
        } as unknown as LogOutputChannel;
        const manager = new CondaPackageManager({} as PythonEnvironmentApi, log);
        const operationError = new Error('conda install failed');
        sinon.stub(CondaInstallCommand.prototype, 'execute').rejects(operationError);
        sinon.stub(windowApis, 'withProgress').callsFake(async (_options, task) => task({} as never, {} as never));
        const showErrorMessageWithLogs = sinon.stub(errorUtils, 'showErrorMessageWithLogs').resolves();

        await assert.rejects(
            manager.manage(environment, { install: ['requests'], runHeadless: true }),
            (error: unknown) => error === operationError,
        );

        assert.ok(logError.calledOnce);
        assert.ok(showErrorMessageWithLogs.notCalled);
    });

    test('propagates package version lookup failures', async () => {
        const environment = {
            envId: { id: 'test-environment', managerId: 'test-manager' },
        } as PythonEnvironment;
        const manager = new CondaPackageManager(
            {} as PythonEnvironmentApi,
            { error: sinon.stub() } as unknown as LogOutputChannel,
        );
        const lookupError = new Error('conda search failed');
        sinon.stub(CondaAvailableVersionsCommand.prototype, 'execute').rejects(lookupError);

        await assert.rejects(
            manager.getPackageAvailableVersions(environment, 'flask'),
            (error: unknown) => error === lookupError,
        );
    });

    test('retries package listing after a parse failure and caches only success', async () => {
        const environment = {
            envId: { id: 'test-environment', managerId: 'test-manager' },
            environmentPath: Uri.file('.'),
        } as PythonEnvironment;
        const api = {
            createPackageItem: sinon.stub().callsFake((pkg) => pkg),
        } as unknown as PythonEnvironmentApi;
        const manager = new CondaPackageManager(api, { error: sinon.stub() } as unknown as LogOutputChannel);
        const parseError = new SyntaxError('Unexpected token');
        const execute = sinon.stub(CondaListCommand.prototype, 'execute');
        execute.onFirstCall().rejects(parseError);
        execute.onSecondCall().resolves([
            {
                name: 'requests',
                displayName: 'requests',
                version: '2.32.0',
                description: '2.32.0',
            },
        ]);

        await assert.rejects(manager.getPackages(environment), (error: unknown) => error === parseError);
        const packages = await manager.getPackages(environment);
        const cachedPackages = await manager.getPackages(environment);

        assert.deepStrictEqual(packages?.map((pkg) => pkg.name), ['requests']);
        assert.deepStrictEqual(cachedPackages?.map((pkg) => pkg.name), ['requests']);
        assert.strictEqual(execute.callCount, 2, 'Only the successful list result should populate the cache');
    });
});
