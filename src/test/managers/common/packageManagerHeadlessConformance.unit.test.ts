// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { LogOutputChannel, Uri } from 'vscode';
import { PackageManager, PythonEnvironment, PythonEnvironmentApi } from '../../../api';
import * as errorUtils from '../../../common/errors/utils';
import * as windowApis from '../../../common/window.apis';
import { PipPackageManager } from '../../../managers/builtin/pipPackageManager';
import * as pipUtils from '../../../managers/builtin/pipUtils';
import * as builtinUtils from '../../../managers/builtin/utils';
import { VenvManager } from '../../../managers/builtin/venvManager';
import { CondaPackageManager } from '../../../managers/conda/condaPackageManager';
import * as condaUtils from '../../../managers/conda/condaUtils';
import { PoetryManager } from '../../../managers/poetry/poetryManager';
import { PoetryPackageManager } from '../../../managers/poetry/poetryPackageManager';
import * as poetryUtils from '../../../managers/poetry/poetryUtils';

suite('Package manager headless conformance', () => {
    const environment = {
        envId: { id: 'test-environment', managerId: 'test-manager' },
        environmentPath: Uri.joinPath(Uri.file(__dirname), 'path', 'to', 'environment'),
    } as PythonEnvironment;

    teardown(() => {
        sinon.restore();
    });

    function createManagers(): PackageManager[] {
        const api = {} as PythonEnvironmentApi;
        const log = {
            error: sinon.stub(),
            info: sinon.stub(),
            show: sinon.stub(),
        } as unknown as LogOutputChannel;
        return [
            new PipPackageManager(api, log, { getProjectsByEnvironment: sinon.stub().returns([]) } as unknown as VenvManager),
            new CondaPackageManager(api, log),
            new PoetryPackageManager(api, log, {} as PoetryManager),
        ];
    }

    test('does not invoke interactive package input when no packages are provided', async () => {
        const pipPicker = sinon.stub(pipUtils, 'getWorkspacePackagesToInstall');
        const condaPicker = sinon.stub(condaUtils, 'getCommonCondaPackagesToInstall');
        const poetryInput = sinon.stub(windowApis, 'showInputBox');

        for (const manager of createManagers()) {
            await manager.manage(environment, { install: [], runHeadless: true });
        }

        assert.ok(pipPicker.notCalled);
        assert.ok(condaPicker.notCalled);
        assert.ok(poetryInput.notCalled);
    });

    test('rejects failures without showing error notifications', async () => {
        const operationError = new Error('package operation failed');
        const withProgress = sinon.stub(windowApis, 'withProgress');
        sinon.stub(builtinUtils, 'managePackages').rejects(operationError);
        sinon.stub(condaUtils, 'managePackages').rejects(operationError);
        sinon.stub(poetryUtils, 'getPoetry').resolves(undefined);
        const showErrorMessage = sinon.stub(windowApis, 'showErrorMessage').resolves(undefined);
        const showErrorMessageWithLogs = sinon.stub(errorUtils, 'showErrorMessageWithLogs').resolves();

        for (const manager of createManagers()) {
            await assert.rejects(
                manager.manage(environment, { install: ['requests'], runHeadless: true }),
            );
        }

        assert.ok(withProgress.notCalled);
        assert.ok(showErrorMessage.notCalled);
        assert.ok(showErrorMessageWithLogs.notCalled);
    });

    test('rejects refresh failures without showing progress or error notifications', async () => {
        const refreshError = new Error('package refresh failed');
        const withProgress = sinon.stub(windowApis, 'withProgress');
        sinon.stub(builtinUtils, 'managePackages').resolves();
        sinon.stub(condaUtils, 'managePackages').resolves();
        sinon
            .stub(
                PoetryPackageManager.prototype as unknown as {
                    runPoetryManage: () => Promise<void>;
                },
                'runPoetryManage',
            )
            .resolves();
        sinon.stub(builtinUtils, 'refreshPipPackages').rejects(refreshError);
        sinon.stub(CondaPackageManager.prototype, 'getPackages').rejects(refreshError);
        sinon.stub(PoetryPackageManager.prototype, 'getPackages').rejects(refreshError);
        sinon.stub(PipPackageManager.prototype, 'getDirectPackageNames').resolves(undefined);
        sinon.stub(PoetryPackageManager.prototype, 'getDirectPackageNames').resolves(undefined);
        const showErrorMessage = sinon.stub(windowApis, 'showErrorMessage').resolves(undefined);
        const showErrorMessageWithLogs = sinon.stub(errorUtils, 'showErrorMessageWithLogs').resolves();

        for (const manager of createManagers()) {
            await assert.rejects(
                manager.manage(environment, { install: ['requests'], runHeadless: true }),
                (error: unknown) => error === refreshError,
            );
        }

        assert.ok(withProgress.notCalled);
        assert.ok(showErrorMessage.notCalled);
        assert.ok(showErrorMessageWithLogs.notCalled);
    });
});
