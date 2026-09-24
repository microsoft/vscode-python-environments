// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { CancellationError, LogOutputChannel, Uri } from 'vscode';
import { EnvironmentManager, PythonEnvironment, PythonEnvironmentApi } from '../../../api';
import * as windowApis from '../../../common/window.apis';
import { getVenvPythonPath } from '../../../common/utils/virtualEnvironment';
import * as builtinHelpers from '../../../managers/builtin/helpers';
import * as uvEnvironments from '../../../managers/builtin/uvEnvironments';
import { createWithProgress, getBaseInterpreterForVenv } from '../../../managers/builtin/venvUtils';
import { NativePythonEnvironmentKind, NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import * as managerUtils from '../../../managers/common/utils';

suite('createWithProgress uv tracking', () => {
    let addUvEnvironmentStub: sinon.SinonStub;
    let api: PythonEnvironmentApi;
    let baseEnvironment: PythonEnvironment;
    let envPath: string;
    let log: LogOutputChannel;
    let manager: EnvironmentManager;
    let nativeFinder: NativePythonFinder;
    let tempRoot: string;

    setup(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'create-with-progress-'));
        envPath = path.join(tempRoot, 'env');
        const pythonPath = getVenvPythonPath(envPath);
        await fs.outputFile(pythonPath, '');

        baseEnvironment = {
            envId: { id: 'base', managerId: 'ms-python.python:system' },
            name: 'base',
            displayName: 'base',
            displayPath: pythonPath,
            version: '3.12.4',
            environmentPath: Uri.file(pythonPath),
            execInfo: { run: { executable: pythonPath } },
            sysPrefix: tempRoot,
        };
        const createdEnvironment = {
            ...baseEnvironment,
            envId: { id: 'created', managerId: 'ms-python.python:inline-script' },
        };
        api = {
            createPythonEnvironmentItem: sinon.stub().returns(createdEnvironment),
            managePackages: sinon.stub().resolves(),
        } as unknown as PythonEnvironmentApi;
        nativeFinder = {
            resolve: sinon.stub().resolves({
                executable: pythonPath,
                prefix: envPath,
                version: '3.12.4',
                kind: NativePythonEnvironmentKind.venvUv,
            }),
        } as unknown as NativePythonFinder;
        log = {
            error: sinon.stub(),
            info: sinon.stub(),
            append: sinon.stub(),
        } as unknown as LogOutputChannel;
        manager = { log } as EnvironmentManager;

        sinon.stub(windowApis, 'withProgress').callsFake(async (_options, task) => task({} as never, {} as never));
        sinon.stub(builtinHelpers, 'shouldUseUv').resolves(true);
        sinon.stub(builtinHelpers, 'runUV').resolves('');
        sinon.stub(managerUtils, 'getShellActivationCommands').resolves({
            shellActivation: new Map(),
            shellDeactivation: new Map(),
        });
        addUvEnvironmentStub = sinon.stub(uvEnvironments, 'addUvEnvironment').resolves();
    });

    teardown(async () => {
        sinon.restore();
        await fs.remove(tempRoot);
    });

    test('tracks uv environments by default for existing callers', async () => {
        const result = await createWithProgress(
            nativeFinder,
            api,
            log,
            manager,
            baseEnvironment,
            Uri.file(tempRoot),
            envPath,
        );

        assert.ok(result?.environment);
        assert.ok(addUvEnvironmentStub.calledOnce);
    });

    test('skips workspace-scoped uv tracking when explicitly disabled', async () => {
        const result = await createWithProgress(
            nativeFinder,
            api,
            log,
            manager,
            baseEnvironment,
            Uri.file(tempRoot),
            envPath,
            undefined,
            false, // trackUvEnvironment
        );

        assert.ok(result?.environment);
        assert.strictEqual(addUvEnvironmentStub.callCount, 0);
    });

    test('marks cancelled package installation as potentially still mutating', async () => {
        (api.managePackages as sinon.SinonStub).rejects(new CancellationError());

        const result = await createWithProgress(
            nativeFinder,
            api,
            log,
            manager,
            baseEnvironment,
            Uri.file(tempRoot),
            envPath,
            { install: ['requests'], uninstall: [] },
            false, // trackUvEnvironment
        );

        assert.ok(result?.environment);
        assert.strictEqual(typeof result.pkgInstallationErr, 'string');
        assert.strictEqual(result.pkgInstallationCancelled, true);
    });
});

suite('getBaseInterpreterForVenv', () => {
    let tempRoot: string;

    setup(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'base-interp-'));
    });

    teardown(async () => {
        await fs.remove(tempRoot);
    });

    function makeBase(executable: string, sysPrefix: string): PythonEnvironment {
        return {
            envId: { id: 'base', managerId: 'ms-python.python:system' },
            name: 'base',
            displayName: 'base',
            displayPath: executable,
            version: '3.8.20',
            environmentPath: Uri.file(executable),
            execInfo: { run: { executable } },
            sysPrefix,
        } as PythonEnvironment;
    }

    const inPrefixInterpreter = (prefix: string): string =>
        process.platform === 'win32' ? path.join(prefix, 'python.exe') : path.join(prefix, 'bin', 'python');

    test('returns the executable unchanged when it lives inside its own prefix', async () => {
        const executable = inPrefixInterpreter(tempRoot);
        const result = await getBaseInterpreterForVenv(makeBase(executable, tempRoot));
        assert.strictEqual(result, executable);
    });

    test('redirects a shim outside the prefix to the interpreter inside the prefix', async () => {
        const realInterpreter = inPrefixInterpreter(tempRoot);
        await fs.outputFile(realInterpreter, '');
        const shim = path.join(os.tmpdir(), 'shim-bin', 'python3.8.exe');
        const result = await getBaseInterpreterForVenv(makeBase(shim, tempRoot));
        assert.strictEqual(result, realInterpreter);
    });

    test('falls back to the original executable when no interpreter exists in the prefix', async () => {
        const shim = path.join(os.tmpdir(), 'shim-bin', 'python3.8.exe');
        const result = await getBaseInterpreterForVenv(makeBase(shim, tempRoot));
        assert.strictEqual(result, shim);
    });
});
