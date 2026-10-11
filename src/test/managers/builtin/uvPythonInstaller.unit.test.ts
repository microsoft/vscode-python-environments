import assert from 'assert';
import os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { CancellationToken, LogOutputChannel, ShellExecution, TaskExecution, TaskProcessEndEvent } from 'vscode';
import * as childProcessApis from '../../../common/childProcess.apis';
import { Common, UvInstallStrings } from '../../../common/localize';
import * as persistentState from '../../../common/persistentState';
import { EventNames } from '../../../common/telemetry/constants';
import * as telemetrySender from '../../../common/telemetry/sender';
import * as taskApis from '../../../common/tasks.apis';
import * as windowApis from '../../../common/window.apis';
import * as platformUtils from '../../../common/utils/platformUtils';
import * as helpers from '../../../managers/builtin/helpers';
import {
    clearDontAskAgain,
    ensureUvForInlineScriptVersionLookupDetailed,
    ensureUvForInlineScriptVersionLookup,
    getAvailablePythonVersions,
    getUvPythonPath,
    isDontAskAgainSet,
    installPythonWithUv,
    installUv,
    promptInstallPythonViaUvDetailed,
    promptInstallPythonViaUv,
    UV_INSTALL_PYTHON_DONT_ASK_KEY,
    UvPythonVersion,
} from '../../../managers/builtin/uvPythonInstaller';
import { createMockLogOutputChannel } from '../../mocks/helper';
import { MockChildProcess } from '../../mocks/mockChildProcess';

