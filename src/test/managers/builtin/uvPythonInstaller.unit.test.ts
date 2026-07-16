import assert from 'assert';
import * as sinon from 'sinon';
import { CancellationToken, LogOutputChannel, ShellExecution, TaskExecution, TaskProcessEndEvent } from 'vscode';
import * as childProcessApis from '../../../common/childProcess.apis';
import { Common, UvInstallStrings } from '../../../common/localize';
import * as persistentState from '../../../common/persistentState';
import { EventNames } from '../../../common/telemetry/constants';
import * as telemetrySender from '../../../common/telemetry/sender';
import * as taskApis from '../../../common/tasks.apis';
import * as windowApis from '../../../common/window.apis';
import * as helpers from '../../../managers/builtin/helpers';
import {
    clearDontAskAgain,
    getAvailablePythonVersions,
    getUvPythonPath,
    isDontAskAgainSet,
    promptInstallPythonViaUv,
    UV_INSTALL_PYTHON_DONT_ASK_KEY,
    UvPythonVersion,
} from '../../../managers/builtin/uvPythonInstaller';
import { createMockLogOutputChannel } from '../../mocks/helper';
import { MockChildProcess } from '../../mocks/mockChildProcess';

suite('uvPythonInstaller - promptInstallPythonViaUv', () => {
    let mockLog: LogOutputChannel;
    let isUvInstalledStub: sinon.SinonStub;
    let showInformationMessageStub: sinon.SinonStub;
    let sendTelemetryEventStub: sinon.SinonStub;
    let mockState: { get: sinon.SinonStub; set: sinon.SinonStub; clear: sinon.SinonStub };

    setup(() => {
        mockLog = createMockLogOutputChannel();

        mockState = {
            get: sinon.stub(),
            set: sinon.stub().resolves(),
            clear: sinon.stub().resolves(),
        };
        sinon.stub(persistentState, 'getGlobalPersistentState').resolves(mockState);
        isUvInstalledStub = sinon.stub(helpers, 'isUvInstalled');
        showInformationMessageStub = sinon.stub(windowApis, 'showInformationMessage');
        sendTelemetryEventStub = sinon.stub(telemetrySender, 'sendTelemetryEvent');
    });

    teardown(() => {
        sinon.restore();
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

        const resultPromise = promptInstallPythonViaUv('inlineScript', mockLog, {
            requiresPython: '>=3.13',
            version: '3.13',
        });
        setTimeout(() => {
            mockProcess.stdout?.emit('data', JSON.stringify(versions));
            mockProcess.emit('exit', 0, null);
        }, 10);

        assert.strictEqual(await resultPromise, '/usr/bin/python3.13');
        const installTask = executeTaskStub.firstCall.args[0];
        const execution = installTask.execution as ShellExecution;
        assert.strictEqual(execution.command, 'uv');
        assert.deepStrictEqual(execution.args, ['python', 'install', '3.13']);
    });
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

// NOTE: Installation functions (installUv, installPythonViaUv, installPythonWithUv) require
// VS Code's Task API which cannot be fully mocked in unit tests.
// These should be tested via integration tests in a real VS Code environment.

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
