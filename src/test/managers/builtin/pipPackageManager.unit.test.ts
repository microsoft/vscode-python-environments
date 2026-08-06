// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { LogOutputChannel } from 'vscode';
import { PythonEnvironmentApi } from '../../../api';
import * as helpers from '../../../managers/builtin/helpers';
import { PipPackageManager } from '../../../managers/builtin/pipPackageManager';
import { VenvManager } from '../../../managers/builtin/venvManager';
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
});