suite('uvPythonInstaller - promptInstallPythonViaUv', () => {
    let mockLog: LogOutputChannel;
    let isUvInstalledStub: sinon.SinonStub;
    let showErrorMessageStub: sinon.SinonStub;
    let showInformationMessageStub: sinon.SinonStub;
    let sendTelemetryEventStub: sinon.SinonStub;
    let mockState: { get: sinon.SinonStub; set: sinon.SinonStub; clear: sinon.SinonStub };

    setup(() => {
        helpers.setUvExecutable('uv');
        mockLog = createMockLogOutputChannel();

        mockState = {
            get: sinon.stub(),
            set: sinon.stub().resolves(),
            clear: sinon.stub().resolves(),
        };
        sinon.stub(persistentState, 'getGlobalPersistentState').resolves(mockState);
        isUvInstalledStub = sinon.stub(helpers, 'isUvInstalled');
        sinon.stub(helpers, 'getUvExecutable').resolves('uv');
        showErrorMessageStub = sinon.stub(windowApis, 'showErrorMessage');
        showInformationMessageStub = sinon.stub(windowApis, 'showInformationMessage');
        sendTelemetryEventStub = sinon.stub(telemetrySender, 'sendTelemetryEvent');
    });

    teardown(() => {
        sinon.restore();
        helpers.setUvExecutable('uv');
    });

    function stubUvInstallTask(exitCode: number | undefined): sinon.SinonStub {
        let taskEndListener: ((event: TaskProcessEndEvent) => unknown) | undefined;
        sinon.stub(taskApis, 'onDidEndTaskProcess').callsFake((listener) => {
            taskEndListener = listener;
            return { dispose: () => undefined };
        });
        const executeTaskStub = sinon.stub(taskApis, 'executeTask').callsFake(async (task) => {
            const execution = { task, terminate: () => undefined } as TaskExecution;
            setImmediate(() => taskEndListener?.({ execution, exitCode } as TaskProcessEndEvent));
            return execution;
        });

        const commandCheck = new MockChildProcess('curl', ['--version']);
        const spawnStub: sinon.SinonStub = sinon.stub(childProcessApis, 'spawnProcess');
        spawnStub.returns(commandCheck);
        setImmediate(() => commandCheck.emit('exit', 0, null));
        return executeTaskStub;
    }

    test('should report available from the detailed uv lookup API', async () => {
        isUvInstalledStub.resolves(true);

        const result = await ensureUvForInlineScriptVersionLookupDetailed('>=3.13,<3.14', mockLog);

        assert.strictEqual(result, 'available');
        assert(showInformationMessageStub.notCalled, 'Should not prompt when uv is already available');
    });

    test('should return undefined when "Don\'t ask again" is set', async () => {
        mockState.get.resolves(true);

        const result = await promptInstallPythonViaUv('activation', mockLog);

        assert.strictEqual(result, undefined);
        assert(showInformationMessageStub.notCalled, 'Should not show message when dont ask again is set');
        assert(sendTelemetryEventStub.notCalled, 'Should not send telemetry when skipping prompt');
    });

    test('should show correct prompt when uv is installed', async () => {
        mockState.get.resolves(false);
        isUvInstalledStub.resolves(true);
        showInformationMessageStub.resolves(undefined); // User dismissed

        await promptInstallPythonViaUv('activation', mockLog);

        assert(
            showInformationMessageStub.calledWith(
                UvInstallStrings.installPythonPrompt,
                { modal: true },
                UvInstallStrings.installPython,
                Common.dontAskAgain,
            ),
            'Should show install Python prompt when uv is installed',
        );
    });

    test('should report a declined detailed uv lookup distinctly from the boolean wrapper', async () => {
        isUvInstalledStub.resolves(false);
        showInformationMessageStub.resolves(undefined);

        const result = await ensureUvForInlineScriptVersionLookupDetailed('>=3.13,<3.14', mockLog);

        assert.strictEqual(result, 'declined');
    });

    test('should show correct prompt when uv is NOT installed', async () => {
        mockState.get.resolves(false);
        isUvInstalledStub.resolves(false);
        showInformationMessageStub.resolves(undefined); // User dismissed

        await promptInstallPythonViaUv('activation', mockLog);

        assert(
            showInformationMessageStub.calledWith(
                UvInstallStrings.installPythonAndUvPrompt,
                { modal: true },
                UvInstallStrings.installUvAndPython,
                Common.dontAskAgain,
            ),
            'Should show install Python AND uv prompt when uv is not installed',
        );
    });

    test('should set persistent state when user clicks "Don\'t ask again"', async () => {
        mockState.get.resolves(false);
        isUvInstalledStub.resolves(true);
        showInformationMessageStub.resolves(Common.dontAskAgain);

        const result = await promptInstallPythonViaUv('activation', mockLog);

        assert.strictEqual(result, undefined);
        assert(mockState.set.calledWith(UV_INSTALL_PYTHON_DONT_ASK_KEY, true), 'Should set dont ask flag');
    });

    test('should return undefined when user dismisses the dialog', async () => {
        mockState.get.resolves(false);
        isUvInstalledStub.resolves(true);
        showInformationMessageStub.resolves(undefined); // User dismissed

        const result = await promptInstallPythonViaUv('activation', mockLog);

        assert.strictEqual(result, undefined);
    });

    test('should send telemetry with correct trigger', async () => {
        mockState.get.resolves(false);
        isUvInstalledStub.resolves(true);
        showInformationMessageStub.resolves(undefined);

        await promptInstallPythonViaUv('createEnvironment', mockLog);

        assert(
            sendTelemetryEventStub.calledWith(EventNames.UV_PYTHON_INSTALL_PROMPTED, undefined, {
                trigger: 'createEnvironment',
            }),
            'Should send telemetry with createEnvironment trigger',
        );
    });

    test('should explain the requirement and requested version for an inline script', async () => {
        mockState.get.resolves(true);
        isUvInstalledStub.resolves(true);
        showInformationMessageStub.resolves(undefined);

        await promptInstallPythonViaUv('inlineScript', mockLog, {
            requiresPython: '>=3.13',
            version: '3.13',
        });

        assert(
            showInformationMessageStub.calledWithExactly(
                UvInstallStrings.inlineScriptInstallPythonPrompt('>=3.13', '3.13'),
                { modal: true },
                UvInstallStrings.installPythonVersion('3.13'),
            ),
            'Should explain why the inline script needs another Python',
        );
        assert(mockState.get.notCalled, 'Explicit inline-script setup should not be suppressed by another workflow');
    });

    test('should disclose that uv will also be installed for an inline script', async () => {
        mockState.get.resolves(false);
        isUvInstalledStub.resolves(false);
        showInformationMessageStub.resolves(undefined);

        await promptInstallPythonViaUv('inlineScript', mockLog, {
            requiresPython: '>=3.13',
            version: '3.13',
        });

        assert(
            showInformationMessageStub.calledWithExactly(
                UvInstallStrings.inlineScriptInstallPythonAndUvPrompt('>=3.13', '3.13'),
                { modal: true },
                UvInstallStrings.installUvAndPythonVersion('3.13'),
            ),
            'Should disclose both installations before asking for consent',
        );
    });

    test('should not offer an install when no compatible version can be derived', async () => {
        mockState.get.resolves(false);
        isUvInstalledStub.resolves(true);

        await promptInstallPythonViaUv('inlineScript', mockLog, { requiresPython: '<3.13' });

        assert(showInformationMessageStub.notCalled, 'Should not offer an install that may violate the requirement');
        assert(isUvInstalledStub.notCalled, 'Should stop before checking or installing uv');
        assert(sendTelemetryEventStub.notCalled, 'Should not record a prompt that was not shown');
    });

    test('should reject a non-numeric install version before prompting', async () => {
        mockState.get.resolves(false);

        await promptInstallPythonViaUv('inlineScript', mockLog, {
            requiresPython: '>=3.13',
            version: 'latest\nInstall anyway',
        });

        assert(showInformationMessageStub.notCalled, 'Should not display or install an untrusted version value');
        assert(isUvInstalledStub.notCalled, 'Should stop before checking or installing uv');
    });

    test('should report a failed detailed Python install prompt distinctly from the undefined wrapper', async () => {
        mockState.get.resolves(false);

        const result = await promptInstallPythonViaUvDetailed('inlineScript', mockLog, {
            requiresPython: '>=3.13',
            version: 'latest\nInstall anyway',
        });

        assert.deepStrictEqual(result, { kind: 'failed' });
        assert(showInformationMessageStub.notCalled, 'Should not display an invalid install version');
    });

    test('should report a declined detailed Python install prompt distinctly from the undefined wrapper', async () => {
        mockState.get.resolves(false);
        isUvInstalledStub.resolves(true);
        showInformationMessageStub.resolves(undefined);

        const result = await promptInstallPythonViaUvDetailed('activation', mockLog);

        assert.deepStrictEqual(result, { kind: 'declined' });
    });

    test('should allow a validated prerelease install version', async () => {
        mockState.get.resolves(false);
        isUvInstalledStub.resolves(true);
        showInformationMessageStub.resolves(undefined);

        await promptInstallPythonViaUv('inlineScript', mockLog, {
            requiresPython: '>=3.15.0a1',
            version: '3.15.0a1',
        });

        assert(showInformationMessageStub.calledOnce, 'Should offer the requested prerelease');
    });

    test('should request consent before installing uv for version lookup', async () => {
        isUvInstalledStub.resolves(false);
        showInformationMessageStub.resolves(undefined);

        assert.strictEqual(await ensureUvForInlineScriptVersionLookup('>=3.13,<3.14', mockLog), false);
        sinon.assert.calledOnceWithExactly(
            showInformationMessageStub,
            UvInstallStrings.inlineScriptInstallUvForVersionLookupPrompt('>=3.13,<3.14'),
            { modal: true },
            UvInstallStrings.installUv,
        );
    });

    test('should install uv for version lookup after consent', async () => {
        isUvInstalledStub.onFirstCall().resolves(false);
        isUvInstalledStub.onSecondCall().resolves(true);
        showInformationMessageStub.resolves(UvInstallStrings.installUv);
        const executeTaskStub = stubUvInstallTask(0);

        assert.strictEqual(await ensureUvForInlineScriptVersionLookup('>=3.13,<3.14', mockLog), true);
        assert.strictEqual(isUvInstalledStub.callCount, 2);
        assert.strictEqual(executeTaskStub.callCount, 1);
        assert.strictEqual(showErrorMessageStub.callCount, 0);
    });

    test('should report a failed detailed uv lookup distinctly from the boolean wrapper', async () => {
        isUvInstalledStub.resolves(false);
        showInformationMessageStub.resolves(UvInstallStrings.installUv);
        stubUvInstallTask(1);

        const result = await ensureUvForInlineScriptVersionLookupDetailed('>=3.13,<3.14', mockLog);

        assert.strictEqual(result, 'failed');
    });

    test('should stop version lookup when uv installation fails', async () => {
        isUvInstalledStub.resolves(false);
        showInformationMessageStub.resolves(UvInstallStrings.installUv);
        const executeTaskStub = stubUvInstallTask(1);

        assert.strictEqual(await ensureUvForInlineScriptVersionLookup('>=3.13,<3.14', mockLog), false);
        assert.strictEqual(isUvInstalledStub.callCount, 1);
        assert.strictEqual(executeTaskStub.callCount, 1);
        assert.strictEqual(showErrorMessageStub.callCount, 0);
    });

    test('should show restart guidance when installed uv remains unavailable', async () => {
        isUvInstalledStub.resolves(false);
        showInformationMessageStub.resolves(UvInstallStrings.installUv);
        stubUvInstallTask(0);

        assert.strictEqual(await ensureUvForInlineScriptVersionLookup('>=3.13,<3.14', mockLog), false);
        assert.strictEqual(isUvInstalledStub.callCount, 2);
        sinon.assert.calledOnceWithExactly(showErrorMessageStub, UvInstallStrings.uvInstallRestartRequired);
    });

    test('should stop version lookup when uv installation is cancelled', async () => {
        isUvInstalledStub.resolves(false);
        showInformationMessageStub.resolves(UvInstallStrings.installUv);
        const executeTaskStub = stubUvInstallTask(undefined);

        assert.strictEqual(await ensureUvForInlineScriptVersionLookup('>=3.13,<3.14', mockLog), false);
        assert.strictEqual(isUvInstalledStub.callCount, 1);
        assert.strictEqual(executeTaskStub.callCount, 1);
        assert.strictEqual(showErrorMessageStub.callCount, 0);
    });

    test('should trim inline-script context before displaying it', async () => {
        mockState.get.resolves(false);
        isUvInstalledStub.resolves(true);
        showInformationMessageStub.resolves(undefined);

        await promptInstallPythonViaUv('inlineScript', mockLog, {
            requiresPython: '  >=3.13  ',
            version: '  3.13  ',
        });

        assert(
            showInformationMessageStub.calledWithExactly(
                UvInstallStrings.inlineScriptInstallPythonPrompt('>=3.13', '3.13'),
                { modal: true },
                UvInstallStrings.installPythonVersion('3.13'),
            ),
            'Should display normalized prompt values',
        );
    });

    test('should flatten and cap a long requirement before displaying it', async () => {
        mockState.get.resolves(false);
        isUvInstalledStub.resolves(true);
        showInformationMessageStub.resolves(undefined);
        const requirement = `>=3.13\n${'a'.repeat(200)}`;
        const displayedRequirement = `>=3.13 ${'a'.repeat(110)}...`;

        await promptInstallPythonViaUv('inlineScript', mockLog, {
            requiresPython: requirement,
            version: '3.13',
        });

        assert(
            showInformationMessageStub.calledWithExactly(
                UvInstallStrings.inlineScriptInstallPythonPrompt(displayedRequirement, '3.13'),
                { modal: true },
                UvInstallStrings.installPythonVersion('3.13'),
            ),
            'Should keep script-controlled prompt text compact and single-line',
        );
    });

    test('should strip invisible and bidirectional controls from the displayed requirement', async () => {
        mockState.get.resolves(false);
        isUvInstalledStub.resolves(true);
        showInformationMessageStub.resolves(undefined);

        await promptInstallPythonViaUv('inlineScript', mockLog, {
            requiresPython: '>=3.13\u202e deceptive\u2069\u0000 text',
            version: '3.13',
        });

        assert(
            showInformationMessageStub.calledWithExactly(
                UvInstallStrings.inlineScriptInstallPythonPrompt('>=3.13 deceptive text', '3.13'),
                { modal: true },
                UvInstallStrings.installPythonVersion('3.13'),
            ),
            'Should not let script metadata visually reorder or hide consent text',
        );
    });

    test('should send telemetry with the inline-script trigger', async () => {
        mockState.get.resolves(false);
        isUvInstalledStub.resolves(true);
        showInformationMessageStub.resolves(undefined);

        await promptInstallPythonViaUv('inlineScript', mockLog, { requiresPython: '>=3.13', version: '3.13' });

        assert(
            sendTelemetryEventStub.calledWith(EventNames.UV_PYTHON_INSTALL_PROMPTED, undefined, {
                trigger: 'inlineScript',
            }),
            'Should identify inline-script prompts in telemetry',
        );
    });

    test('should pass the approved inline-script version to uv', async () => {
        mockState.get.resolves(false);
        isUvInstalledStub.resolves(true);
        const installAction = UvInstallStrings.installPythonVersion('3.13');
        showInformationMessageStub.onFirstCall().resolves(installAction);
        sinon.stub(windowApis, 'withProgress').callsFake(async (_options, task) =>
            task(
                { report: () => undefined },
                {
                    isCancellationRequested: false,
                    onCancellationRequested: () => ({ dispose: () => undefined }),
                } as CancellationToken,
            ),
        );

        let taskEndListener: ((event: TaskProcessEndEvent) => unknown) | undefined;
        sinon.stub(taskApis, 'onDidEndTaskProcess').callsFake((listener) => {
            taskEndListener = listener;
            return { dispose: () => undefined };
        });
        const executeTaskStub = sinon.stub(taskApis, 'executeTask').callsFake(async (task) => {
            setTimeout(() => {
                taskEndListener?.({ execution: { task } as TaskExecution, exitCode: 0 } as TaskProcessEndEvent);
            }, 0);
            return { task, terminate: () => undefined } as TaskExecution;
        });

        const versions: UvPythonVersion[] = [
            makeUvPythonVersion({ version: '3.13.1', path: '/usr/bin/python3.13' }),
        ];
        const mockProcess = new MockChildProcess('uv', [
            'python',
            'list',
            '--only-installed',
            '--managed-python',
            '--output-format',
            'json',
        ]);
        const spawnStub: sinon.SinonStub = sinon.stub(childProcessApis, 'spawnProcess');
        spawnStub.returns(mockProcess);

        const resultPromise = promptInstallPythonViaUvDetailed('inlineScript', mockLog, {
            requiresPython: '>=3.13',
            version: '3.13',
        });
        setTimeout(() => {
            mockProcess.stdout?.emit('data', JSON.stringify(versions));
            mockProcess.emit('exit', 0, null);
        }, 10);

        assert.deepStrictEqual(await resultPromise, { kind: 'installed', pythonPath: '/usr/bin/python3.13' });
        const installTask = executeTaskStub.firstCall.args[0];
        const execution = installTask.execution as ShellExecution;
        assert.strictEqual(execution.command, 'uv');
        assert.deepStrictEqual(execution.args, ['python', 'install', '3.13']);
    });
});

