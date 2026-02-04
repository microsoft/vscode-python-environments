/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from 'assert';
import * as sinon from 'sinon';
import { Disposable, EventEmitter, Terminal, TerminalShellExecutionEndEvent, Uri } from 'vscode';
import { PythonEnvironment } from '../../../api';
import * as logging from '../../../common/logging';
import * as windowApis from '../../../common/window.apis';
import { TerminalEnvironment } from '../../../features/terminal/terminalActivationState';
import {
    getEnvironmentForPackageRefresh,
    isPackageModifyingCommand,
    registerTerminalPackageWatcher,
} from '../../../features/terminal/terminalPackageWatcher';
import * as terminalUtils from '../../../features/terminal/utils';

/**
 * Creates a mock PythonEnvironment for testing.
 * Uses Uri.file().fsPath for cross-platform path compatibility.
 */
function createMockEnvironment(overrides?: Partial<PythonEnvironment>): PythonEnvironment {
    const envPath = Uri.file('test-env').fsPath;
    const pythonPath = Uri.file('test-env/bin/python').fsPath;
    return {
        envId: { id: 'test-env-id', managerId: 'ms-python.python:venv' },
        name: 'Test Environment',
        displayName: 'Test Environment',
        shortDisplayName: 'TestEnv',
        displayPath: envPath,
        version: '3.9.0',
        environmentPath: Uri.file(pythonPath),
        sysPrefix: envPath,
        execInfo: {
            run: { executable: pythonPath },
        },
        ...overrides,
    };
}

/**
 * Creates a mock Terminal for testing.
 * Uses Uri.file() for cross-platform path compatibility.
 */
function createMockTerminal(overrides?: Partial<Terminal>): Terminal {
    return {
        name: 'Test Terminal',
        processId: Promise.resolve(1234),
        creationOptions: {},
        exitStatus: undefined,
        state: { isInteractedWith: true },
        shellIntegration: {
            cwd: Uri.file('.'),
            executeCommand: () => ({}) as any,
        },
        sendText: () => {},
        show: () => {},
        hide: () => {},
        dispose: () => {},
        ...overrides,
    } as Terminal;
}

