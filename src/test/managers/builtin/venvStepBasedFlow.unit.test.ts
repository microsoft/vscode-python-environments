// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { CancellationError, LogOutputChannel, Uri } from 'vscode';
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

    test('Quick Create cancellation stops before validation prompts or environment creation', async () => {
        sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async (items) =>
            items.find((item) => item.label === VenvManagerStrings.quickCreate),
        );
        sinon.stub(pipUtils, 'getProjectInstallable').rejects(new CancellationError());
        const preflight = sinon
            .stub(pipUtils, 'shouldProceedAfterPyprojectValidation')
            .throws(new Error('Unexpected validation prompt'));

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
        assert.ok(preflight.notCalled);
        assert.ok(createWithProgress.notCalled);
        assert.strictEqual(await fs.pathExists(path.join(tempRoot, '.venv')), false);
    });

    test('configurable creation cancellation stops before further prompts or environment creation', async () => {
        const quickPick = sinon.stub(windowApis, 'showQuickPickWithButtons');
        quickPick.onFirstCall().callsFake(async (items) =>
            items.find((item) => item.label === VenvManagerStrings.customize),
        );
        quickPick.onSecondCall().callsFake(async (items) => items[0]);
        sinon.stub(windowApis, 'showInputBoxWithButtons').resolves('.custom-venv');
        sinon.stub(pipUtils, 'getWorkspacePackagesToInstall').rejects(new CancellationError());
        sinon.stub(pipUtils, 'getProjectInstallable').throws(new Error('Quick Create preflight was unexpected'));
        sinon
            .stub(pipUtils, 'shouldProceedAfterPyprojectValidation')
            .throws(new Error('Unexpected validation prompt'));

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
        assert.strictEqual(quickPick.callCount, 2);
        assert.ok(createWithProgress.notCalled);
        assert.strictEqual(await fs.pathExists(path.join(tempRoot, '.custom-venv')), false);
    });

    test('Quick Create still creates an environment after a successful empty search', async () => {
        sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async (items) =>
            items.find((item) => item.label === VenvManagerStrings.quickCreate),
        );
        sinon.stub(pipUtils, 'getProjectInstallable').resolves({ installables: [], validationErrors: [] });
        const preflight = sinon.stub(pipUtils, 'shouldProceedAfterPyprojectValidation').resolves(true);
        const created = createMockPythonEnvironment({
            name: '.venv',
            envPath: path.join(tempRoot, '.venv', 'python.exe'),
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
            { showQuickAndCustomOptions: true, additionalPackages: ['pytest'] },
        );

        assert.strictEqual(result?.environment, created);
        assert.ok(preflight.calledOnceWithExactly([], { allPyprojectTomlsSelected: true }));
        assert.deepStrictEqual(createWithProgress.firstCall.args[7], {
            install: ['pytest'],
            uninstall: [],
        });
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

    test('Quick Create uses an interpreter that satisfies pyproject requires-python', async () => {
        await fs.outputFile(
            path.join(tempRoot, 'pyproject.toml'),
            '[project]\nname = "demo"\nversion = "0.0.1"\nrequires-python = ">=3.10,<3.12"\n',
        );
        const incompatible = createMockPythonEnvironment({
            name: 'Python 3.13',
            envPath: path.join(tempRoot, 'base', 'python3.13'),
            version: '3.13.1',
        });
        const compatible = createMockPythonEnvironment({
            name: 'Python 3.11',
            envPath: path.join(tempRoot, 'base', 'python3.11'),
            version: '3.11.5',
        });
        const quickPick = sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async (items) =>
            items.find((item) => item.label === VenvManagerStrings.quickCreate),
        );
        sinon.stub(pipUtils, 'getProjectInstallable').resolves({ installables: [], validationErrors: [] });
        sinon.stub(pipUtils, 'shouldProceedAfterPyprojectValidation').resolves(true);
        createWithProgress.resolves({ environment: compatible });

        const result = await createStepBasedVenvFlow(
            {} as NativePythonFinder,
            api,
            log,
            manager,
            [incompatible, baseEnvironment, compatible],
            Uri.file(tempRoot),
            { showQuickAndCustomOptions: true },
        );

        assert.strictEqual(result?.environment, compatible);
        assert.strictEqual(createWithProgress.firstCall.args[4], compatible);
        const quickCreateItem = quickPick.firstCall.args[0].find(
            (item: { label: string }) => item.label === VenvManagerStrings.quickCreate,
        );
        assert.ok(quickCreateItem);
        const detail = quickCreateItem.detail;
        assert.strictEqual(
            detail,
            'Uses Python version 3.11.5 to satisfy requires-python >=3.10,<3.12 and installs workspace dependencies.',
        );
    });

    test('custom creation offers only interpreters that satisfy requires-python >3.10', async () => {
        await fs.outputFile(
            path.join(tempRoot, 'pyproject.toml'),
            '[project]\nname = "demo"\nversion = "0.0.1"\nrequires-python = ">3.10"\n',
        );
        const tooOld = createMockPythonEnvironment({
            name: 'Python 3.10.0',
            envPath: path.join(tempRoot, 'base', 'python3.10.0'),
            version: '3.10.0',
        });
        const patch = createMockPythonEnvironment({
            name: 'Python 3.10.1',
            envPath: path.join(tempRoot, 'base', 'python3.10.1'),
            version: '3.10.1',
        });
        const newest = createMockPythonEnvironment({
            name: 'Python 3.12',
            envPath: path.join(tempRoot, 'base', 'python3.12'),
            version: '3.12.0',
        });
        const quickPick = sinon.stub(windowApis, 'showQuickPickWithButtons');
        quickPick.onFirstCall().callsFake(async (items) =>
            items.find((item) => item.label === VenvManagerStrings.customize),
        );
        let offered: string[] = [];
        quickPick.onSecondCall().callsFake(async (items, options) => {
            offered = items.map((item) => (item as unknown as { e: { version: string } }).e.version);
            assert.strictEqual(
                options?.placeHolder,
                'Select a Python interpreter that satisfies requires-python >3.10',
            );
            return items[0];
        });
        sinon.stub(windowApis, 'showInputBoxWithButtons').resolves('.custom-venv');
        sinon.stub(pipUtils, 'getWorkspacePackagesToInstall').resolves({ install: [], uninstall: [] });
        createWithProgress.resolves({ environment: newest });

        await createStepBasedVenvFlow(
            {} as NativePythonFinder,
            api,
            log,
            manager,
            [tooOld, patch, newest],
            Uri.file(tempRoot),
            { showQuickAndCustomOptions: true },
        );

        assert.deepStrictEqual(offered, ['3.12.0', '3.10.1']);
        assert.strictEqual(createWithProgress.firstCall.args[4], newest);
    });

    test('creation still offers every Python 3 interpreter when none satisfy requires-python', async () => {
        await fs.outputFile(
            path.join(tempRoot, 'pyproject.toml'),
            '[project]\nname = "demo"\nversion = "0.0.1"\nrequires-python = ">=3.13"\n',
        );
        const older = createMockPythonEnvironment({
            name: 'Python 3.9',
            envPath: path.join(tempRoot, 'base', 'python3.9'),
            version: '3.9.7',
        });
        sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async (items) =>
            items.find((item) => item.label === VenvManagerStrings.quickCreate),
        );
        sinon.stub(pipUtils, 'getProjectInstallable').resolves({ installables: [], validationErrors: [] });
        sinon.stub(pipUtils, 'shouldProceedAfterPyprojectValidation').resolves(true);
        createWithProgress.resolves({ environment: baseEnvironment });

        await createStepBasedVenvFlow(
            {} as NativePythonFinder,
            api,
            log,
            manager,
            [older, baseEnvironment],
            Uri.file(tempRoot),
            { showQuickAndCustomOptions: true },
        );

        assert.strictEqual(createWithProgress.firstCall.args[4], baseEnvironment);
        assert.ok(
            (log.warn as sinon.SinonStub).calledWith(
                'No Python interpreter satisfies requires-python >=3.13. Offering every Python 3 interpreter.',
            ),
        );
    });
});