suite('uvPythonInstaller - executable handoff', () => {
    const home = path.resolve('bootstrap home');
    const installDir = path.join(home, 'custom uv bin');
    let savedEnv: NodeJS.ProcessEnv;
    let installed: boolean;
    let taskExitCode: number | undefined;
    let spawnStub: sinon.SinonStub;
    let executeTaskStub: sinon.SinonStub;
    let telemetryStub: sinon.SinonStub;
    let expectedExecutable: string;
    const pythonPath = path.join(home, 'managed-python', 'python');

    setup(() => {
        savedEnv = process.env;
        process.env = { ...savedEnv };
        for (const key of [
            'UV_INSTALL_DIR',
            'CARGO_DIST_FORCE_INSTALL_DIR',
            'UV_UNMANAGED_INSTALL',
            'CARGO_HOME',
            'XDG_BIN_HOME',
            'XDG_DATA_HOME',
        ]) {
            delete process.env[key];
        }
        process.env.UV_INSTALL_DIR = installDir;
        helpers.setUvExecutable('uv');
        sinon.stub(os, 'homedir').returns(home);
        sinon.stub(platformUtils, 'isWindows').returns(false);
        installed = false;
        taskExitCode = 0;
        expectedExecutable = path.join(installDir, 'uv');
        telemetryStub = sinon.stub(telemetrySender, 'sendTelemetryEvent');
        sinon.stub(windowApis, 'showErrorMessage');
        sinon.stub(windowApis, 'showInformationMessage');
        sinon
            .stub(windowApis, 'withProgress')
            .callsFake(async (_options, task) =>
                task(
                    { report: () => undefined },
                    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
                ),
            );
        let taskEndListener: ((event: TaskProcessEndEvent) => unknown) | undefined;
        sinon.stub(taskApis, 'onDidEndTaskProcess').callsFake((listener) => {
            taskEndListener = listener;
            return { dispose: () => undefined };
        });
        executeTaskStub = sinon.stub(taskApis, 'executeTask').callsFake(async (task) => {
            const execution = { task, terminate: () => undefined } as TaskExecution;
            setImmediate(() => {
                if (task.name === UvInstallStrings.installingUv && taskExitCode === 0) {
                    installed = true;
                }
                taskEndListener?.({ execution, exitCode: taskExitCode });
            });
            return execution;
        });
        spawnStub = sinon.stub(childProcessApis, 'spawnProcess');
        spawnStub.callsFake((command: string, args: string[]) => {
            const proc = new MockChildProcess(command, args);
            setImmediate(() => {
                if (command === 'curl' || command === 'wget') {
                    proc.emit('exit', 0, null);
                } else if (installed && command === expectedExecutable) {
                    if (args[0] === 'python') {
                        proc.stdout?.emit(
                            'data',
                            JSON.stringify([makeUvPythonVersion({ version: '3.11.15', path: pythonPath })]),
                        );
                    }
                    proc.emit('exit', 0, null);
                } else {
                    proc.emit('error', new Error(`spawn ${command} ENOENT`));
                }
            });
            return proc;
        });
    });

    teardown(() => {
        process.env = savedEnv;
        sinon.restore();
        helpers.setUvExecutable('uv');
    });

    test('installs Python and lists versions with the installed executable when PATH is unchanged', async () => {
        const originalPath = process.env.PATH;
        assert.strictEqual(await installPythonWithUv(undefined, '3.11'), pythonPath);
        assert.strictEqual(process.env.PATH, originalPath);
        const execution = executeTaskStub.secondCall.args[0].execution as ShellExecution;
        assert.strictEqual(execution.command, expectedExecutable);
        assert.deepStrictEqual(execution.args, ['python', 'install', '3.11']);
        sinon.assert.calledWith(spawnStub, expectedExecutable, [
            'python',
            'list',
            '--only-installed',
            '--managed-python',
            '--output-format',
            'json',
        ]);
        assert.strictEqual((await getAvailablePythonVersions()).length, 1);
        sinon.assert.calledWith(spawnStub, expectedExecutable, ['python', 'list', '--output-format', 'json']);
        assert.strictEqual(await helpers.getUvExecutable(), expectedExecutable);
        sinon.assert.calledWith(telemetryStub, EventNames.UV_PYTHON_INSTALL_COMPLETED);
        assert(!telemetryStub.calledWith(EventNames.UV_PYTHON_INSTALL_FAILED));
    });

    test('does not replace executable resolution after an installer failure', async () => {
        taskExitCode = 1;
        assert.strictEqual(await installPythonWithUv(), undefined);
        assert.strictEqual(await helpers.getUvExecutable(), undefined);
        assert(!spawnStub.calledWith(expectedExecutable));
        sinon.assert.calledWith(telemetryStub, EventNames.UV_PYTHON_INSTALL_FAILED, undefined, { stage: 'uvInstall' });
    });

    test('reports failure when a successful installer does not leave a runnable executable', async () => {
        expectedExecutable = path.join(home, 'not-the-installed-binary');
        assert.strictEqual(await installPythonWithUv(), undefined);
        sinon.assert.calledOnce(executeTaskStub);
        sinon.assert.calledWith(telemetryStub, EventNames.UV_PYTHON_INSTALL_FAILED, undefined, {
            stage: 'uvNotOnPath',
        });
    });

    test('uses the installed executable after consenting to inline-script version lookup', async () => {
        (windowApis.showInformationMessage as sinon.SinonStub).resolves(UvInstallStrings.installUv);
        assert.strictEqual(await ensureUvForInlineScriptVersionLookup('>=3.11'), true);
        assert.strictEqual((await getAvailablePythonVersions()).length, 1);
        sinon.assert.calledWith(spawnStub, expectedExecutable, ['python', 'list', '--output-format', 'json']);
    });

    const destinations: { name: string; env: NodeJS.ProcessEnv; directory: string }[] = [
        { name: 'default home', env: {}, directory: path.join(home, '.local', 'bin') },
        {
            name: 'explicit override',
            env: { UV_INSTALL_DIR: installDir, XDG_BIN_HOME: path.join(home, 'ignored') },
            directory: installDir,
        },
        { name: 'legacy override', env: { CARGO_DIST_FORCE_INSTALL_DIR: installDir }, directory: installDir },
        { name: 'unmanaged install', env: { UV_UNMANAGED_INSTALL: installDir }, directory: installDir },
        {
            name: 'XDG bin',
            env: { XDG_BIN_HOME: installDir, XDG_DATA_HOME: path.join(home, 'ignored') },
            directory: installDir,
        },
        {
            name: 'XDG data',
            env: { XDG_DATA_HOME: path.join(home, 'data', 'share') },
            directory: path.join(home, 'data', 'bin'),
        },
        {
            name: 'legacy default Cargo home',
            env: { UV_INSTALL_DIR: path.join(home, '.cargo') },
            directory: path.join(home, '.cargo', 'bin'),
        },
        {
            name: 'custom Cargo home',
            env: { UV_INSTALL_DIR: installDir, CARGO_HOME: installDir },
            directory: path.join(installDir, 'bin'),
        },
    ];
    for (const windows of [false, true]) {
        for (const { name, env, directory } of destinations) {
            test(`resolves ${name} with ${windows ? 'Windows' : 'POSIX'} executable naming`, async () => {
                delete process.env.UV_INSTALL_DIR;
                Object.assign(process.env, env);
                (platformUtils.isWindows as sinon.SinonStub).returns(windows);
                expectedExecutable = path.join(directory, windows ? 'uv.exe' : 'uv');
                assert.strictEqual(await installUv(), true);
                assert.strictEqual(await helpers.getUvExecutable(), expectedExecutable);
                sinon.assert.calledWith(spawnStub, expectedExecutable, ['--version']);
            });
        }
    }
});

