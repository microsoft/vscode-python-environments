// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { CancellationError, CancellationTokenSource, LogOutputChannel, Uri } from 'vscode';
import { EnvironmentManager, PythonEnvironment, PythonEnvironmentApi } from '../../../api';
import * as windowApis from '../../../common/window.apis';
import { getVenvPythonPath } from '../../../common/utils/virtualEnvironment';
import * as builtinHelpers from '../../../managers/builtin/helpers';
import * as uvEnvironments from '../../../managers/builtin/uvEnvironments';
import { createWithProgress, getBaseInterpreterForVenv, quickCreateVenv } from '../../../managers/builtin/venvUtils';
import * as pipUtils from '../../../managers/builtin/pipUtils';
import { PythonToolError, PythonToolOperation } from '../../../internal/pythonToolSupport';
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
        sinon.stub(builtinHelpers, 'getUvExecutable').resolves(path.join(tempRoot, '.pyprojectx', 'main', 'uv'));
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
        assert.strictEqual(
            (builtinHelpers.runUV as sinon.SinonStub).firstCall.args[5],
            path.join(tempRoot, '.pyprojectx', 'main', 'uv'),
        );
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

    test('private creation forwards cancellation and package work without opening progress UI', async () => {
        const source = new CancellationTokenSource();
        const manage = sinon.stub().resolves();
        const operation: PythonToolOperation = {
            token: source.token,
            managePackages: manage,
            getGlobalEnvironments: async () => [baseEnvironment],
        };
        try {
            const result = await createWithProgress(
                nativeFinder,
                api,
                log,
                manager,
                baseEnvironment,
                Uri.file(tempRoot),
                envPath,
                { install: ['requests'], uninstall: [] },
                false,
                { operation },
            );
            assert.ok(result?.environment);
            assert.strictEqual((builtinHelpers.runUV as sinon.SinonStub).firstCall.args[3], source.token);
            assert.strictEqual(
                (builtinHelpers.runUV as sinon.SinonStub).firstCall.args[5],
                path.join(tempRoot, '.pyprojectx', 'main', 'uv'),
            );
            assert.strictEqual((builtinHelpers.runUV as sinon.SinonStub).firstCall.args[6], true);
            sinon.assert.calledWith(
                builtinHelpers.shouldUseUv as sinon.SinonStub,
                log,
                baseEnvironment.environmentPath.fsPath,
                Uri.file(tempRoot).fsPath,
                source.token,
            );
            assert.ok(manage.calledOnce);
            assert.strictEqual(manage.firstCall.args[1].runHeadless, true);
            assert.ok((api.managePackages as sinon.SinonStub).notCalled);
            assert.ok((windowApis.withProgress as sinon.SinonStub).notCalled);
        } finally {
            source.dispose();
        }
    });

    test('private package failure preserves the created environment rather than returning success', async () => {
        const source = new CancellationTokenSource();
        const operation: PythonToolOperation = {
            token: source.token,
            managePackages: async () => {
                throw new Error('dependency failure');
            },
            getGlobalEnvironments: async () => [baseEnvironment],
        };
        try {
            await assert.rejects(
                createWithProgress(
                    nativeFinder,
                    api,
                    log,
                    manager,
                    baseEnvironment,
                    Uri.file(tempRoot),
                    envPath,
                    { install: ['requests'], uninstall: [] },
                    false,
                    { operation },
                ),
                (error: unknown) =>
                    error instanceof PythonToolError && error.code === 'PACKAGE_INSTALL_FAILED' && !!error.environment,
            );
        } finally {
            source.dispose();
        }
    });

    test('private quick create rejects pyproject validation errors without Continue Anyway', async () => {
        const source = new CancellationTokenSource();
        const operation: PythonToolOperation = {
            token: source.token,
            managePackages: sinon.stub().resolves(),
            getGlobalEnvironments: async () => [baseEnvironment],
        };
        api.getPythonProject = sinon.stub().returns({ name: 'project', uri: Uri.file(tempRoot) });
        sinon.stub(pipUtils, 'getProjectInstallable').resolves({
            installables: [],
            validationError: {
                message: 'Invalid build-system',
                fileUri: Uri.file(path.join(tempRoot, 'pyproject.toml')),
            },
        });
        const question = sinon
            .stub(pipUtils, 'shouldProceedAfterPyprojectValidation')
            .throws(new Error('Unexpected question'));
        try {
            await assert.rejects(
                quickCreateVenv(
                    nativeFinder,
                    api,
                    log,
                    manager,
                    baseEnvironment,
                    Uri.file(tempRoot),
                    undefined,
                    operation,
                ),
                (error: unknown) => error instanceof PythonToolError && error.code === 'INVALID_PROJECT',
            );
            assert.ok(question.notCalled);
        } finally {
            source.dispose();
        }
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
