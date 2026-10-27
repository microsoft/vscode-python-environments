// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { LogOutputChannel, Uri } from 'vscode';
import { EnvironmentChangeKind, PythonEnvironment, PythonEnvironmentApi, PythonProject } from '../../../api';
import * as windowApis from '../../../common/window.apis';
import * as sysCache from '../../../managers/builtin/cache';
import * as pythonInstaller from '../../../managers/builtin/pythonInstaller';
import { SysPythonManager } from '../../../managers/builtin/sysPythonManager';
import * as sysUtils from '../../../managers/builtin/utils';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';

suite('SysPythonManager saved selections', () => {
    const projectUri = Uri.file(path.resolve('project'));
    const interpreter = path.resolve('uv', 'python', 'cpython-3.13.15-windows-x86_64-none', 'python.exe');
    // A saved path that is an alias of the discovered interpreter, like uv's ~/.local/bin launcher.
    const launcher = path.resolve('home', '.local', 'bin', 'python.exe');

    function makeEnv(executable: string): PythonEnvironment {
        return {
            envId: { id: `system:${executable}`, managerId: 'ms-python.python:system' },
            name: 'Python 3.13.15 (uv)',
            displayName: 'Python 3.13.15 (uv)',
            displayPath: executable,
            version: '3.13.15',
            environmentPath: Uri.file(executable),
            sysPrefix: path.dirname(executable),
            execInfo: { run: { executable } },
        };
    }

    function createManager(): SysPythonManager {
        const project = { uri: projectUri } as PythonProject;
        const api = {
            getPythonProject: () => project,
            getPythonProjects: () => [project],
        } as unknown as PythonEnvironmentApi;
        const log = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() } as unknown as LogOutputChannel;
        return new SysPythonManager({} as NativePythonFinder, api, log);
    }

    setup(() => {
        sinon.stub(windowApis, 'withProgress').callsFake(async (_options, task) => task({} as never, {} as never));
        sinon.stub(sysUtils, 'refreshPythons').resolves([makeEnv(interpreter)]);
        sinon.stub(sysCache, 'getSystemEnvForGlobal').resolves(launcher);
        sinon.stub(sysCache, 'getSystemEnvForWorkspace').resolves(launcher);
        // The saved launcher resolves to the interpreter that discovery already listed.
        sinon.stub(sysUtils, 'resolveSystemPythonEnvironmentPath').callsFake(async () => makeEnv(interpreter));
    });

    teardown(() => {
        sinon.restore();
    });

    test('does not duplicate an interpreter when a saved path resolves to a discovered one', async () => {
        const manager = createManager();
        await manager.initialize();

        const envs = await manager.getEnvironments('all');
        assert.strictEqual(envs.length, 1);
        assert.strictEqual(await manager.get(undefined), envs[0]);
        assert.strictEqual(await manager.get(projectUri), envs[0]);
    });

    test('installing an already-installed version reuses the listed interpreter', async () => {
        sinon.stub(pythonInstaller, 'selectAndInstallPython').resolves(interpreter);
        sinon.stub(sysCache, 'setSystemEnvForGlobal').resolves();
        const manager = createManager();
        await manager.initialize();
        const [listed] = await manager.getEnvironments('all');
        const added: unknown[] = [];
        manager.onDidChangeEnvironments((e) => added.push(...e.filter((c) => c.kind === EnvironmentChangeKind.add)));

        const created = await manager.create('global', undefined);

        assert.strictEqual(created, listed);
        assert.strictEqual((await manager.getEnvironments('all')).length, 1);
        assert.strictEqual(added.length, 0);
    });
});
