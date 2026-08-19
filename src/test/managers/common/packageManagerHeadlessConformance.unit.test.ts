// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { LogOutputChannel, Uri } from 'vscode';
import { PackageManager, PythonEnvironment, PythonEnvironmentApi } from '../../../api';
import * as childProcessApis from '../../../common/childProcess.apis';
import * as errorUtils from '../../../common/errors/utils';
import * as windowApis from '../../../common/window.apis';
import * as workspaceApis from '../../../common/workspace.apis';
import { PipPackageManager } from '../../../managers/builtin/pipPackageManager';
import * as pipUtils from '../../../managers/builtin/pipUtils';
import * as builtinUtils from '../../../managers/builtin/utils';
import * as uvEnvironments from '../../../managers/builtin/uvEnvironments';
import { VenvManager } from '../../../managers/builtin/venvManager';
import { CondaPackageManager } from '../../../managers/conda/condaPackageManager';
import * as condaUtils from '../../../managers/conda/condaUtils';
import { PoetryManager } from '../../../managers/poetry/poetryManager';
import { PoetryPackageManager } from '../../../managers/poetry/poetryPackageManager';
import * as poetryUtils from '../../../managers/poetry/poetryUtils';
import { MockChildProcess } from '../../mocks/mockChildProcess';

suite('Package manager headless conformance', () => {
    const environment = {
        envId: { id: 'test-environment', managerId: 'test-manager' },
        environmentPath: Uri.joinPath(Uri.file(__dirname), 'path', 'to', 'environment'),
        execInfo: { run: { executable: 'python', args: [] } },
        version: '3.12.0',
    } as unknown as PythonEnvironment;

    teardown(() => {
        sinon.restore();
    });

    test('does not invoke interactive package input when no packages are provided', async () => {
        const pipPicker = sinon.stub(pipUtils, 'getWorkspacePackagesToInstall');
        const condaPicker = sinon.stub(condaUtils, 'getCommonCondaPackagesToInstall');
        const poetryInput = sinon.stub(windowApis, 'showInputBox');

        for (const manager of createManagers().all) {
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
        sinon.stub(poetryUtils, 'getPoetry').resolves('poetry');
        sinon.stub(childProcessApis, 'spawnProcess').callsFake(() => {
            const process = new MockChildProcess('poetry', ['add', 'requests']);
            setImmediate(() => process.emit('error', operationError));
            return process as unknown as ReturnType<typeof childProcessApis.spawnProcess>;
        });
        const showErrorMessage = sinon.stub(windowApis, 'showErrorMessage').resolves(undefined);
        const showErrorMessageWithLogs = sinon.stub(errorUtils, 'showErrorMessageWithLogs').resolves();

        for (const manager of createManagers().all) {
            await assert.rejects(
                manager.manage(environment, { install: ['requests'], runHeadless: true }),
                (error: unknown) => error === operationError,
            );
        }
        await flushImmediate();

        assert.ok(withProgress.notCalled);
        assert.ok(showErrorMessage.notCalled);
        assert.ok(showErrorMessageWithLogs.notCalled);
    });

    test('suppresses Pip refresh failures without showing progress or error notifications', async () => {
        const withProgress = sinon.stub(windowApis, 'withProgress');
        sinon.stub(builtinUtils, 'managePackages').resolves();
        sinon.stub(uvEnvironments, 'getUvEnvironments').resolves([]);
        sinon.stub(workspaceApis, 'getConfiguration').returns({
            get: sinon.stub().withArgs('alwaysUseUv').returns(false),
        } as unknown as ReturnType<typeof workspaceApis.getConfiguration>);
        const spawnProcess = sinon.stub(childProcessApis, 'spawnProcess').callsFake(() => {
            const process = new MockChildProcess('python', ['-m', 'pip', 'list']);
            setImmediate(() => {
                process.emit('exit', 1, null);
                process.emit('close', 1, null);
            });
            return process as unknown as ReturnType<typeof childProcessApis.spawnProcess>;
        });
        sinon.stub(PipPackageManager.prototype, 'getDirectPackageNames').resolves(undefined);
        const showErrorMessage = sinon.stub(windowApis, 'showErrorMessage').resolves(undefined);
        const showErrorMessageWithLogs = sinon.stub(errorUtils, 'showErrorMessageWithLogs').resolves();
        const manager = createManagers().pip;

        await manager.manage(environment, { install: ['requests'], runHeadless: true });
        await flushImmediate();

        assert.ok(spawnProcess.called);
        assert.ok(withProgress.notCalled);
        assert.ok(showErrorMessage.notCalled);
        assert.ok(showErrorMessageWithLogs.notCalled);
    });

    test('rejects Conda refresh failures without showing progress or error notifications', async () => {
        const refreshError = new Error('package refresh failed');
        const withProgress = sinon.stub(windowApis, 'withProgress');
        sinon.stub(condaUtils, 'managePackages').resolves();
        sinon.stub(condaUtils, 'runCondaExecutable').rejects(refreshError);
        const showErrorMessage = sinon.stub(windowApis, 'showErrorMessage').resolves(undefined);
        const showErrorMessageWithLogs = sinon.stub(errorUtils, 'showErrorMessageWithLogs').resolves();
        const manager = createManagers().conda;

        await assert.rejects(
            manager.manage(environment, { install: ['requests'], runHeadless: true }),
            (error: unknown) => error === refreshError,
        );
        await flushImmediate();

        assert.ok(withProgress.notCalled);
        assert.ok(showErrorMessage.notCalled);
        assert.ok(showErrorMessageWithLogs.notCalled);
    });

    test('suppresses Poetry refresh failures without showing progress or error notifications', async () => {
        const refreshError = new Error('package refresh failed');
        const withProgress = sinon.stub(windowApis, 'withProgress');
        sinon.stub(poetryUtils, 'getPoetry').resolves('poetry');
        sinon.stub(PoetryPackageManager.prototype, 'getDirectPackageNames').resolves(undefined);
        const spawnProcess = sinon.stub(childProcessApis, 'spawnProcess').callsFake((_command, args) => {
            const process = new MockChildProcess('poetry', args);
            setImmediate(() => {
                if (args[0] === 'add') {
                    process.emit('close', 0, null);
                } else {
                    process.emit('error', refreshError);
                }
            });
            return process as unknown as ReturnType<typeof childProcessApis.spawnProcess>;
        });
        const showErrorMessage = sinon.stub(windowApis, 'showErrorMessage').resolves(undefined);
        const showErrorMessageWithLogs = sinon.stub(errorUtils, 'showErrorMessageWithLogs').resolves();
        const manager = createManagers().poetry;

        await manager.manage(environment, { install: ['requests'], runHeadless: true });
        await flushImmediate();

        assert.strictEqual(spawnProcess.callCount, 2);
        assert.ok(withProgress.notCalled);
        assert.ok(showErrorMessage.notCalled);
        assert.ok(showErrorMessageWithLogs.notCalled);
    });

    function createManagers(): {
        pip: PackageManager;
        conda: PackageManager;
        poetry: PackageManager;
        all: PackageManager[];
    } {
        const api = {
            createPackageItem: sinon.stub(),
            getPythonProjects: sinon.stub().returns([]),
        } as unknown as PythonEnvironmentApi;
        const log = {
            append: sinon.stub(),
            error: sinon.stub(),
            info: sinon.stub(),
            show: sinon.stub(),
        } as unknown as LogOutputChannel;
        const pip = new PipPackageManager(api, log, {
            getProjectsByEnvironment: sinon.stub().returns([]),
        } as unknown as VenvManager);
        const conda = new CondaPackageManager(api, log);
        const poetry = new PoetryPackageManager(api, log, {} as PoetryManager);
        return { pip, conda, poetry, all: [pip, conda, poetry] };
    }

    async function flushImmediate(): Promise<void> {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
});
