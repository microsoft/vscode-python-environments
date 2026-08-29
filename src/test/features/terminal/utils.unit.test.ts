import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { ExtensionTerminalOptions, Terminal, TerminalOptions, Uri } from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi, PythonProject } from '../../../api';
import { VENV_MANAGER_ID } from '../../../common/constants';
import * as windowApis from '../../../common/window.apis';
import * as workspaceApis from '../../../common/workspace.apis';
import * as shellDetector from '../../../features/common/shellDetector';
import {
    ACT_TYPE_COMMAND,
    ACT_TYPE_OFF,
    ACT_TYPE_SHELL,
    AutoActivationType,
    getAutoActivationType,
    getEnvironmentForTerminal,
    shouldActivateInCurrentTerminal,
    shouldSkipTerminalActivation,
    waitForShellIntegration,
} from '../../../features/terminal/utils';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

interface MockWorkspaceConfig {
    get: sinon.SinonStub;
    inspect: sinon.SinonStub;
    update: sinon.SinonStub;
}

suite('Terminal Utils - getEnvironmentForTerminal', () => {
    const workspaceRoot = path.resolve('terminal-cwd-workspace');

    teardown(() => {
        sinon.restore();
    });

    function createProject(name: string, fsPath: string): PythonProject {
        return { name, uri: Uri.file(fsPath) } as PythonProject;
    }

    function createVenv(projectPath: string, id: string, directory: string = '.venv'): PythonEnvironment {
        const sysPrefix = path.join(projectPath, directory);
        return createMockPythonEnvironment({
            name: directory,
            id,
            managerId: VENV_MANAGER_ID,
            envPath: path.join(sysPrefix, 'bin', 'python'),
            sysPrefix,
        });
    }

    function createExternalEnvironment(id: string): PythonEnvironment {
        return createMockPythonEnvironment({
            name: id,
            id,
            managerId: 'ms-python.python:conda',
            envPath: path.resolve('external-environments', id, 'python'),
        });
    }

    function createTerminal(cwd?: string, shellCwd?: string): Terminal {
        return {
            creationOptions: cwd ? ({ cwd } as TerminalOptions) : ({} as TerminalOptions),
            shellIntegration: shellCwd ? ({ cwd: Uri.file(shellCwd) } as Terminal['shellIntegration']) : undefined,
        } as Terminal;
    }

    function createApi(
        projects: PythonProject[],
        environmentsByProject: Map<string, PythonEnvironment | undefined>,
        environments: PythonEnvironment[],
        globalEnvironment?: PythonEnvironment,
    ): PythonEnvironmentApi {
        return {
            getPythonProjects: sinon.stub().returns(projects),
            getEnvironment: sinon.stub().callsFake(async (scope: Uri | undefined) => {
                if (!scope) {
                    return globalEnvironment;
                }
                return environmentsByProject.get(scope.toString());
            }),
            getEnvironments: sinon.stub().resolves(environments),
        } as unknown as PythonEnvironmentApi;
    }

    test('preserves a workspace-root venv for terminals in project subdirectories', async () => {
        const project = createProject('workspace', workspaceRoot);
        const environment = createVenv(workspaceRoot, 'root');
        const api = createApi([project], new Map([[project.uri.toString(), environment]]), [environment]);

        const result = await getEnvironmentForTerminal(api, createTerminal(path.join(workspaceRoot, 'src')));

        assert.strictEqual(result, environment);
        sinon.assert.notCalled(api.getEnvironments as sinon.SinonStub);
    });

    test('uses the venv associated with terminal cwd instead of a sibling project venv', async () => {
        const projectA = path.join(workspaceRoot, 'ProjectA');
        const projectB = path.join(workspaceRoot, 'ProjectB');
        const projectC = path.join(workspaceRoot, 'ProjectC');
        const rootProject = createProject('workspace', workspaceRoot);
        const envA = createVenv(projectA, 'a');
        const envB = createVenv(projectB, 'b');
        const envC = createVenv(projectC, 'c');
        const api = createApi(
            [rootProject],
            new Map([[rootProject.uri.toString(), envA]]),
            [envA, envB, envC],
        );

        const result = await getEnvironmentForTerminal(api, createTerminal(projectC));

        assert.strictEqual(result, envC);
        sinon.assert.calledOnceWithExactly(api.getEnvironments as sinon.SinonStub, 'all');
    });

    test('prefers shell integration cwd over terminal creation cwd', async () => {
        const projectA = path.join(workspaceRoot, 'ProjectA');
        const projectC = path.join(workspaceRoot, 'ProjectC');
        const rootProject = createProject('workspace', workspaceRoot);
        const envA = createVenv(projectA, 'a');
        const envC = createVenv(projectC, 'c');
        const api = createApi([rootProject], new Map([[rootProject.uri.toString(), envA]]), [envA, envC]);

        const result = await getEnvironmentForTerminal(api, createTerminal(projectA, projectC));

        assert.strictEqual(result, envC);
    });

    test('returns undefined when multiple venvs are equally close to terminal cwd', async () => {
        const projectA = path.join(workspaceRoot, 'ProjectA');
        const projectC = path.join(workspaceRoot, 'ProjectC');
        const rootProject = createProject('workspace', workspaceRoot);
        const envA = createVenv(projectA, 'a');
        const envC1 = createVenv(projectC, 'c-1', '.venv');
        const envC2 = createVenv(projectC, 'c-2', 'venv');
        const api = createApi(
            [rootProject],
            new Map([[rootProject.uri.toString(), envA]]),
            [envA, envC1, envC2],
        );

        const result = await getEnvironmentForTerminal(api, createTerminal(projectC));

        assert.strictEqual(result, undefined);
    });

    test('returns undefined rather than using a sibling venv when cwd has no local venv', async () => {
        const projectA = path.join(workspaceRoot, 'ProjectA');
        const projectC = path.join(workspaceRoot, 'ProjectC');
        const rootProject = createProject('workspace', workspaceRoot);
        const envA = createVenv(projectA, 'a');
        const api = createApi([rootProject], new Map([[rootProject.uri.toString(), envA]]), [envA]);

        const result = await getEnvironmentForTerminal(api, createTerminal(projectC));

        assert.strictEqual(result, undefined);
    });

    test('does not treat a global venv as local to terminal cwd', async () => {
        const projectA = path.join(workspaceRoot, 'ProjectA');
        const projectC = path.join(workspaceRoot, 'ProjectC');
        const rootProject = createProject('workspace', workspaceRoot);
        const envA = createVenv(projectA, 'a');
        const globalEnv = createVenv(path.parse(workspaceRoot).root, 'global');
        const api = createApi(
            [rootProject],
            new Map([[rootProject.uri.toString(), envA]]),
            [envA, globalEnv],
        );

        const result = await getEnvironmentForTerminal(api, createTerminal(projectC));

        assert.strictEqual(result, undefined);
    });

    test('preserves a selected descendant venv when terminal cwd is the workspace root', async () => {
        const projectA = path.join(workspaceRoot, 'ProjectA');
        const rootProject = createProject('workspace', workspaceRoot);
        const envA = createVenv(projectA, 'a');
        const api = createApi([rootProject], new Map([[rootProject.uri.toString(), envA]]), [envA]);

        const result = await getEnvironmentForTerminal(api, createTerminal(workspaceRoot));

        assert.strictEqual(result, envA);
        sinon.assert.notCalled(api.getEnvironments as sinon.SinonStub);
    });

    test('does not infer a venv when the containing project has no selected environment', async () => {
        const projectC = path.join(workspaceRoot, 'ProjectC');
        const rootProject = createProject('workspace', workspaceRoot);
        const envC = createVenv(projectC, 'c');
        const api = createApi([rootProject], new Map([[rootProject.uri.toString(), undefined]]), [envC]);

        const result = await getEnvironmentForTerminal(api, createTerminal(projectC));

        assert.strictEqual(result, undefined);
        sinon.assert.notCalled(api.getEnvironments as sinon.SinonStub);
    });

    test('does not use another project environment when the cwd project has no selection', async () => {
        const projectAPath = path.join(workspaceRoot, 'ProjectA');
        const projectCPath = path.join(workspaceRoot, 'ProjectC');
        const projectA = createProject('ProjectA', projectAPath);
        const projectC = createProject('ProjectC', projectCPath);
        const envA = createVenv(projectAPath, 'a');
        const api = createApi(
            [projectA, projectC],
            new Map([
                [projectA.uri.toString(), envA],
                [projectC.uri.toString(), undefined],
            ]),
            [envA],
        );

        const result = await getEnvironmentForTerminal(api, createTerminal(projectCPath));

        assert.strictEqual(result, undefined);
        sinon.assert.notCalled(api.getEnvironments as sinon.SinonStub);
    });

    test('fails closed when listing environments rejects', async () => {
        const projectA = path.join(workspaceRoot, 'ProjectA');
        const projectC = path.join(workspaceRoot, 'ProjectC');
        const rootProject = createProject('workspace', workspaceRoot);
        const envA = createVenv(projectA, 'a');
        const api = createApi([rootProject], new Map([[rootProject.uri.toString(), envA]]), [envA]);
        (api.getEnvironments as sinon.SinonStub).rejects(new Error('lookup failed'));

        const result = await getEnvironmentForTerminal(api, createTerminal(projectC));

        assert.strictEqual(result, undefined);
    });

    test('fails closed when listing environments times out', async () => {
        const clock = sinon.useFakeTimers();
        const projectA = path.join(workspaceRoot, 'ProjectA');
        const projectC = path.join(workspaceRoot, 'ProjectC');
        const rootProject = createProject('workspace', workspaceRoot);
        const envA = createVenv(projectA, 'a');
        const api = createApi([rootProject], new Map([[rootProject.uri.toString(), envA]]), [envA]);
        (api.getEnvironments as sinon.SinonStub).returns(new Promise<PythonEnvironment[]>(() => undefined));

        const resultPromise = getEnvironmentForTerminal(api, createTerminal(projectC));
        await clock.tickAsync(1000);

        assert.strictEqual(await resultPromise, undefined);
    });

    test('preserves an external environment selected for the containing project', async () => {
        const rootProject = createProject('workspace', workspaceRoot);
        const environment = createExternalEnvironment('external');
        const api = createApi([rootProject], new Map([[rootProject.uri.toString(), environment]]), []);

        const result = await getEnvironmentForTerminal(
            api,
            createTerminal(path.join(workspaceRoot, 'ProjectC')),
        );

        assert.strictEqual(result, environment);
        sinon.assert.notCalled(api.getEnvironments as sinon.SinonStub);
    });

    test('preserves the selected environment for the most specific registered project', async () => {
        const projectCPath = path.join(workspaceRoot, 'ProjectC');
        const rootProject = createProject('workspace', workspaceRoot);
        const projectC = createProject('ProjectC', projectCPath);
        const rootEnvironment = createVenv(path.join(workspaceRoot, 'ProjectA'), 'a');
        const projectEnvironment = createExternalEnvironment('project-c');
        const api = createApi(
            [rootProject, projectC],
            new Map([
                [rootProject.uri.toString(), rootEnvironment],
                [projectC.uri.toString(), projectEnvironment],
            ]),
            [rootEnvironment],
        );

        const result = await getEnvironmentForTerminal(
            api,
            createTerminal(path.join(projectCPath, 'src')),
        );

        assert.strictEqual(result, projectEnvironment);
        sinon.assert.notCalled(api.getEnvironments as sinon.SinonStub);
    });

    test('preserves the existing project fallback when terminal cwd is outside the workspace', async () => {
        const rootProject = createProject('workspace', workspaceRoot);
        const environment = createVenv(path.join(workspaceRoot, 'ProjectA'), 'a');
        const api = createApi([rootProject], new Map([[rootProject.uri.toString(), environment]]), [environment]);

        const result = await getEnvironmentForTerminal(api, createTerminal(path.resolve('outside-workspace')));

        assert.strictEqual(result, environment);
        sinon.assert.notCalled(api.getEnvironments as sinon.SinonStub);
    });

    test('preserves the existing single-project behavior when terminal cwd is unavailable', async () => {
        const rootProject = createProject('workspace', workspaceRoot);
        const environment = createVenv(path.join(workspaceRoot, 'ProjectA'), 'a');
        const api = createApi([rootProject], new Map([[rootProject.uri.toString(), environment]]), [environment]);

        const result = await getEnvironmentForTerminal(api, createTerminal());

        assert.strictEqual(result, environment);
        sinon.assert.notCalled(api.getEnvironments as sinon.SinonStub);
    });
});

