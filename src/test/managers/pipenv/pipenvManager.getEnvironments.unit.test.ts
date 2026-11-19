// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi } from '../../../api';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { PipenvManager } from '../../../managers/pipenv/pipenvManager';

suite('PipenvManager getEnvironments', () => {
    teardown(() => {
        sinon.restore();
    });

    test('does not report Pipenv virtual environments as global base interpreters', async () => {
        const manager = new PipenvManager({} as NativePythonFinder, {} as PythonEnvironmentApi);
        const environment = {
            envId: { id: 'pipenv', managerId: 'ms-python.python:pipenv' },
            environmentPath: Uri.file(path.join(process.cwd(), '.venv')),
        } as PythonEnvironment;
        const state = manager as unknown as { collection: PythonEnvironment[] };
        state.collection = [environment];
        sinon.stub(manager, 'initialize').resolves();

        assert.deepStrictEqual(await manager.getEnvironments('all'), [environment]);
        assert.deepStrictEqual(await manager.getEnvironments('global'), []);
    });
});
