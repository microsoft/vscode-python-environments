// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { LogOutputChannel, Uri } from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi } from '../../../api';
import * as errorUtils from '../../../common/errors/utils';
import * as windowApis from '../../../common/window.apis';
import { CondaPackageManager } from '../../../managers/conda/condaPackageManager';
import * as condaUtils from '../../../managers/conda/condaUtils';

suite('CondaPackageManager', () => {
    teardown(() => {
        sinon.restore();
    });

    test('headless package failures reject without showing error UI', async () => {
        const environment = {
            envId: { id: 'test-environment', managerId: 'test-manager' },
            environmentPath: Uri.file('/path/to/environment'),
        } as PythonEnvironment;
        const logError = sinon.stub();
        const log = {
            error: logError,
        } as unknown as LogOutputChannel;
        const manager = new CondaPackageManager({} as PythonEnvironmentApi, log);
        const operationError = new Error('conda install failed');
        sinon.stub(condaUtils, 'managePackages').rejects(operationError);
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
        sinon.stub(condaUtils, 'runCondaExecutable').rejects(lookupError);

        await assert.rejects(
            manager.getPackageAvailableVersions(environment, 'flask'),
            (error: unknown) => error === lookupError,
        );
    });
});
