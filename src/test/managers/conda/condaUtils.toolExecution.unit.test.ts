// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { WorkspaceConfiguration } from 'vscode';
import * as childProcesses from '../../../common/childProcess.apis';
import * as platformUtils from '../../../common/utils/platformUtils';
import * as workspaceApis from '../../../common/workspace.apis';
import { PythonToolError } from '../../../internal/pythonToolSupport';
import {
    clearCondaCache,
    getCondaForTools,
    runCondaExecutable,
} from '../../../managers/conda/condaUtils';
import { MockChildProcess } from '../../mocks/mockChildProcess';

suite('Conda tool execution', () => {
    let temp: string;
    let condaSetting: string;

    setup(async () => {
        temp = await fs.mkdtemp(path.join(os.tmpdir(), 'conda-tools-'));
        condaSetting = path.join(temp, process.platform === 'win32' ? 'conda.exe' : 'conda');
        await fs.outputFile(condaSetting, '');
        sinon.stub(workspaceApis, 'getConfiguration').returns({
            get: <T>(key: string): T | undefined => (key === 'condaPath' ? (condaSetting as T) : undefined),
        } as WorkspaceConfiguration);
        await clearCondaCache();
    });

    teardown(async () => {
        sinon.restore();
        await clearCondaCache();
        await fs.remove(temp);
    });

    test('spawns the executable directly and preserves package metacharacters as one argument', async () => {
        const child = new MockChildProcess(condaSetting, []);
        const spawn: sinon.SinonStub = sinon.stub(childProcesses, 'spawnProcess');
        spawn.callsFake(() => {
            setImmediate(() => {
                child.stdout?.emit('data', Buffer.from('complete'));
                child.emit('close', 0, null);
            });
            return child;
        });
        const args = ['install', '--yes', 'package" & echo injected & rem "'];

        const output = await runCondaExecutable(args, undefined, undefined, undefined, true);

        assert.strictEqual(output, 'complete');
        assert.strictEqual(spawn.firstCall.args[0], path.resolve(condaSetting));
        assert.deepStrictEqual(spawn.firstCall.args[1], args);
        const options = spawn.firstCall.args[2];
        assert.ok(options);
        assert.strictEqual(options.shell, false);
    });

    test('resolves a Windows command script to the environment conda executable', async () => {
        sinon.stub(platformUtils, 'isWindows').returns(true);
        const root = path.join(temp, 'miniconda');
        condaSetting = path.join(root, 'condabin', 'conda.bat');
        const executable = path.join(root, 'Scripts', 'conda.exe');
        await fs.outputFile(condaSetting, '');
        await fs.outputFile(executable, '');

        const result = await getCondaForTools();

        assert.strictEqual(result, path.resolve(executable));
    });

    test('rejects a Windows command script when no safe executable launcher exists', async () => {
        sinon.stub(platformUtils, 'isWindows').returns(true);
        condaSetting = path.join(temp, 'condabin', 'conda.bat');
        await fs.outputFile(condaSetting, '');

        await assert.rejects(
            getCondaForTools(),
            (error: unknown) =>
                error instanceof PythonToolError &&
                error.code === 'CONDA_EXECUTABLE_NOT_FOUND' &&
                error.message.includes('python.condaPath'),
        );
    });
});