suite('Terminal Utils - getAutoActivationType', () => {
    let mockGetConfiguration: sinon.SinonStub;
    let pyEnvsConfig: MockWorkspaceConfig;
    let pythonConfig: MockWorkspaceConfig;

    setup(() => {
        // Initialize mocks
        mockGetConfiguration = sinon.stub(workspaceApis, 'getConfiguration');

        // Create mock configuration objects
        pyEnvsConfig = {
            get: sinon.stub(),
            inspect: sinon.stub(),
            update: sinon.stub(),
        };

        pythonConfig = {
            get: sinon.stub(),
            inspect: sinon.stub(),
            update: sinon.stub(),
        };

        // Set up default configuration returns
        mockGetConfiguration.withArgs('python-envs').returns(pyEnvsConfig);
        mockGetConfiguration.withArgs('python').returns(pythonConfig);
    });

    teardown(() => {
        sinon.restore();
    });

    suite('Priority Order Tests', () => {
        test('should return globalRemoteValue when set (highest priority)', () => {
            // Mock - globalRemoteValue is set
            const mockInspectResult = {
                globalRemoteValue: ACT_TYPE_SHELL,
                globalLocalValue: ACT_TYPE_COMMAND,
                globalValue: ACT_TYPE_OFF,
            };
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(mockInspectResult);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(result, ACT_TYPE_SHELL, 'Should return globalRemoteValue when set');
        });

        test('should return globalLocalValue when globalRemoteValue is undefined', () => {
            // Mock - globalRemoteValue is undefined, globalLocalValue is set
            const mockInspectResult = {
                globalRemoteValue: undefined,
                globalLocalValue: ACT_TYPE_SHELL,
                globalValue: ACT_TYPE_OFF,
            };
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(mockInspectResult);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(
                result,
                ACT_TYPE_SHELL,
                'Should return globalLocalValue when globalRemoteValue is undefined',
            );
        });

        test('should return globalValue when both globalRemoteValue and globalLocalValue are undefined', () => {
            // Mock - only globalValue is set
            const mockInspectResult = {
                globalRemoteValue: undefined,
                globalLocalValue: undefined,
                globalValue: ACT_TYPE_OFF,
            };
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(mockInspectResult);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(
                result,
                ACT_TYPE_OFF,
                'Should return globalValue when higher priority values are undefined',
            );
        });

        test('should ignore globalLocalValue and globalValue when globalRemoteValue exists', () => {
            // Mock - all values set, should prioritize globalRemoteValue
            const mockInspectResult = {
                globalRemoteValue: ACT_TYPE_OFF,
                globalLocalValue: ACT_TYPE_SHELL,
                globalValue: ACT_TYPE_COMMAND,
            };
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(mockInspectResult);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(result, ACT_TYPE_OFF, 'Should prioritize globalRemoteValue over other values');
        });

        test('should ignore globalValue when globalLocalValue exists', () => {
            // Mock - globalLocalValue and globalValue set, should prioritize globalLocalValue
            const mockInspectResult = {
                globalLocalValue: ACT_TYPE_SHELL,
                globalValue: ACT_TYPE_COMMAND,
            };
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(mockInspectResult);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(result, ACT_TYPE_SHELL, 'Should prioritize globalLocalValue over globalValue');
        });
    });

    suite('Custom Properties Handling', () => {
        test('should handle case when globalRemoteValue property does not exist', () => {
            // Mock - standard VS Code inspection result without custom properties
            const mockInspectResult = {
                key: 'terminal.autoActivationType',
                globalValue: ACT_TYPE_SHELL,
            };
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(mockInspectResult);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(result, ACT_TYPE_SHELL, 'Should return globalValue when custom properties do not exist');
        });

        test('should handle case when globalLocalValue property does not exist', () => {
            // Mock - inspection result without globalLocalValue property
            const mockInspectResult = {
                key: 'terminal.autoActivationType',
                globalValue: ACT_TYPE_COMMAND,
            };
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(mockInspectResult);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(
                result,
                ACT_TYPE_COMMAND,
                'Should return globalValue when globalLocalValue property does not exist',
            );
        });

        test('should handle case when custom properties exist but are undefined', () => {
            // Mock - custom properties exist but have undefined values
            const mockInspectResult = {
                globalRemoteValue: undefined,
                globalLocalValue: undefined,
                globalValue: ACT_TYPE_OFF,
            };
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(mockInspectResult);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(
                result,
                ACT_TYPE_OFF,
                'Should fall back to globalValue when custom properties are undefined',
            );
        });
    });

    suite('Legacy Python Setting Fallback', () => {
        test('should return ACT_TYPE_OFF and update config when python.terminal.activateEnvironment is false', () => {
            // Mock - no python-envs settings, python.terminal.activateEnvironment is false
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(undefined);
            pythonConfig.get.withArgs('terminal.activateEnvironment', undefined).returns(false);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(result, ACT_TYPE_OFF, 'Should return ACT_TYPE_OFF when legacy setting is false');
            assert.ok(
                pyEnvsConfig.update.calledWithExactly('terminal.autoActivationType', ACT_TYPE_OFF),
                'Should update python-envs config to ACT_TYPE_OFF',
            );
        });

        test('should return ACT_TYPE_COMMAND when python.terminal.activateEnvironment is true', () => {
            // Mock - no python-envs settings, python.terminal.activateEnvironment is true
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(undefined);
            pythonConfig.get.withArgs('terminal.activateEnvironment', undefined).returns(true);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(result, ACT_TYPE_COMMAND, 'Should return ACT_TYPE_COMMAND when legacy setting is true');
            assert.ok(
                pyEnvsConfig.update.notCalled,
                'Should not update python-envs config when legacy setting is true',
            );
        });

        test('should return ACT_TYPE_COMMAND when python.terminal.activateEnvironment is undefined', () => {
            // Mock - no python-envs settings, python.terminal.activateEnvironment is undefined
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(undefined);
            pythonConfig.get.withArgs('terminal.activateEnvironment', undefined).returns(undefined);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(result, ACT_TYPE_COMMAND, 'Should return ACT_TYPE_COMMAND when no settings are found');
            assert.ok(
                pyEnvsConfig.update.notCalled,
                'Should not update python-envs config when no legacy setting exists',
            );
        });
    });

    suite('Fallback Scenarios', () => {
        test('should return ACT_TYPE_COMMAND when no configuration exists', () => {
            // Mock - no configurations exist
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(undefined);
            pythonConfig.get.withArgs('terminal.activateEnvironment', undefined).returns(undefined);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(
                result,
                ACT_TYPE_COMMAND,
                'Should return default ACT_TYPE_COMMAND when no configurations exist',
            );
        });

        test('should return ACT_TYPE_COMMAND when python-envs config exists but all values are undefined', () => {
            // Mock - python-envs config exists but all relevant values are undefined
            const mockInspectResult = {
                key: 'terminal.autoActivationType',
                globalValue: undefined,
                workspaceValue: undefined,
                workspaceFolderValue: undefined,
            };
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(mockInspectResult);
            pythonConfig.get.withArgs('terminal.activateEnvironment', undefined).returns(undefined);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(
                result,
                ACT_TYPE_COMMAND,
                'Should return default when python-envs config exists but values are undefined',
            );
        });

        test('should prioritize python-envs settings over legacy python settings', () => {
            // Mock - python-envs has globalValue, python has conflicting setting
            const mockInspectResult = {
                globalValue: ACT_TYPE_SHELL,
            };
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(mockInspectResult);
            pythonConfig.get.withArgs('terminal.activateEnvironment', undefined).returns(false);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(
                result,
                ACT_TYPE_SHELL,
                'Should prioritize python-envs globalValue over legacy python setting',
            );
            assert.ok(
                pyEnvsConfig.update.notCalled,
                'Should not update python-envs config when it already has a value',
            );
        });
    });

    suite('Edge Cases', () => {
        test('should handle null inspect result', () => {
            // Mock - inspect returns null
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(null);
            pythonConfig.get.withArgs('terminal.activateEnvironment', undefined).returns(undefined);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(result, ACT_TYPE_COMMAND, 'Should handle null inspect result gracefully');
        });

        test('should handle empty object inspect result', () => {
            // Mock - inspect returns empty object
            pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns({});
            pythonConfig.get.withArgs('terminal.activateEnvironment', undefined).returns(undefined);

            // Run
            const result = getAutoActivationType();

            // Assert
            assert.strictEqual(result, ACT_TYPE_COMMAND, 'Should handle empty inspect result gracefully');
        });

        test('should handle all AutoActivationType values correctly', () => {
            const testCases: { input: AutoActivationType; expected: AutoActivationType }[] = [
                { input: ACT_TYPE_COMMAND, expected: ACT_TYPE_COMMAND },
                { input: ACT_TYPE_SHELL, expected: ACT_TYPE_SHELL },
                { input: ACT_TYPE_OFF, expected: ACT_TYPE_OFF },
            ];

            testCases.forEach(({ input, expected }) => {
                // Reset stubs for each test case
                pyEnvsConfig.inspect.resetHistory();
                pythonConfig.get.resetHistory();

                // Mock - set globalValue to test input
                const mockInspectResult = { globalValue: input };
                pyEnvsConfig.inspect.withArgs('terminal.autoActivationType').returns(mockInspectResult);

                // Run
                const result = getAutoActivationType();

                // Assert
                assert.strictEqual(result, expected, `Should handle ${input} value correctly`);
            });
        });
    });
});

