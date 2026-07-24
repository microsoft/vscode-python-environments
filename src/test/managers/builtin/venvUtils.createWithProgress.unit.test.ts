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
import { createWithProgress } from '../../../managers/builtin/venvUtils';
import { NativePythonEnvironmentKind, NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import * as managerUtils from '../../../managers/common/utils';

suite('createWithProgress uv tracking options', () => {
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
            { trackUvEnvironment: false },
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
            { trackUvEnvironment: false },
        );

        assert.ok(result?.environment);
        assert.strictEqual(typeof result.pkgInstallationErr, 'string');
        assert.strictEqual(result.pkgInstallationCancelled, true);
    });
});