suite('uvPythonInstaller - isDontAskAgainSet and clearDontAskAgain', () => {
    let mockState: { get: sinon.SinonStub; set: sinon.SinonStub; clear: sinon.SinonStub };

    setup(() => {
        mockState = {
            get: sinon.stub(),
            set: sinon.stub().resolves(),
            clear: sinon.stub().resolves(),
        };
        sinon.stub(persistentState, 'getGlobalPersistentState').resolves(mockState);
    });

    teardown(() => {
        sinon.restore();
    });

    test('isDontAskAgainSet should return true when flag is set', async () => {
        mockState.get.resolves(true);

        const result = await isDontAskAgainSet();

        assert.strictEqual(result, true);
    });

    test('isDontAskAgainSet should return false when flag is not set', async () => {
        mockState.get.resolves(false);

        const result = await isDontAskAgainSet();

        assert.strictEqual(result, false);
    });

    test('isDontAskAgainSet should return false when flag is undefined', async () => {
        mockState.get.resolves(undefined);

        const result = await isDontAskAgainSet();

        assert.strictEqual(result, false);
    });

    test('clearDontAskAgain should set flag to false', async () => {
        await clearDontAskAgain();

        assert(mockState.set.calledWith(UV_INSTALL_PYTHON_DONT_ASK_KEY, false), 'Should clear the flag');
    });
});