suite('terminalPackageWatcher - isPackageModifyingCommand', () => {
    suite('pip commands', () => {
        test('should detect "pip install package"', () => {
            // Run
            const result = isPackageModifyingCommand('pip install requests');

            // Assert
            assert.strictEqual(result, true, 'pip install should be detected as package-modifying');
        });

        test('should detect "pip3 install package"', () => {
            // Run
            const result = isPackageModifyingCommand('pip3 install requests');

            // Assert
            assert.strictEqual(result, true, 'pip3 install should be detected as package-modifying');
        });

        test('should detect "python -m pip install package"', () => {
            // Run
            const result = isPackageModifyingCommand('python -m pip install requests');

            // Assert
            assert.strictEqual(result, true, 'python -m pip install should be detected as package-modifying');
        });

        test('should detect "python3 -m pip install package"', () => {
            // Run
            const result = isPackageModifyingCommand('python3 -m pip install requests');

            // Assert
            assert.strictEqual(result, true, 'python3 -m pip install should be detected as package-modifying');
        });

        test('should detect "pip uninstall package"', () => {
            // Run
            const result = isPackageModifyingCommand('pip uninstall requests');

            // Assert
            assert.strictEqual(result, true, 'pip uninstall should be detected as package-modifying');
        });

        test('should detect "pip install -r requirements.txt"', () => {
            // Run
            const result = isPackageModifyingCommand('pip install -r requirements.txt');

            // Assert
            assert.strictEqual(result, true, 'pip install -r should be detected as package-modifying');
        });
    });

    suite('uv commands', () => {
        test('should detect "uv pip install package"', () => {
            // Run
            const result = isPackageModifyingCommand('uv pip install requests');

            // Assert
            assert.strictEqual(result, true, 'uv pip install should be detected as package-modifying');
        });

        test('should detect "uv pip uninstall package"', () => {
            // Run
            const result = isPackageModifyingCommand('uv pip uninstall requests');

            // Assert
            assert.strictEqual(result, true, 'uv pip uninstall should be detected as package-modifying');
        });
    });

    suite('conda commands', () => {
        test('should detect "conda install package"', () => {
            // Run
            const result = isPackageModifyingCommand('conda install numpy');

            // Assert
            assert.strictEqual(result, true, 'conda install should be detected as package-modifying');
        });

        test('should detect "conda remove package"', () => {
            // Run
            const result = isPackageModifyingCommand('conda remove numpy');

            // Assert
            assert.strictEqual(result, true, 'conda remove should be detected as package-modifying');
        });

        test('should detect "conda uninstall package"', () => {
            // Run
            const result = isPackageModifyingCommand('conda uninstall numpy');

            // Assert
            assert.strictEqual(result, true, 'conda uninstall should be detected as package-modifying');
        });

        test('should detect "mamba install package"', () => {
            // Run
            const result = isPackageModifyingCommand('mamba install numpy');

            // Assert
            assert.strictEqual(result, true, 'mamba install should be detected as package-modifying');
        });

        test('should detect "micromamba install package"', () => {
            // Run
            const result = isPackageModifyingCommand('micromamba install numpy');

            // Assert
            assert.strictEqual(result, true, 'micromamba install should be detected as package-modifying');
        });
    });

    suite('poetry commands', () => {
        test('should detect "poetry add package"', () => {
            // Run
            const result = isPackageModifyingCommand('poetry add requests');

            // Assert
            assert.strictEqual(result, true, 'poetry add should be detected as package-modifying');
        });

        test('should detect "poetry remove package"', () => {
            // Run
            const result = isPackageModifyingCommand('poetry remove requests');

            // Assert
            assert.strictEqual(result, true, 'poetry remove should be detected as package-modifying');
        });
    });

    suite('pipenv commands', () => {
        test('should detect "pipenv install package"', () => {
            // Run
            const result = isPackageModifyingCommand('pipenv install requests');

            // Assert
            assert.strictEqual(result, true, 'pipenv install should be detected as package-modifying');
        });

        test('should detect "pipenv uninstall package"', () => {
            // Run
            const result = isPackageModifyingCommand('pipenv uninstall requests');

            // Assert
            assert.strictEqual(result, true, 'pipenv uninstall should be detected as package-modifying');
        });
    });

    suite('non-package commands', () => {
        test('should not detect "pip list"', () => {
            // Run
            const result = isPackageModifyingCommand('pip list');

            // Assert
            assert.strictEqual(result, false, 'pip list should not be detected as package-modifying');
        });

        test('should not detect "conda activate env"', () => {
            // Run
            const result = isPackageModifyingCommand('conda activate myenv');

            // Assert
            assert.strictEqual(result, false, 'conda activate should not be detected as package-modifying');
        });

        test('should not detect "python script.py"', () => {
            // Run
            const result = isPackageModifyingCommand('python script.py');

            // Assert
            assert.strictEqual(result, false, 'python script.py should not be detected as package-modifying');
        });

        test('should not detect "ls -la"', () => {
            // Run
            const result = isPackageModifyingCommand('ls -la');

            // Assert
            assert.strictEqual(result, false, 'ls -la should not be detected as package-modifying');
        });

        test('should detect "echo pip install" (contains pip install substring)', () => {
            // Note: This matches because regex finds "pip install" within the string
            // Run
            const result = isPackageModifyingCommand('echo pip install fake');

            // Assert
            assert.strictEqual(result, true, 'echo pip install should match due to substring');
        });
    });
});

