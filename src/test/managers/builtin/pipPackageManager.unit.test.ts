// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { LogOutputChannel } from 'vscode';
import { PythonEnvironmentApi } from '../../../api';
import * as windowApis from '../../../common/window.apis';
import * as helpers from '../../../managers/builtin/helpers';
import { PipPackageManager } from '../../../managers/builtin/pipPackageManager';
import { VenvManager } from '../../../managers/builtin/venvManager';
import * as packageChanges from '../../../managers/common/packageChanges';
import { createMockLogOutputChannel } from '../../mocks/helper';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

suite('PipPackageManager', () => {
    teardown(() => {
        sinon.restore();
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

    test('uses an uninstall-specific progress title', async () => {
        const withProgressStub = sinon
            .stub(windowApis, 'withProgress')
            .callsFake((_options, task) => task({} as never, {} as never));
        sinon.stub(helpers, 'shouldUseUv').resolves(false);
        sinon.stub(helpers, 'runPython').resolves('');
        sinon.stub(packageChanges, 'updatePackagesAndNotify').resolves([]);
        const environment = createMockPythonEnvironment({
            envPath: path.join(process.cwd(), '.venv'),
            managerId: 'ms-python.python:venv',
        });
        const manager = new PipPackageManager(
            {} as PythonEnvironmentApi,
            createMockLogOutputChannel(),
            {} as VenvManager,
        );

        await manager.manage(environment, { uninstall: ['flask'] });

        assert.strictEqual(withProgressStub.firstCall.args[0].title, 'Uninstalling packages');
    });
});