/**
 * Helper to build a UvPythonVersion object for testing.
 */
function makeUvPythonVersion(overrides: Partial<UvPythonVersion> & { version: string }): UvPythonVersion {
    const parts = overrides.version.split('.').map(Number);
    return {
        key: overrides.key ?? `cpython-${overrides.version}`,
        version: overrides.version,
        version_parts: overrides.version_parts ?? { major: parts[0], minor: parts[1], patch: parts[2] ?? 0 },
        path: overrides.path ?? null,
        url: overrides.url ?? null,
        os: overrides.os ?? 'linux',
        variant: overrides.variant ?? 'default',
        implementation: overrides.implementation ?? 'cpython',
        arch: overrides.arch ?? 'x86_64',
    };
}

suite('uvPythonInstaller - getUvPythonPath', () => {
    let spawnStub: sinon.SinonStub;

    setup(() => {
        spawnStub = sinon.stub(childProcessApis, 'spawnProcess');
        sinon.stub(helpers, 'getUvExecutable').resolves('uv');
    });

    teardown(() => {
        sinon.restore();
    });

    test('should return the latest installed Python path when no version specified', async () => {
        const versions: UvPythonVersion[] = [
            makeUvPythonVersion({ version: '3.13.1', path: '/usr/bin/python3.13' }),
            makeUvPythonVersion({ version: '3.12.8', path: '/usr/bin/python3.12' }),
        ];

        const mockProcess = new MockChildProcess('uv', [
            'python',
            'list',
            '--only-installed',
            '--managed-python',
            '--output-format',
            'json',
        ]);
        spawnStub.returns(mockProcess);

        const resultPromise = getUvPythonPath();

        setTimeout(() => {
            mockProcess.stdout?.emit('data', JSON.stringify(versions));
            mockProcess.emit('exit', 0, null);
        }, 10);

        const result = await resultPromise;

        assert.strictEqual(result, '/usr/bin/python3.13', 'Should return the first (latest) installed Python');
    });

    test('should return matching Python path when version is specified', async () => {
        const versions: UvPythonVersion[] = [
            makeUvPythonVersion({ version: '3.13.1', path: '/usr/bin/python3.13' }),
            makeUvPythonVersion({ version: '3.12.8', path: '/usr/bin/python3.12' }),
        ];

        const mockProcess = new MockChildProcess('uv', [
            'python',
            'list',
            '--only-installed',
            '--managed-python',
            '--output-format',
            'json',
        ]);
        spawnStub.returns(mockProcess);

        const resultPromise = getUvPythonPath('3.12');

        setTimeout(() => {
            mockProcess.stdout?.emit('data', JSON.stringify(versions));
            mockProcess.emit('exit', 0, null);
        }, 10);

        const result = await resultPromise;

        assert.strictEqual(result, '/usr/bin/python3.12', 'Should return the matching version');
    });

    test('should match requested versions on release-segment boundaries', async () => {
        const versions: UvPythonVersion[] = [
            makeUvPythonVersion({ version: '3.13.1', path: '/usr/bin/python3.13' }),
            makeUvPythonVersion({ version: '3.1.9', path: '/usr/bin/python3.1' }),
        ];

        const mockProcess = new MockChildProcess('uv', [
            'python',
            'list',
            '--only-installed',
            '--managed-python',
            '--output-format',
            'json',
        ]);
        spawnStub.returns(mockProcess);

        const resultPromise = getUvPythonPath('3.1');

        setTimeout(() => {
            mockProcess.stdout?.emit('data', JSON.stringify(versions));
            mockProcess.emit('exit', 0, null);
        }, 10);

        const result = await resultPromise;

        assert.strictEqual(result, '/usr/bin/python3.1', 'Should not mistake Python 3.13 for Python 3.1');
    });

    test('should require an exact match for a prerelease version', async () => {
        const versions: UvPythonVersion[] = [
            makeUvPythonVersion({ version: '3.14.0', path: '/usr/bin/python3.14' }),
            makeUvPythonVersion({ version: '3.14.0rc1', path: '/usr/bin/python3.14-rc1' }),
        ];

        const mockProcess = new MockChildProcess('uv', [
            'python',
            'list',
            '--only-installed',
            '--managed-python',
            '--output-format',
            'json',
        ]);
        spawnStub.returns(mockProcess);

        const resultPromise = getUvPythonPath('3.14.0rc1');

        setTimeout(() => {
            mockProcess.stdout?.emit('data', JSON.stringify(versions));
            mockProcess.emit('exit', 0, null);
        }, 10);

        assert.strictEqual(await resultPromise, '/usr/bin/python3.14-rc1');
    });

    test('should return undefined when specified version is not found', async () => {
        const versions: UvPythonVersion[] = [makeUvPythonVersion({ version: '3.13.1', path: '/usr/bin/python3.13' })];

        const mockProcess = new MockChildProcess('uv', [
            'python',
            'list',
            '--only-installed',
            '--managed-python',
            '--output-format',
            'json',
        ]);
        spawnStub.returns(mockProcess);

        const resultPromise = getUvPythonPath('3.11');

        setTimeout(() => {
            mockProcess.stdout?.emit('data', JSON.stringify(versions));
            mockProcess.emit('exit', 0, null);
        }, 10);

        const result = await resultPromise;

        assert.strictEqual(result, undefined, 'Should return undefined when version not found');
    });

    test('should return undefined when no Pythons are installed', async () => {
        const mockProcess = new MockChildProcess('uv', [
            'python',
            'list',
            '--only-installed',
            '--managed-python',
            '--output-format',
            'json',
        ]);
        spawnStub.returns(mockProcess);

        const resultPromise = getUvPythonPath();

        setTimeout(() => {
            mockProcess.stdout?.emit('data', JSON.stringify([]));
            mockProcess.emit('exit', 0, null);
        }, 10);

        const result = await resultPromise;

        assert.strictEqual(result, undefined, 'Should return undefined for empty versions list');
    });

    test('should return undefined when process exits with non-zero code', async () => {
        const mockProcess = new MockChildProcess('uv', [
            'python',
            'list',
            '--only-installed',
            '--managed-python',
            '--output-format',
            'json',
        ]);
        spawnStub.returns(mockProcess);

        const resultPromise = getUvPythonPath();

        setTimeout(() => {
            mockProcess.emit('exit', 1, null);
        }, 10);

        const result = await resultPromise;

        assert.strictEqual(result, undefined, 'Should return undefined on non-zero exit');
    });

    test('should return undefined when process emits error', async () => {
        const mockProcess = new MockChildProcess('uv', [
            'python',
            'list',
            '--only-installed',
            '--managed-python',
            '--output-format',
            'json',
        ]);
        spawnStub.returns(mockProcess);

        const resultPromise = getUvPythonPath();

        setTimeout(() => {
            mockProcess.emit('error', new Error('spawn uv ENOENT'));
        }, 10);

        const result = await resultPromise;

        assert.strictEqual(result, undefined, 'Should return undefined on process error');
    });

    test('should return undefined when output is invalid JSON', async () => {
        const mockProcess = new MockChildProcess('uv', [
            'python',
            'list',
            '--only-installed',
            '--managed-python',
            '--output-format',
            'json',
        ]);
        spawnStub.returns(mockProcess);

        const resultPromise = getUvPythonPath();

        setTimeout(() => {
            mockProcess.stdout?.emit('data', 'not valid json{{{');
            mockProcess.emit('exit', 0, null);
        }, 10);

        const result = await resultPromise;

        assert.strictEqual(result, undefined, 'Should return undefined on JSON parse failure');
    });

    test('should skip versions without a path', async () => {
        const versions: UvPythonVersion[] = [
            makeUvPythonVersion({ version: '3.13.1', path: null }),
            makeUvPythonVersion({ version: '3.12.8', path: '/usr/bin/python3.12' }),
        ];

        const mockProcess = new MockChildProcess('uv', [
            'python',
            'list',
            '--only-installed',
            '--managed-python',
            '--output-format',
            'json',
        ]);
        spawnStub.returns(mockProcess);

        const resultPromise = getUvPythonPath();

        setTimeout(() => {
            mockProcess.stdout?.emit('data', JSON.stringify(versions));
            mockProcess.emit('exit', 0, null);
        }, 10);

        const result = await resultPromise;

        assert.strictEqual(result, '/usr/bin/python3.12', 'Should skip entries with null path');
    });

    test('should handle chunked stdout data', async () => {
        const versions: UvPythonVersion[] = [makeUvPythonVersion({ version: '3.13.1', path: '/usr/bin/python3.13' })];
        const fullJson = JSON.stringify(versions);
        const mid = Math.floor(fullJson.length / 2);

        const mockProcess = new MockChildProcess('uv', [
            'python',
            'list',
            '--only-installed',
            '--managed-python',
            '--output-format',
            'json',
        ]);
        spawnStub.returns(mockProcess);

        const resultPromise = getUvPythonPath();

        setTimeout(() => {
            mockProcess.stdout?.emit('data', fullJson.slice(0, mid));
            mockProcess.stdout?.emit('data', fullJson.slice(mid));
            mockProcess.emit('exit', 0, null);
        }, 10);

        const result = await resultPromise;

        assert.strictEqual(result, '/usr/bin/python3.13', 'Should correctly reassemble chunked data');
    });
});

