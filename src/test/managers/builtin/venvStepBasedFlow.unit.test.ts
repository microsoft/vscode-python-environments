// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { LogOutputChannel, Uri } from 'vscode';
import { EnvironmentManager, PythonEnvironmentApi, PythonProject } from '../../../api';
import { VenvManagerStrings } from '../../../common/localize';
import * as telemetry from '../../../common/telemetry/sender';
import * as windowApis from '../../../common/window.apis';
import * as pipUtils from '../../../managers/builtin/pipUtils';
import { createStepBasedVenvFlow } from '../../../managers/builtin/venvStepBasedFlow';
import * as venvUtils from '../../../managers/builtin/venvUtils';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

suite('step-based venv creation pyproject preflight', () => {
    let api: PythonEnvironmentApi;
    let baseEnvironment: ReturnType<typeof createMockPythonEnvironment>;
    let createWithProgress: sinon.SinonStub;
    let log: LogOutputChannel;
    let manager: EnvironmentManager;
    let project: PythonProject;
    let tempRoot: string;

    setup(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'venv-step-pyproject-'));
        project = { name: 'project', uri: Uri.file(tempRoot) };
        baseEnvironment = createMockPythonEnvironment({
            name: 'Python 3.12',
            envPath: path.join(tempRoot, 'base', 'python.exe'),
            version: '3.12.0',
        });
        api = {
            getPythonProject: sinon.stub().returns(project),
        } as unknown as PythonEnvironmentApi;
        log = { error: sinon.stub(), info: sinon.stub(), warn: sinon.stub() } as unknown as LogOutputChannel;
        manager = { log } as EnvironmentManager;
        sinon.stub(telemetry, 'sendTelemetryEvent');
        createWithProgress = sinon.stub(venvUtils, 'createWithProgress');
    });

    teardown(async () => {
        sinon.restore();
        await fs.remove(tempRoot);
    });

    test('Quick Create stops before creating an environment when preflight is rejected', async () => {
        sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async (items) =>
            items.find((item) => item.label === VenvManagerStrings.quickCreate),
        );
        const validationError = {
            message: 'Could not read or parse pyproject.toml',
            fileUri: Uri.file(path.join(tempRoot, 'pyproject.toml')),
        };
        sinon.stub(pipUtils, 'getProjectInstallable').resolves({
            installables: [],
            validationErrors: [validationError],
        });
        const preflight = sinon.stub(pipUtils, 'shouldProceedAfterPyprojectValidation').resolves(false);

        const result = await createStepBasedVenvFlow(
            {} as NativePythonFinder,
            api,
            log,
            manager,
            [baseEnvironment],
            Uri.file(tempRoot),
            { showQuickAndCustomOptions: true },
        );

        assert.strictEqual(result, undefined);
        assert.ok(preflight.calledOnceWithExactly([validationError], { allPyprojectTomlsSelected: true }));
        assert.ok(createWithProgress.notCalled);
        assert.strictEqual(await fs.pathExists(path.join(tempRoot, '.venv')), false);
    });

    test('configurable creation can skip workspace dependencies and still create the environment', async () => {
        const quickPick = sinon.stub(windowApis, 'showQuickPickWithButtons');
        quickPick.onFirstCall().callsFake(async (items) =>
            items.find((item) => item.label === VenvManagerStrings.customize),
        );
        quickPick.onSecondCall().callsFake(async (items) => items[0]);
        sinon.stub(windowApis, 'showInputBoxWithButtons').resolves('.custom-venv');
        sinon.stub(pipUtils, 'getWorkspacePackagesToInstall').resolves({ install: [], uninstall: [] });
        sinon.stub(pipUtils, 'getProjectInstallable').throws(new Error('Quick Create preflight was unexpected'));
        sinon
            .stub(pipUtils, 'shouldProceedAfterPyprojectValidation')
            .throws(new Error('Unselected pyproject.toml was validated'));
        const created = createMockPythonEnvironment({
            name: '.custom-venv',
            envPath: path.join(tempRoot, '.custom-venv', 'python.exe'),
            version: '3.12.0',
        });
        createWithProgress.resolves({ environment: created });

        const result = await createStepBasedVenvFlow(
            {} as NativePythonFinder,
            api,
            log,
            manager,
            [baseEnvironment],
            Uri.file(tempRoot),
            { showQuickAndCustomOptions: true },
        );

        assert.strictEqual(result?.environment, created);
        assert.ok(createWithProgress.calledOnce);
        assert.deepStrictEqual(createWithProgress.firstCall.args[7], { install: [], uninstall: [] });
    });
});