suite('Terminal Utils - shouldActivateInCurrentTerminal', () => {
    let mockGetConfiguration: sinon.SinonStub;
    let pythonConfig: MockWorkspaceConfig;

    setup(() => {
        mockGetConfiguration = sinon.stub(workspaceApis, 'getConfiguration');

        pythonConfig = {
            get: sinon.stub(),
            inspect: sinon.stub(),
            update: sinon.stub(),
        };

        mockGetConfiguration.withArgs('python').returns(pythonConfig);
    });

    teardown(() => {
        sinon.restore();
    });

    test('should return true when inspect returns undefined (no config)', () => {
        pythonConfig.inspect.withArgs('terminal.activateEnvInCurrentTerminal').returns(undefined);

        assert.strictEqual(shouldActivateInCurrentTerminal(), true, 'Should default to true when no config exists');
    });

    test('should return true when no explicit values are set (all undefined)', () => {
        pythonConfig.inspect.withArgs('terminal.activateEnvInCurrentTerminal').returns({
            key: 'terminal.activateEnvInCurrentTerminal',
            defaultValue: false,
            globalValue: undefined,
            workspaceValue: undefined,
            workspaceFolderValue: undefined,
        });

        assert.strictEqual(
            shouldActivateInCurrentTerminal(),
            true,
            'Should return true when only defaultValue is set (not user-explicit)',
        );
    });

    test('should return false when globalValue is explicitly false', () => {
        pythonConfig.inspect.withArgs('terminal.activateEnvInCurrentTerminal').returns({
            key: 'terminal.activateEnvInCurrentTerminal',
            defaultValue: false,
            globalValue: false,
            workspaceValue: undefined,
            workspaceFolderValue: undefined,
        });

        assert.strictEqual(
            shouldActivateInCurrentTerminal(),
            false,
            'Should return false when user explicitly set globalValue to false',
        );
    });

    test('should return false when workspaceValue is explicitly false', () => {
        pythonConfig.inspect.withArgs('terminal.activateEnvInCurrentTerminal').returns({
            key: 'terminal.activateEnvInCurrentTerminal',
            defaultValue: false,
            globalValue: undefined,
            workspaceValue: false,
            workspaceFolderValue: undefined,
        });

        assert.strictEqual(
            shouldActivateInCurrentTerminal(),
            false,
            'Should return false when user explicitly set workspaceValue to false',
        );
    });

    test('should return false when workspaceFolderValue is explicitly false', () => {
        pythonConfig.inspect.withArgs('terminal.activateEnvInCurrentTerminal').returns({
            key: 'terminal.activateEnvInCurrentTerminal',
            defaultValue: false,
            globalValue: undefined,
            workspaceValue: undefined,
            workspaceFolderValue: false,
        });

        assert.strictEqual(
            shouldActivateInCurrentTerminal(),
            false,
            'Should return false when user explicitly set workspaceFolderValue to false',
        );
    });

    test('should return true when globalValue is explicitly true', () => {
        pythonConfig.inspect.withArgs('terminal.activateEnvInCurrentTerminal').returns({
            key: 'terminal.activateEnvInCurrentTerminal',
            defaultValue: false,
            globalValue: true,
            workspaceValue: undefined,
            workspaceFolderValue: undefined,
        });

        assert.strictEqual(
            shouldActivateInCurrentTerminal(),
            true,
            'Should return true when user explicitly set globalValue to true',
        );
    });

    test('workspaceFolderValue false takes precedence over globalValue true', () => {
        pythonConfig.inspect.withArgs('terminal.activateEnvInCurrentTerminal').returns({
            key: 'terminal.activateEnvInCurrentTerminal',
            defaultValue: false,
            globalValue: true,
            workspaceValue: undefined,
            workspaceFolderValue: false,
        });

        assert.strictEqual(
            shouldActivateInCurrentTerminal(),
            false,
            'workspaceFolderValue false should take precedence',
        );
    });

    test('should return false when globalRemoteValue is explicitly false', () => {
        pythonConfig.inspect.withArgs('terminal.activateEnvInCurrentTerminal').returns({
            key: 'terminal.activateEnvInCurrentTerminal',
            defaultValue: false,
            globalRemoteValue: false,
            globalValue: undefined,
            workspaceValue: undefined,
            workspaceFolderValue: undefined,
        });

        assert.strictEqual(
            shouldActivateInCurrentTerminal(),
            false,
            'Should return false when user explicitly set globalRemoteValue to false',
        );
    });

    test('should return false when globalLocalValue is explicitly false', () => {
        pythonConfig.inspect.withArgs('terminal.activateEnvInCurrentTerminal').returns({
            key: 'terminal.activateEnvInCurrentTerminal',
            defaultValue: false,
            globalLocalValue: false,
            globalValue: undefined,
            workspaceValue: undefined,
            workspaceFolderValue: undefined,
        });

        assert.strictEqual(
            shouldActivateInCurrentTerminal(),
            false,
            'Should return false when user explicitly set globalLocalValue to false',
        );
    });

    test('workspaceValue false takes precedence over globalRemoteValue true', () => {
        pythonConfig.inspect.withArgs('terminal.activateEnvInCurrentTerminal').returns({
            key: 'terminal.activateEnvInCurrentTerminal',
            defaultValue: false,
            globalRemoteValue: true,
            globalValue: undefined,
            workspaceValue: false,
            workspaceFolderValue: undefined,
        });

        assert.strictEqual(
            shouldActivateInCurrentTerminal(),
            false,
            'workspaceValue false should take precedence over globalRemoteValue true',
        );
    });

    test('should return false when globalValue is false even if workspaceValue is true (any explicit false wins)', () => {
        pythonConfig.inspect.withArgs('terminal.activateEnvInCurrentTerminal').returns({
            key: 'terminal.activateEnvInCurrentTerminal',
            defaultValue: false,
            globalValue: false,
            workspaceValue: true,
            workspaceFolderValue: undefined,
        });

        assert.strictEqual(
            shouldActivateInCurrentTerminal(),
            false,
            'Any explicit false at any scope should return false, regardless of higher-precedence true values',
        );
    });
});

