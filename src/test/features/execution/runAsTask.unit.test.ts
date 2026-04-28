import * as assert from 'assert';
import * as sinon from 'sinon';
import { ShellExecution, Task, TaskExecution, TaskPanelKind, TaskRevealKind, TaskScope, Uri, WorkspaceFolder } from 'vscode';
import { PythonEnvironment, PythonTaskExecutionOptions } from '../../../api';
import * as logging from '../../../common/logging';
import * as tasksApi from '../../../common/tasks.apis';
import * as workspaceApis from '../../../common/workspace.apis';
import * as execUtils from '../../../features/execution/execUtils';
import { runAsTask } from '../../../features/execution/runAsTask';
import * as builtinHelpers from '../../../managers/builtin/helpers';

suite('runAsTask Tests', () => {
    let mockTraceInfo: sinon.SinonStub;
    let mockTraceWarn: sinon.SinonStub;
    let mockExecuteTask: sinon.SinonStub;
    let mockGetWorkspaceFolder: sinon.SinonStub;
    let mockQuoteStringIfNecessary: sinon.SinonStub;
    let mockShouldUseUv: sinon.SinonStub;

    setup(() => {
        mockTraceInfo = sinon.stub(logging, 'traceInfo');
        mockTraceWarn = sinon.stub(logging, 'traceWarn');
        mockExecuteTask = sinon.stub(tasksApi, 'executeTask');
        mockGetWorkspaceFolder = sinon.stub(workspaceApis, 'getWorkspaceFolder');
        mockQuoteStringIfNecessary = sinon.stub(execUtils, 'quoteStringIfNecessary');
        mockShouldUseUv = sinon.stub(builtinHelpers, 'shouldUseUv').resolves(false);
    });

    teardown(() => {
        sinon.restore();
    });

    suite('Happy Path Scenarios', () => {
        test('should create and execute task with activated run configuration', async () => {
            // Mock - Environment with activatedRun
            const environment: PythonEnvironment = {
                envId: { id: 'test-env', managerId: 'test-manager' },
                name: 'Test Environment',
                displayName: 'Test Environment',
                shortDisplayName: 'TestEnv',
                displayPath: '/path/to/env',
                version: '3.9.0',
                environmentPath: Uri.file('/path/to/env'),
                execInfo: {
                    run: {
                        executable: '/path/to/python',
                        args: ['--default'],
                    },
                    activatedRun: {
                        executable: '/activated/python',
                        args: ['--activated'],
                    },
                },
                sysPrefix: '/path/to/env',
            };

            const options: PythonTaskExecutionOptions = {
                name: 'Test Task',
                args: ['script.py', '--arg1'],
                project: {
                    name: 'Test Project',
                    uri: Uri.file('/workspace'),
                },
                cwd: '/workspace',
                env: { PATH: '/custom/path' },
            };

            const mockWorkspaceFolder: WorkspaceFolder = {
                uri: Uri.file('/workspace'),
                name: 'Test Workspace',
                index: 0,
            };

            const mockTaskExecution = {} as TaskExecution;

            mockGetWorkspaceFolder.withArgs(options.project?.uri).returns(mockWorkspaceFolder);
            mockQuoteStringIfNecessary.withArgs('/activated/python').returns('"/activated/python"');
            mockExecuteTask.resolves(mockTaskExecution);

            // Run
            const result = await runAsTask(environment, options);

            // Assert
            assert.strictEqual(result, mockTaskExecution, 'Should return the task execution result');

            // Verify task creation
            assert.ok(mockExecuteTask.calledOnce, 'Should execute task once');
            const taskArg = mockExecuteTask.firstCall.args[0] as Task;

            assert.strictEqual(taskArg.definition.type, 'python', 'Task type should be python');
            assert.strictEqual(taskArg.scope, mockWorkspaceFolder, 'Task scope should be workspace folder');
            assert.strictEqual(taskArg.name, 'Test Task', 'Task name should match options');
            assert.strictEqual(taskArg.source, 'Python', 'Task source should be Python');
            assert.deepStrictEqual(taskArg.problemMatchers, ['$python'], 'Should use python problem matcher');

            // Verify presentation options
            assert.strictEqual(
                taskArg.presentationOptions?.reveal,
                TaskRevealKind.Silent,
                'Should use silent reveal by default',
            );
            assert.strictEqual(taskArg.presentationOptions?.echo, true, 'Should echo commands');
            assert.strictEqual(taskArg.presentationOptions?.panel, TaskPanelKind.Shared, 'Should use shared panel');
            assert.strictEqual(taskArg.presentationOptions?.close, false, 'Should not close panel');
            assert.strictEqual(taskArg.presentationOptions?.showReuseMessage, true, 'Should show reuse message');

            // Verify logging
            assert.ok(
                mockTraceInfo.calledWith(
                    sinon.match(/Running as task: "\/activated\/python" --activated script\.py --arg1/),
                ),
                'Should log execution command',
            );

            // Verify no warnings
            assert.ok(mockTraceWarn.notCalled, 'Should not log warnings for valid environment');
        });

        test('should use uv run when uv mode applies', async () => {
            const environment: PythonEnvironment = {
                envId: { id: 'test-env', managerId: 'test-manager' },
                name: 'Test Environment',
                displayName: 'Test Environment',
                shortDisplayName: 'TestEnv',
                displayPath: '/path/to/env',
                version: '3.9.0',
                environmentPath: Uri.file('/path/to/env'),
                execInfo: {
                    run: {
                        executable: '/path/to/python',
                        args: ['--default'],
                    },
                    activatedRun: {
                        executable: '/activated/python',
                        args: ['--activated'],
                    },
                },
                sysPrefix: '/path/to/env',
            };

            const options: PythonTaskExecutionOptions = {
                name: 'UV Task',
                args: ['script.py', '--arg1'],
            };

            const mockTaskExecution = {} as TaskExecution;

            mockGetWorkspaceFolder.returns(undefined);
            mockShouldUseUv.withArgs(undefined, environment.environmentPath.fsPath).resolves(true);
            mockQuoteStringIfNecessary.withArgs('uv').returns('uv');
            mockExecuteTask.resolves(mockTaskExecution);

            const result = await runAsTask(environment, options);

            assert.strictEqual(result, mockTaskExecution, 'Should return the task execution result');

            const taskArg = mockExecuteTask.firstCall.args[0] as Task;
            const execution = taskArg.execution as ShellExecution;

            assert.strictEqual(execution.command, 'uv', 'Should execute uv when uv mode is enabled');
            assert.deepStrictEqual(
                execution.args,
                ['run', '--python', '/activated/python', '--activated', 'script.py', '--arg1'],
                'Should prepend uv run arguments before the file arguments',
            );
            assert.ok(
                mockTraceInfo.calledWith(
                    sinon.match(/Running as task: uv run --python \/activated\/python --activated script\.py --arg1/),
                ),
                'Should log the uv run command',
            );
        });

        test('should quote uv executable when needed', async () => {
            const environment: PythonEnvironment = {
                envId: { id: 'test-env', managerId: 'test-manager' },
                name: 'Test Environment',
                displayName: 'Test Environment',
                displayPath: '/path/to/env',
                version: '3.9.0',
                environmentPath: Uri.file('/path/to/env'),
                execInfo: {
                    run: {
                        executable: '/path/to/python',
                        args: [],
                    },
                },
                sysPrefix: '/path/to/env',
            };

            const options: PythonTaskExecutionOptions = {
                name: 'Quoted UV Task',
                args: ['script.py'],
            };

            const mockTaskExecution = {} as TaskExecution;

            mockGetWorkspaceFolder.returns(undefined);
            mockShouldUseUv.withArgs(undefined, environment.environmentPath.fsPath, undefined).resolves(true);
            mockQuoteStringIfNecessary.withArgs('uv').returns('"uv"');
            mockExecuteTask.resolves(mockTaskExecution);

            await runAsTask(environment, options);

            const taskArg = mockExecuteTask.firstCall.args[0] as Task;
            const execution = taskArg.execution as ShellExecution;

            assert.strictEqual(execution.command, '"uv"', 'Should quote the uv executable when required');
            assert.deepStrictEqual(
                execution.args,
                ['run', '--python', '/path/to/python', 'script.py'],
                'Should preserve uv arguments when quoting the executable',
            );
        });

        test('should create and execute task with regular run configuration when no activatedRun', async () => {
            // Mock - Environment without activatedRun
            const environment: PythonEnvironment = {
                envId: { id: 'test-env', managerId: 'test-manager' },
                name: 'Test Environment',
                displayName: 'Test Environment',
                displayPath: '/path/to/env',
                version: '3.9.0',
                environmentPath: Uri.file('/path/to/env'),
                execInfo: {
                    run: {
                        executable: '/path/to/python',
                        args: ['--default-arg'],
                    },
                },
                sysPrefix: '/path/to/env',
            };

            const options: PythonTaskExecutionOptions = {
                name: 'Simple Task',
                args: ['test.py'],
            };

            const mockTaskExecution = {} as TaskExecution;

            mockGetWorkspaceFolder.withArgs(undefined).returns(undefined);
            mockShouldUseUv.withArgs(undefined, environment.environmentPath.fsPath, undefined).resolves(false);
            mockQuoteStringIfNecessary.withArgs('/path/to/python').returns('/path/to/python');
            mockExecuteTask.resolves(mockTaskExecution);

            // Run
            const result = await runAsTask(environment, options);

            // Assert
            assert.strictEqual(result, mockTaskExecution, 'Should return the task execution result');

            const taskArg = mockExecuteTask.firstCall.args[0] as Task;
            assert.strictEqual(taskArg.scope, TaskScope.Global, 'Should use global scope when no workspace');

            // Verify logging shows correct executable and args
            assert.ok(
                mockTraceInfo.calledWith(sinon.match(/Running as task: \/path\/to\/python --default-arg test\.py/)),
                'Should log execution with run args',
            );
            const execution = taskArg.execution as ShellExecution;
            assert.strictEqual(execution.command, '/path/to/python', 'Should keep the python executable when uv is off');
            assert.deepStrictEqual(execution.args, ['--default-arg', 'test.py'], 'Should keep the non-uv arguments');
        });

        test('should handle custom reveal option', async () => {
            // Mock - Test custom reveal option
            const environment: PythonEnvironment = {
                envId: { id: 'test-env', managerId: 'test-manager' },
                name: 'Test Environment',
                displayName: 'Test Environment',
                displayPath: '/path/to/env',
                version: '3.9.0',
                environmentPath: Uri.file('/path/to/env'),
                execInfo: {
                    run: {
                        executable: 'python',
                        args: [],
                    },
                },
                sysPrefix: '/path/to/env',
            };

            const options: PythonTaskExecutionOptions = {
                name: 'Reveal Task',
                args: ['script.py'],
            };

            const mockTaskExecution = {} as TaskExecution;

            mockGetWorkspaceFolder.returns(undefined);
            mockQuoteStringIfNecessary.withArgs('python').returns('python');
            mockExecuteTask.resolves(mockTaskExecution);

            // Run with custom reveal option
            await runAsTask(environment, options, { reveal: TaskRevealKind.Always });

            // Assert
            const taskArg = mockExecuteTask.firstCall.args[0] as Task;
            assert.strictEqual(
                taskArg.presentationOptions?.reveal,
                TaskRevealKind.Always,
                'Should use custom reveal option',
            );
        });
    });

    suite('Edge Cases', () => {
        test('should handle environment without execInfo', async () => {
            // Mock - Environment with no execInfo
            const environment: PythonEnvironment = {
                envId: { id: 'test-env', managerId: 'test-manager' },
                name: 'Test Environment',
                displayName: 'Test Environment',
                displayPath: '/path/to/env',
                version: '3.9.0',
                environmentPath: Uri.file('/path/to/env'),
                sysPrefix: '/path/to/env',
            } as PythonEnvironment;

            const options: PythonTaskExecutionOptions = {
                name: 'No ExecInfo Task',
                args: ['script.py'],
            };

            const mockTaskExecution = {} as TaskExecution;

            mockGetWorkspaceFolder.returns(undefined);
            mockQuoteStringIfNecessary.withArgs('python').returns('python');
            mockExecuteTask.resolves(mockTaskExecution);

            // Run
            const result = await runAsTask(environment, options);

            // Assert
            assert.strictEqual(result, mockTaskExecution, 'Should return the task execution result');

            // Verify fallback to 'python' and warning
            assert.ok(
                mockTraceWarn.calledWith('No Python executable found in environment; falling back to "python".'),
                'Should warn about missing executable',
            );
            assert.ok(
                mockTraceInfo.calledWith(sinon.match(/Running as task: python script\.py/)),
                'Should log with fallback executable',
            );
        });

        test('should handle environment with empty execInfo run args', async () => {
            // Mock - Environment with empty args
            const environment: PythonEnvironment = {
                envId: { id: 'test-env', managerId: 'test-manager' },
                name: 'Test Environment',
                displayName: 'Test Environment',
                displayPath: '/path/to/env',
                version: '3.9.0',
                environmentPath: Uri.file('/path/to/env'),
                execInfo: {
                    run: {
                        executable: '/path/to/python',
                        // No args provided
                    },
                },
                sysPrefix: '/path/to/env',
            };

            const options: PythonTaskExecutionOptions = {
                name: 'Empty Args Task',
                args: ['script.py', '--verbose'],
            };

            const mockTaskExecution = {} as TaskExecution;

            mockGetWorkspaceFolder.returns(undefined);
            mockQuoteStringIfNecessary.withArgs('/path/to/python').returns('/path/to/python');
            mockExecuteTask.resolves(mockTaskExecution);

            // Run
            const result = await runAsTask(environment, options);

            // Assert
            assert.strictEqual(result, mockTaskExecution, 'Should return the task execution result');

            // Verify only option args are used
            assert.ok(
                mockTraceInfo.calledWith(sinon.match(/Running as task: \/path\/to\/python script\.py --verbose/)),
                'Should log with only option args',
            );
        });

        test('should handle options with no args', async () => {
            // Mock - Options with empty args
            const environment: PythonEnvironment = {
                envId: { id: 'test-env', managerId: 'test-manager' },
                name: 'Test Environment',
                displayName: 'Test Environment',
                displayPath: '/path/to/env',
                version: '3.9.0',
                environmentPath: Uri.file('/path/to/env'),
                execInfo: {
                    run: {
                        executable: 'python',
                        args: ['--version-check'],
                    },
                },
                sysPrefix: '/path/to/env',
            };

            const options: PythonTaskExecutionOptions = {
                name: 'No Args Task',
                args: [], // Empty args
            };

            const mockTaskExecution = {} as TaskExecution;

            mockGetWorkspaceFolder.returns(undefined);
            mockQuoteStringIfNecessary.withArgs('python').returns('python');
            mockExecuteTask.resolves(mockTaskExecution);

            // Run
            const result = await runAsTask(environment, options);

            // Assert
            assert.strictEqual(result, mockTaskExecution, 'Should return the task execution result');

            // Verify only environment args are used
            assert.ok(
                mockTraceInfo.calledWith(sinon.match(/Running as task: python --version-check/)),
                'Should log with only environment args',
            );
        });

        test('should handle executable paths with spaces requiring quoting', async () => {
            // Mock - Executable path with spaces
            const environment: PythonEnvironment = {
                envId: { id: 'test-env', managerId: 'test-manager' },
                name: 'Test Environment',
                displayName: 'Test Environment',
                displayPath: '/path/to/env',
                version: '3.9.0',
                environmentPath: Uri.file('/path/to/env'),
                execInfo: {
                    run: {
                        executable: '/path with spaces/to/python',
                        args: [],
                    },
                },
                sysPrefix: '/path/to/env',
            };

            const options: PythonTaskExecutionOptions = {
                name: 'Spaced Path Task',
                args: ['script.py'],
            };

            const mockTaskExecution = {} as TaskExecution;

            mockGetWorkspaceFolder.returns(undefined);
            mockQuoteStringIfNecessary.withArgs('/path with spaces/to/python').returns('"/path with spaces/to/python"');
            mockExecuteTask.resolves(mockTaskExecution);

            // Run
            const result = await runAsTask(environment, options);

            // Assert
            assert.strictEqual(result, mockTaskExecution, 'Should return the task execution result');

            // Verify quoting function is called
            assert.ok(
                mockQuoteStringIfNecessary.calledWith('/path with spaces/to/python'),
                'Should call quoting function for executable',
            );
            assert.ok(
                mockTraceInfo.calledWith(sinon.match(/Running as task: "\/path with spaces\/to\/python" script\.py/)),
                'Should log with quoted executable',
            );
        });
    });

    suite('UV Mode Scenarios', () => {
        test('should pass project URI as scope to shouldUseUv', async () => {
            // Mock - Verify per-folder setting precedence by passing project.uri as the scope
            const projectUri = Uri.file('/workspace/project');
            const environment: PythonEnvironment = {
                envId: { id: 'test-env', managerId: 'test-manager' },
                name: 'Test Environment',
                displayName: 'Test Environment',
                displayPath: '/path/to/env',
                version: '3.9.0',
                environmentPath: Uri.file('/path/to/env'),
                execInfo: {
                    run: { executable: '/path/to/python', args: [] },
                },
                sysPrefix: '/path/to/env',
            };

            const options: PythonTaskExecutionOptions = {
                name: 'Scoped Task',
                args: ['script.py'],
                project: { name: 'Test Project', uri: projectUri },
            };

            mockGetWorkspaceFolder.withArgs(projectUri).returns(undefined);
            mockShouldUseUv.resolves(false);
            mockQuoteStringIfNecessary.withArgs('/path/to/python').returns('/path/to/python');
            mockExecuteTask.resolves({} as TaskExecution);

            // Run
            await runAsTask(environment, options);

            // Assert - shouldUseUv was called with the project URI as the third (scope) argument
            assert.ok(
                mockShouldUseUv.calledWith(undefined, environment.environmentPath.fsPath, projectUri),
                'Should pass project URI as the scope argument to shouldUseUv',
            );
        });

        test('should pass undefined scope to shouldUseUv when project is not provided', async () => {
            // Mock - No project means no scope, so shouldUseUv resolves the user/global setting
            const environment: PythonEnvironment = {
                envId: { id: 'test-env', managerId: 'test-manager' },
                name: 'Test Environment',
                displayName: 'Test Environment',
                displayPath: '/path/to/env',
                version: '3.9.0',
                environmentPath: Uri.file('/path/to/env'),
                execInfo: {
                    run: { executable: '/path/to/python', args: [] },
                },
                sysPrefix: '/path/to/env',
            };

            const options: PythonTaskExecutionOptions = {
                name: 'No-Scope Task',
                args: ['script.py'],
            };

            mockGetWorkspaceFolder.returns(undefined);
            mockShouldUseUv.resolves(false);
            mockQuoteStringIfNecessary.withArgs('/path/to/python').returns('/path/to/python');
            mockExecuteTask.resolves({} as TaskExecution);

            // Run
            await runAsTask(environment, options);

            // Assert - third argument is explicitly undefined when project is missing
            assert.ok(
                mockShouldUseUv.calledWith(undefined, environment.environmentPath.fsPath, undefined),
                'Should pass undefined scope when no project is provided',
            );
        });

        test('should fall back to run.executable in --python when activatedRun is missing under uv', async () => {
            // Mock - Env has only run, no activatedRun; uv mode is on
            const environment: PythonEnvironment = {
                envId: { id: 'test-env', managerId: 'test-manager' },
                name: 'Test Environment',
                displayName: 'Test Environment',
                displayPath: '/path/to/env',
                version: '3.9.0',
                environmentPath: Uri.file('/path/to/env'),
                execInfo: {
                    run: { executable: '/path/to/python', args: ['-X', 'utf8'] },
                },
                sysPrefix: '/path/to/env',
            };

            const options: PythonTaskExecutionOptions = {
                name: 'Fallback Run UV Task',
                args: ['script.py'],
            };

            mockGetWorkspaceFolder.returns(undefined);
            mockShouldUseUv.resolves(true);
            mockQuoteStringIfNecessary.withArgs('uv').returns('uv');
            mockExecuteTask.resolves({} as TaskExecution);

            // Run
            await runAsTask(environment, options);

            // Assert
            const taskArg = mockExecuteTask.firstCall.args[0] as Task;
            const execution = taskArg.execution as ShellExecution;
            assert.strictEqual(execution.command, 'uv', 'Should execute uv when uv mode is enabled');
            assert.deepStrictEqual(
                execution.args,
                ['run', '--python', '/path/to/python', '-X', 'utf8', 'script.py'],
                'Should use run.executable as --python value and preserve run.args',
            );
        });

        test('should use python literal under uv when execInfo is missing', async () => {
            // Mock - No execInfo at all; we fall back to the literal "python" and still run via uv
            const environment: PythonEnvironment = {
                envId: { id: 'test-env', managerId: 'test-manager' },
                name: 'Test Environment',
                displayName: 'Test Environment',
                displayPath: '/path/to/env',
                version: '3.9.0',
                environmentPath: Uri.file('/path/to/env'),
                sysPrefix: '/path/to/env',
            } as PythonEnvironment;

            const options: PythonTaskExecutionOptions = {
                name: 'No ExecInfo UV Task',
                args: ['script.py'],
            };

            mockGetWorkspaceFolder.returns(undefined);
            mockShouldUseUv.resolves(true);
            mockQuoteStringIfNecessary.withArgs('uv').returns('uv');
            mockExecuteTask.resolves({} as TaskExecution);

            // Run
            await runAsTask(environment, options);

            // Assert - warns about missing executable AND wraps the literal "python" under uv
            assert.ok(
                mockTraceWarn.calledWith('No Python executable found in environment; falling back to "python".'),
                'Should warn about missing executable',
            );
            const taskArg = mockExecuteTask.firstCall.args[0] as Task;
            const execution = taskArg.execution as ShellExecution;
            assert.strictEqual(execution.command, 'uv', 'Should execute uv even when execInfo is missing');
            assert.deepStrictEqual(
                execution.args,
                ['run', '--python', 'python', 'script.py'],
                'Should pass the literal "python" fallback as the --python argument',
            );
        });

        test('should preserve a Windows-style python path verbatim as --python argument under uv', async () => {
            // Mock - Windows backslash path; the python path now flows as a uv argument, not the executable
            const winPython = 'C:\\Users\\me\\.venv\\Scripts\\python.exe';
            const environment: PythonEnvironment = {
                envId: { id: 'test-env', managerId: 'test-manager' },
                name: 'Test Environment',
                displayName: 'Test Environment',
                displayPath: 'C:\\Users\\me\\.venv',
                version: '3.11.0',
                environmentPath: Uri.file(winPython),
                execInfo: {
                    run: { executable: winPython, args: [] },
                },
                sysPrefix: 'C:\\Users\\me\\.venv',
            };

            const options: PythonTaskExecutionOptions = {
                name: 'Windows UV Task',
                args: ['script.py'],
            };

            mockGetWorkspaceFolder.returns(undefined);
            mockShouldUseUv.resolves(true);
            mockQuoteStringIfNecessary.withArgs('uv').returns('uv');
            mockExecuteTask.resolves({} as TaskExecution);

            // Run
            await runAsTask(environment, options);

            // Assert - the --python value matches the input path string (not quoted via quoteStringIfNecessary)
            const taskArg = mockExecuteTask.firstCall.args[0] as Task;
            const execution = taskArg.execution as ShellExecution;
            assert.strictEqual(execution.command, 'uv', 'Should execute uv when uv mode is enabled');
            assert.deepStrictEqual(
                execution.args,
                ['run', '--python', winPython, 'script.py'],
                'Should preserve the Windows-style path verbatim as the --python value',
            );
            // quoteStringIfNecessary should not be called for the python path under uv (only for the executable)
            assert.ok(
                !mockQuoteStringIfNecessary.calledWith(winPython),
                'Should not quote the python path when it is a uv argument',
            );
        });

        test('should append user args after env activated args under uv', async () => {
            // Mock - Env supplies activatedRun.args; ensure ordering: run --python <py> <env-args> <user-args>
            const environment: PythonEnvironment = {
                envId: { id: 'test-env', managerId: 'test-manager' },
                name: 'Test Environment',
                displayName: 'Test Environment',
                displayPath: '/path/to/env',
                version: '3.9.0',
                environmentPath: Uri.file('/path/to/env'),
                execInfo: {
                    run: { executable: '/path/to/python', args: ['--default'] },
                    activatedRun: {
                        executable: '/activated/python',
                        args: ['-X', 'utf8'],
                    },
                },
                sysPrefix: '/path/to/env',
            };

            const options: PythonTaskExecutionOptions = {
                name: 'Args Order UV Task',
                args: ['script.py', '--user-arg'],
            };

            mockGetWorkspaceFolder.returns(undefined);
            mockShouldUseUv.resolves(true);
            mockQuoteStringIfNecessary.withArgs('uv').returns('uv');
            mockExecuteTask.resolves({} as TaskExecution);

            // Run
            await runAsTask(environment, options);

            // Assert
            const taskArg = mockExecuteTask.firstCall.args[0] as Task;
            const execution = taskArg.execution as ShellExecution;
            assert.deepStrictEqual(
                execution.args,
                ['run', '--python', '/activated/python', '-X', 'utf8', 'script.py', '--user-arg'],
                'Env activated args should sit between --python and the user args',
            );
        });

        test('should pass user args containing flags through to python under uv (regression guard)', async () => {
            // Mock - The run button only ever appends a file path, but API callers can pass arbitrary args.
            // This guards the contract that user args land after the script positional and are NOT consumed by uv.
            const environment: PythonEnvironment = {
                envId: { id: 'test-env', managerId: 'test-manager' },
                name: 'Test Environment',
                displayName: 'Test Environment',
                displayPath: '/path/to/env',
                version: '3.9.0',
                environmentPath: Uri.file('/path/to/env'),
                execInfo: {
                    run: { executable: '/path/to/python', args: [] },
                },
                sysPrefix: '/path/to/env',
            };

            const options: PythonTaskExecutionOptions = {
                name: 'Flag Args UV Task',
                args: ['script.py', '--user-flag', 'value'],
            };

            mockGetWorkspaceFolder.returns(undefined);
            mockShouldUseUv.resolves(true);
            mockQuoteStringIfNecessary.withArgs('uv').returns('uv');
            mockExecuteTask.resolves({} as TaskExecution);

            // Run
            await runAsTask(environment, options);

            // Assert - the user flag appears after the script path (i.e. it goes to python, not uv).
            const taskArg = mockExecuteTask.firstCall.args[0] as Task;
            const execution = taskArg.execution as ShellExecution;
            assert.deepStrictEqual(
                execution.args,
                ['run', '--python', '/path/to/python', 'script.py', '--user-flag', 'value'],
                'User args should be appended after --python <path> in the order provided',
            );
        });
    });

    suite('Workspace Resolution', () => {
        test('should use workspace folder when project URI is provided', async () => {
            // Mock - Test workspace resolution
            const environment: PythonEnvironment = {
                envId: { id: 'test-env', managerId: 'test-manager' },
                name: 'Test Environment',
                displayName: 'Test Environment',
                displayPath: '/path/to/env',
                version: '3.9.0',
                environmentPath: Uri.file('/path/to/env'),
                execInfo: {
                    run: {
                        executable: 'python',
                        args: [],
                    },
                },
                sysPrefix: '/path/to/env',
            };

            const projectUri = Uri.file('/workspace/project');
            const options: PythonTaskExecutionOptions = {
                name: 'Workspace Task',
                args: ['script.py'],
                project: {
                    name: 'Test Project',
                    uri: projectUri,
                },
            };

            const mockWorkspaceFolder: WorkspaceFolder = {
                uri: Uri.file('/workspace'),
                name: 'Workspace',
                index: 0,
            };

            const mockTaskExecution = {} as TaskExecution;

            mockGetWorkspaceFolder.withArgs(projectUri).returns(mockWorkspaceFolder);
            mockQuoteStringIfNecessary.withArgs('python').returns('python');
            mockExecuteTask.resolves(mockTaskExecution);

            // Run
            const result = await runAsTask(environment, options);

            // Assert
            assert.strictEqual(result, mockTaskExecution, 'Should return the task execution result');

            const taskArg = mockExecuteTask.firstCall.args[0] as Task;
            assert.strictEqual(taskArg.scope, mockWorkspaceFolder, 'Should use resolved workspace folder as scope');

            // Verify workspace lookup was called correctly
            assert.ok(
                mockGetWorkspaceFolder.calledWith(projectUri),
                'Should look up workspace folder with project URI',
            );
        });

        test('should use global scope when no workspace folder found', async () => {
            // Mock - No workspace folder found
            const environment: PythonEnvironment = {
                envId: { id: 'test-env', managerId: 'test-manager' },
                name: 'Test Environment',
                displayName: 'Test Environment',
                displayPath: '/path/to/env',
                version: '3.9.0',
                environmentPath: Uri.file('/path/to/env'),
                execInfo: {
                    run: {
                        executable: 'python',
                        args: [],
                    },
                },
                sysPrefix: '/path/to/env',
            };

            const options: PythonTaskExecutionOptions = {
                name: 'Global Task',
                args: ['script.py'],
                project: {
                    name: 'Test Project',
                    uri: Uri.file('/non-workspace/project'),
                },
            };

            const mockTaskExecution = {} as TaskExecution;

            mockGetWorkspaceFolder.returns(undefined);
            mockQuoteStringIfNecessary.withArgs('python').returns('python');
            mockExecuteTask.resolves(mockTaskExecution);

            // Run
            const result = await runAsTask(environment, options);

            // Assert
            assert.strictEqual(result, mockTaskExecution, 'Should return the task execution result');

            const taskArg = mockExecuteTask.firstCall.args[0] as Task;
            assert.strictEqual(
                taskArg.scope,
                TaskScope.Global,
                'Should fallback to global scope when workspace not found',
            );
        });
    });

    suite('Task Configuration', () => {
        test('should correctly combine environment and option args', async () => {
            // Mock - Test arg combination
            const environment: PythonEnvironment = {
                envId: { id: 'test-env', managerId: 'test-manager' },
                name: 'Test Environment',
                displayName: 'Test Environment',
                displayPath: '/path/to/env',
                version: '3.9.0',
                environmentPath: Uri.file('/path/to/env'),
                execInfo: {
                    activatedRun: {
                        executable: 'python',
                        args: ['--env-arg1', '--env-arg2'],
                    },
                    run: {
                        executable: 'fallback-python',
                        args: ['--fallback'],
                    },
                },
                sysPrefix: '/path/to/env',
            };

            const options: PythonTaskExecutionOptions = {
                name: 'Combined Args Task',
                args: ['--opt-arg1', 'script.py', '--opt-arg2'],
            };

            const mockTaskExecution = {} as TaskExecution;

            mockGetWorkspaceFolder.returns(undefined);
            mockQuoteStringIfNecessary.withArgs('python').returns('python');
            mockExecuteTask.resolves(mockTaskExecution);

            // Run
            const result = await runAsTask(environment, options);

            // Assert
            assert.strictEqual(result, mockTaskExecution, 'Should return the task execution result');

            // Verify args are combined correctly (environment args first, then option args)
            assert.ok(
                mockTraceInfo.calledWith(
                    sinon.match(/Running as task: python --env-arg1 --env-arg2 --opt-arg1 script\.py --opt-arg2/),
                ),
                'Should log with combined args in correct order',
            );
        });

        test('should pass through cwd and env options to shell execution', async () => {
            // Mock - Test shell execution options
            const environment: PythonEnvironment = {
                envId: { id: 'test-env', managerId: 'test-manager' },
                name: 'Test Environment',
                displayName: 'Test Environment',
                displayPath: '/path/to/env',
                version: '3.9.0',
                environmentPath: Uri.file('/path/to/env'),
                execInfo: {
                    run: {
                        executable: 'python',
                        args: [],
                    },
                },
                sysPrefix: '/path/to/env',
            };

            const options: PythonTaskExecutionOptions = {
                name: 'Shell Options Task',
                args: ['script.py'],
                cwd: '/custom/working/dir',
                env: {
                    CUSTOM_VAR: 'custom_value',
                    PATH: '/custom/path',
                },
            };

            const mockTaskExecution = {} as TaskExecution;

            mockGetWorkspaceFolder.returns(undefined);
            mockQuoteStringIfNecessary.withArgs('python').returns('python');
            mockExecuteTask.resolves(mockTaskExecution);

            // Run
            const result = await runAsTask(environment, options);

            // Assert
            assert.strictEqual(result, mockTaskExecution, 'Should return the task execution result');

            const taskArg = mockExecuteTask.firstCall.args[0] as Task;

            // Verify shell execution was created with correct options
            // Note: We can't easily inspect ShellExecution internals, but we can verify the task was created
            assert.ok(taskArg.execution, 'Task should have execution configured');
            assert.strictEqual(taskArg.name, 'Shell Options Task', 'Task should have correct name');
        });
    });

    suite('Error Scenarios', () => {
        test('should propagate task execution failures', async () => {
            // Mock - Task execution failure
            const environment: PythonEnvironment = {
                envId: { id: 'test-env', managerId: 'test-manager' },
                name: 'Test Environment',
                displayName: 'Test Environment',
                displayPath: '/path/to/env',
                version: '3.9.0',
                environmentPath: Uri.file('/path/to/env'),
                execInfo: {
                    run: {
                        executable: 'python',
                        args: [],
                    },
                },
                sysPrefix: '/path/to/env',
            };

            const options: PythonTaskExecutionOptions = {
                name: 'Failing Task',
                args: ['script.py'],
            };

            const executionError = new Error('Task execution failed');

            mockGetWorkspaceFolder.returns(undefined);
            mockQuoteStringIfNecessary.withArgs('python').returns('python');
            mockExecuteTask.rejects(executionError);

            // Run & Assert
            await assert.rejects(
                () => runAsTask(environment, options),
                executionError,
                'Should propagate task execution error',
            );

            // Verify logging still occurred before failure
            assert.ok(
                mockTraceInfo.calledWith(sinon.match(/Running as task: python script\.py/)),
                'Should log before execution attempt',
            );
        });
    });

    suite('Integration Scenarios', () => {
        test('should work with minimal environment and options', async () => {
            // Mock - Minimal valid configuration
            const environment: PythonEnvironment = {
                envId: { id: 'minimal-env', managerId: 'minimal-manager' },
                name: 'Minimal Environment',
                displayName: 'Minimal Environment',
                displayPath: '/minimal/env',
                version: '3.8.0',
                environmentPath: Uri.file('/minimal/env'),
                sysPrefix: '/minimal/env',
                // No execInfo - should fallback to 'python'
            } as PythonEnvironment;

            const options: PythonTaskExecutionOptions = {
                name: 'Minimal Task',
                args: ['hello.py'],
            };

            const mockTaskExecution = {} as TaskExecution;

            mockGetWorkspaceFolder.returns(undefined);
            mockQuoteStringIfNecessary.withArgs('python').returns('python');
            mockExecuteTask.resolves(mockTaskExecution);

            // Run
            const result = await runAsTask(environment, options);

            // Assert
            assert.strictEqual(result, mockTaskExecution, 'Should successfully execute with minimal configuration');
            assert.ok(mockTraceWarn.calledOnce, 'Should warn about missing executable');
            assert.ok(
                mockTraceInfo.calledWith(sinon.match(/Running as task: python hello\.py/)),
                'Should log with fallback executable',
            );
        });

        test('should handle complex real-world scenario', async () => {
            // Mock - Complex real-world environment
            const environment: PythonEnvironment = {
                envId: { id: 'venv-1', managerId: 'virtualenv' },
                name: 'Project Virtual Environment',
                displayName: 'myproject-venv (Python 3.11.0)',
                shortDisplayName: 'myproject-venv',
                displayPath: '~/projects/myproject/.venv',
                version: '3.11.0',
                environmentPath: Uri.file('/Users/user/projects/myproject/.venv'),
                description: 'Virtual environment for myproject',
                execInfo: {
                    run: {
                        executable: '/Users/user/projects/myproject/.venv/bin/python',
                        args: [],
                    },
                    activatedRun: {
                        executable: '/Users/user/projects/myproject/.venv/bin/python',
                        args: ['-m', 'site'],
                    },
                    activation: [
                        {
                            executable: 'source',
                            args: ['/Users/user/projects/myproject/.venv/bin/activate'],
                        },
                    ],
                },
                sysPrefix: '/Users/user/projects/myproject/.venv',
                group: 'Virtual Environments',
            };

            const options: PythonTaskExecutionOptions = {
                name: 'Run Tests',
                args: ['-m', 'pytest', 'tests/', '-v', '--tb=short'],
                project: {
                    name: 'MyProject',
                    uri: Uri.file('/Users/user/projects/myproject'),
                    description: 'My Python Project',
                },
                cwd: '/Users/user/projects/myproject',
                env: {
                    PYTHONPATH: '/Users/user/projects/myproject/src',
                    TEST_ENV: 'development',
                },
            };

            const mockWorkspaceFolder: WorkspaceFolder = {
                uri: Uri.file('/Users/user/projects'),
                name: 'Projects',
                index: 0,
            };

            const mockTaskExecution = {} as TaskExecution;

            mockGetWorkspaceFolder.withArgs(options.project?.uri).returns(mockWorkspaceFolder);
            mockQuoteStringIfNecessary
                .withArgs('/Users/user/projects/myproject/.venv/bin/python')
                .returns('/Users/user/projects/myproject/.venv/bin/python');
            mockExecuteTask.resolves(mockTaskExecution);

            // Run
            const result = await runAsTask(environment, options, { reveal: TaskRevealKind.Always });

            // Assert
            assert.strictEqual(result, mockTaskExecution, 'Should handle complex real-world scenario');

            const taskArg = mockExecuteTask.firstCall.args[0] as Task;
            assert.strictEqual(taskArg.name, 'Run Tests', 'Should use correct task name');
            assert.strictEqual(taskArg.scope, mockWorkspaceFolder, 'Should use correct workspace scope');
            assert.strictEqual(
                taskArg.presentationOptions?.reveal,
                TaskRevealKind.Always,
                'Should use custom reveal setting',
            );

            // Verify complex args are logged correctly
            assert.ok(
                mockTraceInfo.calledWith(
                    sinon.match(
                        /Running as task: \/Users\/user\/projects\/myproject\/\.venv\/bin\/python -m site -m pytest tests\/ -v --tb=short/,
                    ),
                ),
                'Should log complex command with all args',
            );

            // Verify no warnings for complete environment
            assert.ok(mockTraceWarn.notCalled, 'Should not warn for complete environment configuration');
        });
    });
});
