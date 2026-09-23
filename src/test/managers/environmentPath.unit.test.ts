import assert from 'node:assert';
import * as path from 'node:path';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import {
    EnvironmentManager,
    PythonEnvironment,
    PythonEnvironmentApi,
    PythonEnvironmentInfo,
} from '../../api';
import { NativeEnvInfo } from '../../managers/common/nativePythonFinder';
import * as managerUtils from '../../managers/common/utils';
import { nativeToPythonEnv as pipenvNativeToPythonEnv } from '../../managers/pipenv/pipenvUtils';
import { nativeToPythonEnv as poetryNativeToPythonEnv } from '../../managers/poetry/poetryUtils';
import { nativeToPythonEnv as pyenvNativeToPythonEnv } from '../../managers/pyenv/pyenvUtils';

suite('Manager environmentPath', () => {
    const prefix = path.join(path.sep, 'test', 'environment');
    const executable = path.join(
        prefix,
        process.platform === 'win32' ? 'Scripts' : 'bin',
        process.platform === 'win32' ? 'python.exe' : 'python',
    );
    const nativeInfo: NativeEnvInfo = {
        prefix,
        executable,
        version: '3.12.0',
        name: 'test-environment',
        project: path.dirname(prefix),
    };
    const manager = {} as EnvironmentManager;
    let capturedInfo: PythonEnvironmentInfo | undefined;
    let originalPoetryInProject: string | undefined;

    const api = {
        createPythonEnvironmentItem: (info: PythonEnvironmentInfo) => {
            capturedInfo = info;
            return { ...info, envId: { id: 'test-id', managerId: 'test-manager' } } as PythonEnvironment;
        },
    } as unknown as PythonEnvironmentApi;

    setup(() => {
        capturedInfo = undefined;
        originalPoetryInProject = process.env.POETRY_VIRTUALENVS_IN_PROJECT;
        process.env.POETRY_VIRTUALENVS_IN_PROJECT = 'true';
        sinon.stub(managerUtils, 'getShellActivationCommands').resolves({
            shellActivation: new Map(),
            shellDeactivation: new Map(),
        });
    });

    teardown(() => {
        sinon.restore();
        if (originalPoetryInProject === undefined) {
            delete process.env.POETRY_VIRTUALENVS_IN_PROJECT;
        } else {
            process.env.POETRY_VIRTUALENVS_IN_PROJECT = originalPoetryInProject;
        }
    });

    const converters: {
        name: string;
        convert: () => PythonEnvironment | undefined | Promise<PythonEnvironment | undefined>;
    }[] = [
        {
            name: 'Pipenv',
            convert: () => pipenvNativeToPythonEnv(nativeInfo, api, manager),
        },
        {
            name: 'Poetry',
            convert: () => poetryNativeToPythonEnv(nativeInfo, api, manager, path.join(path.sep, 'tools', 'poetry')),
        },
        {
            name: 'pyenv',
            convert: () =>
                pyenvNativeToPythonEnv(
                    nativeInfo,
                    api,
                    manager,
                    path.join(path.sep, 'tools', 'pyenv', 'bin', 'pyenv'),
                ),
        },
    ];

    converters.forEach(({ name, convert }) => {
        test(`${name} uses the Python executable`, async () => {
            await convert();

            assert.ok(capturedInfo);
            assert.strictEqual(capturedInfo.environmentPath.fsPath, Uri.file(executable).fsPath);
        });
    });
});