suite('Terminal Utils - shouldSkipTerminalActivation', () => {
    test('should return false for a regular terminal with no special options', () => {
        const terminal = { creationOptions: {} as TerminalOptions } as Terminal;
        assert.strictEqual(shouldSkipTerminalActivation(terminal), false);
    });

    test('should return true when hideFromUser is true', () => {
        const terminal = { creationOptions: { hideFromUser: true } as TerminalOptions } as Terminal;
        assert.strictEqual(shouldSkipTerminalActivation(terminal), true);
    });

    test('should return false when hideFromUser is false', () => {
        const terminal = { creationOptions: { hideFromUser: false } as TerminalOptions } as Terminal;
        assert.strictEqual(shouldSkipTerminalActivation(terminal), false);
    });

    test('should return true for a pseudoterminal (pty-based extension terminal)', () => {
        const terminal = {
            creationOptions: {
                name: 'pseudo',
                pty: { open: () => {}, close: () => {} },
            } as unknown as ExtensionTerminalOptions,
        } as Terminal;
        assert.strictEqual(shouldSkipTerminalActivation(terminal), true);
    });

    test('should return false when pty is undefined', () => {
        const terminal = { creationOptions: {} as ExtensionTerminalOptions } as Terminal;
        assert.strictEqual(shouldSkipTerminalActivation(terminal), false);
    });

    test('should return true when both hideFromUser and pty are set', () => {
        const terminal = {
            creationOptions: { hideFromUser: true, pty: { open: () => {}, close: () => {} } },
        } as unknown as Terminal;
        assert.strictEqual(shouldSkipTerminalActivation(terminal), true);
    });
});