suite('terminalPackageWatcher - getEnvironmentForPackageRefresh', () => {
    let sandbox: sinon.SinonSandbox;
    let mockTerminal: Terminal;
    let mockTerminalEnv: TerminalEnvironment;
    let mockApi: any;
    let getEnvironmentForTerminalStub: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        mockTerminal = createMockTerminal();

        // Stub logging to prevent console output during tests
        sandbox.stub(logging, 'traceVerbose');

        // Stub getEnvironmentForTerminal utility
        getEnvironmentForTerminalStub = sandbox.stub(terminalUtils, 'getEnvironmentForTerminal');
    });

    teardown(() => {
        sandbox.restore();
    });

    test('should return activated environment when terminal has one tracked', async () => {
        // Mock - Terminal has a tracked conda environment
        const condaEnv = createMockEnvironment({
            envId: { id: 'conda-env', managerId: 'ms-python.python:conda' },
            displayName: 'Conda Environment',
        });

        mockTerminalEnv = {
            getEnvironment: sandbox.stub().returns(condaEnv),
        };

        mockApi = {
            getEnvironment: sandbox.stub(),
            getPythonProjects: sandbox.stub().returns([]),
        };

        // Run
        const result = await getEnvironmentForPackageRefresh(mockTerminal, mockTerminalEnv, mockApi);

        // Assert
        assert.strictEqual(result, condaEnv, 'Should return the activated conda environment');
        assert.strictEqual(
            (mockTerminalEnv.getEnvironment as sinon.SinonStub).calledOnceWith(mockTerminal),
            true,
            'Should query terminal environment state',
        );
        assert.strictEqual(
            getEnvironmentForTerminalStub.called,
            false,
            'Should not call fallback when activated env exists',
        );
    });

    test('should fall back to getEnvironmentForTerminal when no activated environment', async () => {
        // Mock - Terminal has no tracked activation, fallback returns venv
        const venvEnv = createMockEnvironment({
            envId: { id: 'venv-env', managerId: 'ms-python.python:venv' },
            displayName: 'Venv Environment',
        });

        mockTerminalEnv = {
            getEnvironment: sandbox.stub().returns(undefined),
        };

        mockApi = {
            getEnvironment: sandbox.stub(),
            getPythonProjects: sandbox.stub().returns([]),
        };

        getEnvironmentForTerminalStub.resolves(venvEnv);

        // Run
        const result = await getEnvironmentForPackageRefresh(mockTerminal, mockTerminalEnv, mockApi);

        // Assert
        assert.strictEqual(result, venvEnv, 'Should return environment from fallback');
        assert.strictEqual(
            (mockTerminalEnv.getEnvironment as sinon.SinonStub).calledOnceWith(mockTerminal),
            true,
            'Should first check terminal activation state',
        );
        assert.strictEqual(getEnvironmentForTerminalStub.calledOnce, true, 'Should call fallback');
    });

    test('should return undefined when both activated env and fallback return undefined', async () => {
        // Mock - No environment from either source
        mockTerminalEnv = {
            getEnvironment: sandbox.stub().returns(undefined),
        };

        mockApi = {
            getEnvironment: sandbox.stub(),
            getPythonProjects: sandbox.stub().returns([]),
        };

        getEnvironmentForTerminalStub.resolves(undefined);

        // Run
        const result = await getEnvironmentForPackageRefresh(mockTerminal, mockTerminalEnv, mockApi);

        // Assert
        assert.strictEqual(result, undefined, 'Should return undefined when no environment found');
    });

    test('should prioritize activated environment over fallback', async () => {
        // Mock - Both activated env and fallback would return different envs
        const activatedCondaEnv = createMockEnvironment({
            envId: { id: 'conda-activated', managerId: 'ms-python.python:conda' },
            displayName: 'Activated Conda Env',
        });

        const workspaceVenvEnv = createMockEnvironment({
            envId: { id: 'workspace-venv', managerId: 'ms-python.python:venv' },
            displayName: 'Workspace Venv',
        });

        mockTerminalEnv = {
            getEnvironment: sandbox.stub().returns(activatedCondaEnv),
        };

        mockApi = {
            getEnvironment: sandbox.stub(),
            getPythonProjects: sandbox.stub().returns([]),
        };

        // Set up fallback to return different env - should not be called
        getEnvironmentForTerminalStub.resolves(workspaceVenvEnv);

        // Run
        const result = await getEnvironmentForPackageRefresh(mockTerminal, mockTerminalEnv, mockApi);

        // Assert
        assert.strictEqual(result, activatedCondaEnv, 'Should return activated env, not fallback');
        assert.strictEqual(result?.envId.id, 'conda-activated', 'Should be the conda-activated environment');
        assert.strictEqual(
            getEnvironmentForTerminalStub.called,
            false,
            'Should not call fallback when activated env exists',
        );
    });
});

