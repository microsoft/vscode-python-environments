// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { LogOutputChannel, Uri } from 'vscode';
import { EnvironmentManager, PythonEnvironment, PythonEnvironmentApi, PythonEnvironmentInfo } from '../../../api';
import { isUvManagedPythonInstall, refreshPythons, resolveSystemPythonEnvironmentPath } from '../../../managers/builtin/utils';
import * as uvEnvironments from '../../../managers/builtin/uvEnvironments';
import { findVirtualEnvironments, resolveVenvPythonEnvironmentPath } from '../../../managers/builtin/venvUtils';
import {
    NativeEnvInfo,
    NativePythonEnvironmentKind,
    NativePythonFinder,
} from '../../../managers/common/nativePythonFinder';

suite('uv-managed Python installations', () => {
    let tempRoot: string;
    let uvInstall: NativeEnvInfo;
    let uvVenv: NativeEnvInfo;
    let api: PythonEnvironmentApi;
    let log: LogOutputChannel;
    let systemManager: EnvironmentManager;
    let venvManager: EnvironmentManager;

    const executableIn = (prefix: string): string =>
        process.platform === 'win32' ? path.join(prefix, 'python.exe') : path.join(prefix, 'bin', 'python');

    const venvExecutableIn = (prefix: string): string =>
        process.platform === 'win32' ? path.join(prefix, 'Scripts', 'python.exe') : path.join(prefix, 'bin', 'python');

    function finderReturning(envs: NativeEnvInfo[]): NativePythonFinder {
        return {
            refresh: sinon.stub().resolves(envs),
            resolve: sinon.stub().callsFake(async (executable: string) => {
                const found = envs.find((e) => e.executable === executable);
                if (!found) {
                    throw new Error(`unknown executable ${executable}`);
                }
                return found;
            }),
        } as unknown as NativePythonFinder;
    }

    setup(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'uv-managed-install-'));

        // `uv python install` layout: a base interpreter without pyvenv.cfg.
        const installPrefix = path.join(tempRoot, 'uv', 'python', 'cpython-3.13.15-windows-x86_64-none');
        await fs.outputFile(executableIn(installPrefix), '');
        uvInstall = {
            kind: NativePythonEnvironmentKind.venvUv,
            executable: executableIn(installPrefix),
            prefix: installPrefix,
            version: '3.13.15',
        };

        // `uv venv` layout: a virtual environment with pyvenv.cfg.
        const venvPrefix = path.join(tempRoot, 'project', '.venv');
        await fs.outputFile(venvExecutableIn(venvPrefix), '');
        await fs.outputFile(path.join(venvPrefix, 'pyvenv.cfg'), `home = ${installPrefix}\nuv = 0.12.17\n`);
        uvVenv = {
            kind: NativePythonEnvironmentKind.venvUv,
            name: 'project',
            executable: venvExecutableIn(venvPrefix),
            prefix: venvPrefix,
            version: '3.13.15',
        };

        api = {
            createPythonEnvironmentItem: sinon.stub().callsFake(
                (info: PythonEnvironmentInfo, manager: EnvironmentManager): PythonEnvironment => ({
                    ...info,
                    envId: { id: `${manager.name}:${info.environmentPath.fsPath}`, managerId: manager.name },
                }),
            ),
        } as unknown as PythonEnvironmentApi;
        log = {
            error: sinon.stub(),
            warn: sinon.stub(),
            info: sinon.stub(),
        } as unknown as LogOutputChannel;
        systemManager = { name: 'system', log } as unknown as EnvironmentManager;
        venvManager = { name: 'venv', log } as unknown as EnvironmentManager;
        sinon.stub(uvEnvironments, 'addUvEnvironment').resolves();
    });

    teardown(async () => {
        sinon.restore();
        await fs.remove(tempRoot);
    });

    test('identifies a uv-managed installation by the absence of pyvenv.cfg', async () => {
        assert.strictEqual(await isUvManagedPythonInstall(uvInstall), true);
        assert.strictEqual(await isUvManagedPythonInstall(uvVenv), false);
    });

    test('ignores other kinds and environments without a prefix', async () => {
        assert.strictEqual(
            await isUvManagedPythonInstall({ ...uvInstall, kind: NativePythonEnvironmentKind.globalPaths }),
            false,
        );
        assert.strictEqual(await isUvManagedPythonInstall({ ...uvInstall, prefix: undefined }), false);
    });

    test('Global manager lists a uv-managed installation and labels it as uv', async () => {
        const envs = await refreshPythons(false, finderReturning([uvInstall, uvVenv]), api, log, systemManager);

        assert.deepStrictEqual(
            envs.map((e) => e.environmentPath.fsPath),
            [Uri.file(uvInstall.executable!).fsPath],
        );
        assert.strictEqual(envs[0].name, 'Python 3.13.15 (uv)');
    });

    test('venv manager keeps uv virtual environments but skips uv-managed installations', async () => {
        const envs = await findVirtualEnvironments(false, finderReturning([uvInstall, uvVenv]), api, log, venvManager);

        assert.deepStrictEqual(
            envs.map((e) => e.environmentPath.fsPath),
            [Uri.file(uvVenv.executable!).fsPath],
        );
    });

    test('resolving a uv-managed installation by path returns a Global environment', async () => {
        const finder = finderReturning([uvInstall, uvVenv]);

        const install = await resolveVenvPythonEnvironmentPath(
            uvInstall.executable!,
            finder,
            api,
            venvManager,
            systemManager,
        );
        const venv = await resolveVenvPythonEnvironmentPath(uvVenv.executable!, finder, api, venvManager, systemManager);

        assert.strictEqual(install?.envId.managerId, 'system');
        assert.strictEqual(install?.name, 'Python 3.13.15 (uv)');
        assert.strictEqual(venv?.envId.managerId, 'venv');
    });

    test('Global resolver labels only uv-managed installations as uv', async () => {
        const finder = finderReturning([uvInstall, uvVenv]);

        const install = await resolveSystemPythonEnvironmentPath(uvInstall.executable!, finder, api, systemManager);
        const venv = await resolveSystemPythonEnvironmentPath(uvVenv.executable!, finder, api, systemManager);

        assert.strictEqual(install?.shortDisplayName, '3.13.15 (uv)');
        assert.strictEqual(venv?.shortDisplayName, '3.13.15');
    });
});