suite('Terminal Utils - waitForShellIntegration', () => {
    let mockGetConfiguration: sinon.SinonStub;
    let identifyTerminalShellStub: sinon.SinonStub;
    let onDidChangeTerminalShellIntegrationStub: sinon.SinonStub;
    let onDidWriteTerminalDataStub: sinon.SinonStub;

    function setupLongTimeoutConfig() {
        // Make the timeout effectively infinite so tests resolve via the listener,
        // not the timer. Avoids flakiness while keeping the race code paths exercised.
        const config = {
            get: sinon.stub(),
            inspect: sinon.stub(),
            update: sinon.stub(),
        };
        config.get.withArgs('shellIntegration.timeout').returns(60_000);
        config.get.withArgs('shellIntegration.enabled', true).returns(true);
        mockGetConfiguration.withArgs('terminal.integrated').returns(config);
    }

    setup(() => {
        mockGetConfiguration = sinon.stub(workspaceApis, 'getConfiguration');
        identifyTerminalShellStub = sinon.stub(shellDetector, 'identifyTerminalShell');
        onDidChangeTerminalShellIntegrationStub = sinon.stub(windowApis, 'onDidChangeTerminalShellIntegration');
        onDidWriteTerminalDataStub = sinon.stub(windowApis, 'onDidWriteTerminalData');

        // Default: dispose-only fake event registrations. Tests that need to fire
        // events override these via .callsFake.
        const fakeDisposable = { dispose: () => undefined };
        onDidChangeTerminalShellIntegrationStub.returns(fakeDisposable);
        onDidWriteTerminalDataStub.returns(fakeDisposable);
    });

    teardown(() => {
        sinon.restore();
    });

    test('returns false immediately when terminal is undefined', async () => {
        const result = await waitForShellIntegration(undefined);

        assert.strictEqual(result, false);
        sinon.assert.notCalled(identifyTerminalShellStub);
        sinon.assert.notCalled(onDidChangeTerminalShellIntegrationStub);
    });

    test('returns true immediately when terminal.shellIntegration is already set', async () => {
        const terminal = { shellIntegration: {} } as unknown as Terminal;

        const result = await waitForShellIntegration(terminal);

        assert.strictEqual(result, true);
        sinon.assert.notCalled(identifyTerminalShellStub);
        sinon.assert.notCalled(onDidChangeTerminalShellIntegrationStub);
    });

    test('returns false immediately for nu without registering event listeners', async () => {
        const terminal = {} as Terminal;
        identifyTerminalShellStub.returns('nu');

        const result = await waitForShellIntegration(terminal);

        assert.strictEqual(result, false);
        sinon.assert.calledOnce(identifyTerminalShellStub);
        sinon.assert.notCalled(onDidChangeTerminalShellIntegrationStub);
        sinon.assert.notCalled(onDidWriteTerminalDataStub);
    });

    test('returns false immediately for cmd', async () => {
        const terminal = {} as Terminal;
        identifyTerminalShellStub.returns('cmd');

        const result = await waitForShellIntegration(terminal);

        assert.strictEqual(result, false);
        sinon.assert.notCalled(onDidChangeTerminalShellIntegrationStub);
    });

    test('returns false immediately for csh / tcsh / ksh / xonsh', async () => {
        const unsupported = ['csh', 'tcsh', 'ksh', 'xonsh'];
        for (const shell of unsupported) {
            identifyTerminalShellStub.resetHistory();
            identifyTerminalShellStub.returns(shell);
            onDidChangeTerminalShellIntegrationStub.resetHistory();

            const result = await waitForShellIntegration({} as Terminal);

            assert.strictEqual(result, false, `expected false for shell '${shell}'`);
            sinon.assert.notCalled(onDidChangeTerminalShellIntegrationStub);
        }
    });

    test('falls through to event race for bash (supported shell)', async () => {
        setupLongTimeoutConfig();
        const terminal = {} as Terminal;
        identifyTerminalShellStub.returns('bash');

        let listenerRef: ((e: { terminal: Terminal }) => void) | undefined;
        onDidChangeTerminalShellIntegrationStub.callsFake((listener: (e: { terminal: Terminal }) => void) => {
            listenerRef = listener;
            return { dispose: () => undefined };
        });

        const racePromise = waitForShellIntegration(terminal);
        // Yield once so the Promise.race body has a chance to register listeners.
        await new Promise<void>((r) => setImmediate(r));
        assert.ok(listenerRef, 'shell integration listener should be registered');
        listenerRef!({ terminal });

        const result = await racePromise;
        assert.strictEqual(result, true);
        sinon.assert.calledOnce(onDidChangeTerminalShellIntegrationStub);
    });

    test('falls through to event race when shell type is unknown', async () => {
        setupLongTimeoutConfig();
        const terminal = {} as Terminal;
        identifyTerminalShellStub.returns('unknown');

        let listenerRef: ((e: { terminal: Terminal }) => void) | undefined;
        onDidChangeTerminalShellIntegrationStub.callsFake((listener: (e: { terminal: Terminal }) => void) => {
            listenerRef = listener;
            return { dispose: () => undefined };
        });

        const racePromise = waitForShellIntegration(terminal);
        await new Promise<void>((r) => setImmediate(r));
        listenerRef!({ terminal });

        const result = await racePromise;
        assert.strictEqual(result, true);
    });

    test('falls through to event race when identifyTerminalShell throws', async () => {
        setupLongTimeoutConfig();
        const terminal = {} as Terminal;
        identifyTerminalShellStub.throws(new Error('detection failed'));

        let listenerRef: ((e: { terminal: Terminal }) => void) | undefined;
        onDidChangeTerminalShellIntegrationStub.callsFake((listener: (e: { terminal: Terminal }) => void) => {
            listenerRef = listener;
            return { dispose: () => undefined };
        });

        const racePromise = waitForShellIntegration(terminal);
        await new Promise<void>((r) => setImmediate(r));
        listenerRef!({ terminal });

        const result = await racePromise;
        assert.strictEqual(result, true, 'should not regress when detection throws');
    });
});