suite('terminalPackageWatcher - registerTerminalPackageWatcher', () => {
    let sandbox: sinon.SinonSandbox;
    let disposables: Disposable[];
    let shellExecutionEmitter: EventEmitter<TerminalShellExecutionEndEvent>;
    let mockApi: any;
    let mockTerminalEnv: TerminalEnvironment;
    let mockLog: any;
    let getEnvironmentForTerminalStub: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        disposables = [];
        shellExecutionEmitter = new EventEmitter<TerminalShellExecutionEndEvent>();

        // Stub the window API to capture the listener
        sandbox.stub(windowApis, 'onDidEndTerminalShellExecution').callsFake((listener) => {
            return shellExecutionEmitter.event(listener);
        });

        // Stub logging to prevent console output during tests
        sandbox.stub(logging, 'traceVerbose');

        // Stub getEnvironmentForTerminal utility
        getEnvironmentForTerminalStub = sandbox.stub(terminalUtils, 'getEnvironmentForTerminal');

        mockLog = {
            error: sandbox.stub(),
            info: sandbox.stub(),
            warn: sandbox.stub(),
        };
    });

    teardown(() => {
        sandbox.restore();
        shellExecutionEmitter.dispose();
        disposables.forEach((d) => d.dispose());
    });

    function createShellExecutionEvent(command: string, terminal?: Terminal): TerminalShellExecutionEndEvent {
        return {
            terminal: terminal ?? createMockTerminal(),
            execution: {
                commandLine: {
                    value: command,
                    isTrusted: true,
                    confidence: 1,
                },
                cwd: Uri.file('.'),
                read: () => ({ [Symbol.asyncIterator]: async function* () {} }),
            },
            shellIntegration: {} as any,
            exitCode: 0,
        } as TerminalShellExecutionEndEvent;
    }

    test('should call refreshPackages on pip install with venv environment', async () => {
        // Mock - Terminal has venv environment
        const venvEnv = createMockEnvironment({
            envId: { id: 'venv-env', managerId: 'ms-python.python:venv' },
        });

        mockTerminalEnv = {
            getEnvironment: sandbox.stub().returns(venvEnv),
        };

        mockApi = {
            refreshPackages: sandbox.stub().resolves(),
            getEnvironment: sandbox.stub(),
            getPythonProjects: sandbox.stub().returns([]),
        };

        registerTerminalPackageWatcher(mockApi, mockTerminalEnv, mockLog, disposables);

        // Run - Fire the pip install event
        shellExecutionEmitter.fire(createShellExecutionEvent('pip install requests'));

        // Wait for async processing
        await new Promise((resolve) => setImmediate(resolve));

        // Assert
        assert.strictEqual(mockApi.refreshPackages.calledOnce, true, 'Should call refreshPackages once');
        assert.strictEqual(mockApi.refreshPackages.calledWith(venvEnv), true, 'Should refresh the venv environment');
    });

    test('should call refreshPackages on conda install with conda environment', async () => {
        // Mock - Terminal has conda environment
        const condaEnv = createMockEnvironment({
            envId: { id: 'conda-env', managerId: 'ms-python.python:conda' },
        });

        mockTerminalEnv = {
            getEnvironment: sandbox.stub().returns(condaEnv),
        };

        mockApi = {
            refreshPackages: sandbox.stub().resolves(),
            getEnvironment: sandbox.stub(),
            getPythonProjects: sandbox.stub().returns([]),
        };

        registerTerminalPackageWatcher(mockApi, mockTerminalEnv, mockLog, disposables);

        // Run - Fire the conda install event
        shellExecutionEmitter.fire(createShellExecutionEvent('conda install numpy'));

        await new Promise((resolve) => setImmediate(resolve));

        // Assert
        assert.strictEqual(mockApi.refreshPackages.calledOnce, true, 'Should call refreshPackages once');
        assert.strictEqual(mockApi.refreshPackages.calledWith(condaEnv), true, 'Should refresh the conda environment');
    });

    test('should call refreshPackages on poetry add with poetry environment', async () => {
        // Mock - Terminal has poetry environment
        const poetryEnv = createMockEnvironment({
            envId: { id: 'poetry-env', managerId: 'ms-python.python:poetry' },
        });

        mockTerminalEnv = {
            getEnvironment: sandbox.stub().returns(poetryEnv),
        };

        mockApi = {
            refreshPackages: sandbox.stub().resolves(),
            getEnvironment: sandbox.stub(),
            getPythonProjects: sandbox.stub().returns([]),
        };

        registerTerminalPackageWatcher(mockApi, mockTerminalEnv, mockLog, disposables);

        // Run - Fire the poetry add event
        shellExecutionEmitter.fire(createShellExecutionEvent('poetry add requests'));

        await new Promise((resolve) => setImmediate(resolve));

        // Assert
        assert.strictEqual(mockApi.refreshPackages.calledOnce, true, 'Should call refreshPackages once');
        assert.strictEqual(
            mockApi.refreshPackages.calledWith(poetryEnv),
            true,
            'Should refresh the poetry environment',
        );
    });

    test('should NOT call refreshPackages on pip list', async () => {
        // Mock - Terminal has venv but pip list is not package-modifying
        const venvEnv = createMockEnvironment();

        mockTerminalEnv = {
            getEnvironment: sandbox.stub().returns(venvEnv),
        };

        mockApi = {
            refreshPackages: sandbox.stub().resolves(),
            getEnvironment: sandbox.stub(),
            getPythonProjects: sandbox.stub().returns([]),
        };

        registerTerminalPackageWatcher(mockApi, mockTerminalEnv, mockLog, disposables);

        // Run - Fire pip list event (not package-modifying)
        shellExecutionEmitter.fire(createShellExecutionEvent('pip list'));

        await new Promise((resolve) => setImmediate(resolve));

        // Assert
        assert.strictEqual(mockApi.refreshPackages.called, false, 'Should not call refreshPackages for pip list');
    });

    test('should NOT call refreshPackages on python script.py', async () => {
        // Mock - Terminal has venv but python script.py is not package-modifying
        const venvEnv = createMockEnvironment();

        mockTerminalEnv = {
            getEnvironment: sandbox.stub().returns(venvEnv),
        };

        mockApi = {
            refreshPackages: sandbox.stub().resolves(),
            getEnvironment: sandbox.stub(),
            getPythonProjects: sandbox.stub().returns([]),
        };

        registerTerminalPackageWatcher(mockApi, mockTerminalEnv, mockLog, disposables);

        // Run - Fire python script.py event (not package-modifying)
        shellExecutionEmitter.fire(createShellExecutionEvent('python script.py'));

        await new Promise((resolve) => setImmediate(resolve));

        // Assert
        assert.strictEqual(
            mockApi.refreshPackages.called,
            false,
            'Should not call refreshPackages for python script.py',
        );
    });

    test('should NOT call refreshPackages when no environment found', async () => {
        // Mock - No environment from any source
        mockTerminalEnv = {
            getEnvironment: sandbox.stub().returns(undefined),
        };

        getEnvironmentForTerminalStub.resolves(undefined);

        mockApi = {
            refreshPackages: sandbox.stub().resolves(),
            getEnvironment: sandbox.stub(),
            getPythonProjects: sandbox.stub().returns([]),
        };

        registerTerminalPackageWatcher(mockApi, mockTerminalEnv, mockLog, disposables);

        // Run - Fire pip install but no environment available
        shellExecutionEmitter.fire(createShellExecutionEvent('pip install requests'));

        await new Promise((resolve) => setImmediate(resolve));

        // Assert
        assert.strictEqual(
            mockApi.refreshPackages.called,
            false,
            'Should not call refreshPackages without environment',
        );
        assert.strictEqual(mockLog.error.called, false, 'Should not log error for missing env');
    });

    test('should log error when refreshPackages throws', async () => {
        // Mock - refreshPackages will throw an error
        const venvEnv = createMockEnvironment();

        mockTerminalEnv = {
            getEnvironment: sandbox.stub().returns(venvEnv),
        };

        mockApi = {
            refreshPackages: sandbox.stub().rejects(new Error('Refresh failed')),
            getEnvironment: sandbox.stub(),
            getPythonProjects: sandbox.stub().returns([]),
        };

        registerTerminalPackageWatcher(mockApi, mockTerminalEnv, mockLog, disposables);

        // Run - Fire pip install event that will fail
        shellExecutionEmitter.fire(createShellExecutionEvent('pip install requests'));

        await new Promise((resolve) => setImmediate(resolve));

        // Assert - Use sinon.match for resilient error checking
        assert.strictEqual(mockLog.error.calledOnce, true, 'Should log error once');
        assert.ok(
            mockLog.error.calledWith(sinon.match(/error.*refresh.*packages/i)),
            'Should log error about refreshing packages',
        );
    });

    test('should use terminal activated conda env over workspace venv (subproject scenario)', async () => {
        // Mock - Scenario: Root workspace has venv, but terminal has conda env activated
        const activatedCondaEnv = createMockEnvironment({
            envId: { id: 'subproject-conda', managerId: 'ms-python.python:conda' },
            displayName: 'Subproject Conda',
        });

        // Terminal is tracking the conda env that user activated
        mockTerminalEnv = {
            getEnvironment: sandbox.stub().returns(activatedCondaEnv),
        };

        mockApi = {
            refreshPackages: sandbox.stub().resolves(),
            getEnvironment: sandbox.stub(),
            getPythonProjects: sandbox.stub().returns([]),
        };

        registerTerminalPackageWatcher(mockApi, mockTerminalEnv, mockLog, disposables);

        // Run - Fire pip install event
        shellExecutionEmitter.fire(createShellExecutionEvent('pip install requests'));

        await new Promise((resolve) => setImmediate(resolve));

        // Assert - Should use conda env from terminal activation, not workspace heuristics
        assert.strictEqual(mockApi.refreshPackages.calledOnce, true, 'Should call refreshPackages once');
        assert.strictEqual(
            mockApi.refreshPackages.calledWith(activatedCondaEnv),
            true,
            'Should refresh the activated conda environment',
        );
        assert.strictEqual(getEnvironmentForTerminalStub.called, false, 'Should not fall back to workspace heuristics');
    });

    test('should fall back to workspace environment when terminal has no tracked activation', async () => {
        // Mock - Terminal has no tracked activation, fallback provides workspace venv
        const workspaceVenv = createMockEnvironment({
            envId: { id: 'workspace-venv', managerId: 'ms-python.python:venv' },
            displayName: 'Workspace Venv',
        });

        // Terminal has no tracked activation
        mockTerminalEnv = {
            getEnvironment: sandbox.stub().returns(undefined),
        };

        // Fallback returns workspace venv
        getEnvironmentForTerminalStub.resolves(workspaceVenv);

        mockApi = {
            refreshPackages: sandbox.stub().resolves(),
            getEnvironment: sandbox.stub(),
            getPythonProjects: sandbox.stub().returns([]),
        };

        registerTerminalPackageWatcher(mockApi, mockTerminalEnv, mockLog, disposables);

        // Run - Fire pip install event
        shellExecutionEmitter.fire(createShellExecutionEvent('pip install requests'));

        await new Promise((resolve) => setImmediate(resolve));

        // Assert - Should fall back to workspace heuristics
        assert.strictEqual(mockApi.refreshPackages.calledOnce, true, 'Should call refreshPackages once');
        assert.strictEqual(
            mockApi.refreshPackages.calledWith(workspaceVenv),
            true,
            'Should refresh the workspace venv from fallback',
        );
        assert.strictEqual(getEnvironmentForTerminalStub.calledOnce, true, 'Should use fallback heuristics');
    });
});
