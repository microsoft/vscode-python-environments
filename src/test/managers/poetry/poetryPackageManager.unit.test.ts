// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { LogOutputChannel, Uri } from 'vscode';
import { PythonEnvironmentApi } from '../../../api';
import * as windowApis from '../../../common/window.apis';
import * as packageChanges from '../../../managers/common/packageChanges';
import { PoetryPackageManager } from '../../../managers/poetry/poetryPackageManager';
import { PoetryManager } from '../../../managers/poetry/poetryManager';
import * as poetryUtils from '../../../managers/poetry/poetryUtils';
import * as runPoetryModule from '../../../managers/poetry/commands/runPoetry';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

suite('PoetryPackageManager', () => {
    const environment = createMockPythonEnvironment({
        envPath: path.join(process.cwd(), '.venv'),
        managerId: 'ms-python.python:poetry',
    });
    let runPoetryStub: sinon.SinonStub;
    let manager: PoetryPackageManager;

    setup(() => {
        const api = {
            getPythonProjects: () => [
                {
                    name: 'project',
                    uri: Uri.file(path.join(process.cwd(), 'project', 'pyproject.toml')),
                },
            ],
        } as unknown as PythonEnvironmentApi;
        const log = {
            append: sinon.stub(),
            error: sinon.stub(),
            info: sinon.stub(),
            show: sinon.stub(),
        } as unknown as LogOutputChannel;

        sinon.stub(poetryUtils, 'getPoetry').resolves('poetry');
        sinon.stub(windowApis, 'withProgress').callsFake((_options, task) => task({} as never, {} as never));
        sinon.stub(packageChanges, 'updatePackagesAndNotify').resolves([]);
        runPoetryStub = sinon.stub(runPoetryModule, 'runPoetry').resolves('');
        manager = new PoetryPackageManager(api, log, {} as PoetryManager);
    });

    teardown(() => {
        manager.dispose();
        sinon.restore();
    });

    test('package management inherits the process working directory', async () => {
        await manager.manage(environment, { install: ['requests'], uninstall: ['flask'] });

        assert.strictEqual(runPoetryStub.callCount, 2);
        assert.strictEqual(runPoetryStub.firstCall.args[1], undefined);
        assert.strictEqual(runPoetryStub.secondCall.args[1], undefined);
    });

    test('direct package listing inherits the process working directory', async () => {
        await manager.getDirectPackageNames(environment);

        assert.strictEqual(runPoetryStub.callCount, 1);
        assert.strictEqual(runPoetryStub.firstCall.args[1], undefined);
    });
});