suite('uvPythonInstaller - getAvailablePythonVersions', () => {
    let spawnStub: sinon.SinonStub;

    setup(() => {
        spawnStub = sinon.stub(childProcessApis, 'spawnProcess');
        sinon.stub(helpers, 'getUvExecutable').resolves('uv');
    });

    teardown(() => {
        sinon.restore();
    });

    test('should return all versions from uv python list', async () => {
        const versions: UvPythonVersion[] = [
            makeUvPythonVersion({ version: '3.13.1', path: '/usr/bin/python3.13' }),
            makeUvPythonVersion({ version: '3.12.8', path: null }),
        ];

        const mockProcess = new MockChildProcess('uv', ['python', 'list', '--output-format', 'json']);
        spawnStub.returns(mockProcess);

        const resultPromise = getAvailablePythonVersions();

        setTimeout(() => {
            mockProcess.stdout?.emit('data', JSON.stringify(versions));
            mockProcess.emit('exit', 0, null);
        }, 10);

        const result = await resultPromise;

        assert.strictEqual(result.length, 2, 'Should return all versions');
        assert.strictEqual(result[0].version, '3.13.1');
        assert.strictEqual(result[1].version, '3.12.8');
        sinon.assert.calledOnceWithExactly(spawnStub, 'uv', ['python', 'list', '--output-format', 'json']);
    });

    test('should request older patch releases only when all versions are requested', async () => {
        const versions: UvPythonVersion[] = [
            makeUvPythonVersion({ version: '3.13.2', path: null }),
            makeUvPythonVersion({ version: '3.13.0', path: null }),
        ];
        const args = ['python', 'list', '--all-versions', '--output-format', 'json'];
        const mockProcess = new MockChildProcess('uv', args);
        spawnStub.returns(mockProcess);

        const resultPromise = getAvailablePythonVersions({ allVersions: true });

        setTimeout(() => {
            mockProcess.stdout?.emit('data', JSON.stringify(versions));
            mockProcess.emit('exit', 0, null);
        }, 10);

        const result = await resultPromise;

        assert.deepStrictEqual(
            result.map((version) => version.version),
            ['3.13.2', '3.13.0'],
        );
        sinon.assert.calledOnceWithExactly(spawnStub, 'uv', args);
    });

    test('should return empty array on process error', async () => {
        const mockProcess = new MockChildProcess('uv', ['python', 'list', '--output-format', 'json']);
        spawnStub.returns(mockProcess);

        const resultPromise = getAvailablePythonVersions();

        setTimeout(() => {
            mockProcess.emit('error', new Error('spawn uv ENOENT'));
        }, 10);

        const result = await resultPromise;

        assert.deepStrictEqual(result, [], 'Should return empty array on error');
    });

    test('should return empty array on non-zero exit code', async () => {
        const mockProcess = new MockChildProcess('uv', ['python', 'list', '--output-format', 'json']);
        spawnStub.returns(mockProcess);

        const resultPromise = getAvailablePythonVersions();

        setTimeout(() => {
            mockProcess.emit('exit', 1, null);
        }, 10);

        const result = await resultPromise;

        assert.deepStrictEqual(result, [], 'Should return empty array on non-zero exit');
    });

    test('should return empty array on invalid JSON output', async () => {
        const mockProcess = new MockChildProcess('uv', ['python', 'list', '--output-format', 'json']);
        spawnStub.returns(mockProcess);

        const resultPromise = getAvailablePythonVersions();

        setTimeout(() => {
            mockProcess.stdout?.emit('data', '{{invalid json');
            mockProcess.emit('exit', 0, null);
        }, 10);

        const result = await resultPromise;

        assert.deepStrictEqual(result, [], 'Should return empty array on JSON parse failure');
    });
});
