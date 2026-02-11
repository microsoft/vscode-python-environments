/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { ConfigurationTarget, Uri, WorkspaceFolder } from 'vscode';
import * as workspaceApis from '../../../common/workspace.apis';
import {
    addPythonProjectSetting,
    setAllManagerSettings,
    setEnvironmentManager,
    setPackageManager,
} from '../../../features/settings/settingHelpers';
import { PythonProjectsImpl } from '../../../internal.api';
import { MockWorkspaceConfiguration } from '../../mocks/mockWorkspaceConfig';

/**
 * Returns a platform-appropriate workspace path for testing.
 * On Windows, paths must include a drive letter to work correctly with path.resolve().
 */
function getTestWorkspacePath(): string {
    return process.platform === 'win32' ? 'C:\\workspace' : '/workspace';
}

/**
 * These tests verify that settings ARE written when the value changes,
 * regardless of whether it's the default/system manager or not.
 *
 * Note: These tests focus on the global settings path (project=undefined) because
 * workspace-scoped tests would require mocking workspace.getWorkspaceFolder which
 * cannot be easily stubbed in unit tests.
 */
suite('Setting Helpers - Settings Write Behavior', () => {
    const SYSTEM_MANAGER_ID = 'ms-python.python:system';
    const VENV_MANAGER_ID = 'ms-python.python:venv';
    const PIP_MANAGER_ID = 'ms-python.python:pip';
    const CONDA_MANAGER_ID = 'ms-python.python:conda';

    let updateCalls: Array<{ key: string; value: unknown; target: ConfigurationTarget }>;

    setup(() => {
        updateCalls = [];
    });

    teardown(() => {
        sinon.restore();
    });

    /**
     * Creates a mock WorkspaceConfiguration that tracks update calls
     */
    function createMockConfig(options: {
        defaultEnvManagerGlobalValue?: string;
        defaultPackageManagerGlobalValue?: string;
        currentEnvManager?: string;
        currentPkgManager?: string;
    }): MockWorkspaceConfiguration {
        const mockConfig = new MockWorkspaceConfiguration();

        // Override inspect to return proper inspection results
        (mockConfig as any).inspect = (section: string) => {
            if (section === 'defaultEnvManager') {
                return {
                    key: 'python-envs.defaultEnvManager',
                    defaultValue: VENV_MANAGER_ID,
                    globalValue: options.defaultEnvManagerGlobalValue,
                    workspaceValue: undefined,
                    workspaceFolderValue: undefined,
                };
            }
            if (section === 'defaultPackageManager') {
                return {
                    key: 'python-envs.defaultPackageManager',
                    defaultValue: PIP_MANAGER_ID,
                    globalValue: options.defaultPackageManagerGlobalValue,
                    workspaceValue: undefined,
                    workspaceFolderValue: undefined,
                };
            }
            return undefined;
        };

        // Override get to return effective values
        (mockConfig as any).get = <T>(key: string, defaultValue?: T): T | undefined => {
            if (key === 'defaultEnvManager') {
                return (options.currentEnvManager ?? options.defaultEnvManagerGlobalValue ?? VENV_MANAGER_ID) as T;
            }
            if (key === 'defaultPackageManager') {
                return (options.currentPkgManager ?? options.defaultPackageManagerGlobalValue ?? PIP_MANAGER_ID) as T;
            }
            return defaultValue;
        };

        // Override update to track calls
        mockConfig.update = (
            section: string,
            value: unknown,
            configurationTarget?: boolean | ConfigurationTarget,
        ): Promise<void> => {
            updateCalls.push({
                key: section,
                value,
                target: configurationTarget as ConfigurationTarget,
            });
            return Promise.resolve();
        };

        return mockConfig;
    }

    suite('setAllManagerSettings - Global Settings', () => {
        test('should write global defaultEnvManager when value differs from current', async () => {
            const mockConfig = createMockConfig({
                currentEnvManager: VENV_MANAGER_ID,
            });
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            await setAllManagerSettings([
                {
                    project: undefined, // Global scope
                    envManager: SYSTEM_MANAGER_ID,
                    packageManager: PIP_MANAGER_ID,
                },
            ]);

            const envManagerUpdates = updateCalls.filter(
                (c) => c.key === 'defaultEnvManager' && c.target === ConfigurationTarget.Global,
            );
            assert.strictEqual(envManagerUpdates.length, 1, 'Should write global defaultEnvManager when value differs');
            assert.strictEqual(envManagerUpdates[0].value, SYSTEM_MANAGER_ID);
        });

        test('should NOT write global defaultEnvManager when value is same as current', async () => {
            const mockConfig = createMockConfig({
                currentEnvManager: SYSTEM_MANAGER_ID,
            });
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            await setAllManagerSettings([
                {
                    project: undefined,
                    envManager: SYSTEM_MANAGER_ID,
                    packageManager: PIP_MANAGER_ID,
                },
            ]);

            const envManagerUpdates = updateCalls.filter(
                (c) => c.key === 'defaultEnvManager' && c.target === ConfigurationTarget.Global,
            );
            assert.strictEqual(envManagerUpdates.length, 0, 'Should NOT write when value is same as current');
        });

        test('should write global defaultPackageManager when value differs from current', async () => {
            const mockConfig = createMockConfig({
                currentEnvManager: VENV_MANAGER_ID,
                currentPkgManager: PIP_MANAGER_ID,
            });
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            await setAllManagerSettings([
                {
                    project: undefined,
                    envManager: VENV_MANAGER_ID,
                    packageManager: CONDA_MANAGER_ID,
                },
            ]);

            const pkgManagerUpdates = updateCalls.filter(
                (c) => c.key === 'defaultPackageManager' && c.target === ConfigurationTarget.Global,
            );
            assert.strictEqual(
                pkgManagerUpdates.length,
                1,
                'Should write global defaultPackageManager when value differs',
            );
            assert.strictEqual(pkgManagerUpdates[0].value, CONDA_MANAGER_ID);
        });
    });

    suite('setEnvironmentManager - Global Settings', () => {
        test('should write when value differs from current', async () => {
            const mockConfig = createMockConfig({
                currentEnvManager: VENV_MANAGER_ID,
            });
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            await setEnvironmentManager([
                {
                    project: undefined, // Global scope
                    envManager: SYSTEM_MANAGER_ID,
                },
            ]);

            const envManagerUpdates = updateCalls.filter(
                (c) => c.key === 'defaultEnvManager' && c.target === ConfigurationTarget.Global,
            );
            assert.strictEqual(envManagerUpdates.length, 1, 'Should write global defaultEnvManager when value differs');
        });

        test('should NOT write when value is same as current', async () => {
            const mockConfig = createMockConfig({
                currentEnvManager: SYSTEM_MANAGER_ID,
            });
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            await setEnvironmentManager([
                {
                    project: undefined,
                    envManager: SYSTEM_MANAGER_ID,
                },
            ]);

            const envManagerUpdates = updateCalls.filter(
                (c) => c.key === 'defaultEnvManager' && c.target === ConfigurationTarget.Global,
            );
            assert.strictEqual(envManagerUpdates.length, 0, 'Should NOT write when value is same');
        });
    });

    suite('setPackageManager - Global Settings', () => {
        test('should write when value differs from current', async () => {
            const mockConfig = createMockConfig({
                currentPkgManager: PIP_MANAGER_ID,
            });
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            await setPackageManager([
                {
                    project: undefined, // Global scope
                    packageManager: CONDA_MANAGER_ID,
                },
            ]);

            const pkgManagerUpdates = updateCalls.filter(
                (c) => c.key === 'defaultPackageManager' && c.target === ConfigurationTarget.Global,
            );
            assert.strictEqual(
                pkgManagerUpdates.length,
                1,
                'Should write global defaultPackageManager when value differs',
            );
        });

        test('should NOT write when value is same as current', async () => {
            const mockConfig = createMockConfig({
                currentPkgManager: PIP_MANAGER_ID,
            });
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            await setPackageManager([
                {
                    project: undefined,
                    packageManager: PIP_MANAGER_ID,
                },
            ]);

            const pkgManagerUpdates = updateCalls.filter(
                (c) => c.key === 'defaultPackageManager' && c.target === ConfigurationTarget.Global,
            );
            assert.strictEqual(pkgManagerUpdates.length, 0, 'Should NOT write when value is same');
        });
    });
});

/**
 * Tests for the empty path bug fix (Issue #1219, #1115)
 * When a project is the workspace root folder, we should NOT write "path": "" to pythonProjects.
 * Instead, we should use defaultEnvManager/defaultPackageManager settings.
 */
suite('Setting Helpers - Empty Path Bug Fix', () => {
    const VENV_MANAGER_ID = 'ms-python.python:venv';
    const PIP_MANAGER_ID = 'ms-python.python:pip';

    const workspacePath = getTestWorkspacePath();
    const workspaceUri = Uri.file(workspacePath);
    const workspaceFolder: WorkspaceFolder = {
        uri: workspaceUri,
        name: 'workspace',
        index: 0,
    };

    let updateCalls: Array<{ key: string; value: unknown; target: ConfigurationTarget }>;

    setup(() => {
        updateCalls = [];
    });

    teardown(() => {
        sinon.restore();
    });

    function createMockConfigForWorkspace(options?: {
        pythonProjects?: any[];
        defaultEnvManager?: string;
        defaultPackageManager?: string;
    }): MockWorkspaceConfiguration {
        const mockConfig = new MockWorkspaceConfiguration();

        (mockConfig as any).get = <T>(key: string, defaultValue?: T): T | undefined => {
            if (key === 'pythonProjects') {
                return (options?.pythonProjects ?? []) as T;
            }
            if (key === 'defaultEnvManager') {
                return (options?.defaultEnvManager ?? VENV_MANAGER_ID) as T;
            }
            if (key === 'defaultPackageManager') {
                return (options?.defaultPackageManager ?? PIP_MANAGER_ID) as T;
            }
            return defaultValue;
        };

        mockConfig.update = (
            section: string,
            value: unknown,
            configurationTarget?: boolean | ConfigurationTarget,
        ): Promise<void> => {
            updateCalls.push({
                key: section,
                value,
                target: configurationTarget as ConfigurationTarget,
            });
            return Promise.resolve();
        };

        return mockConfig;
    }

    suite('addPythonProjectSetting - Single Folder Workspace', () => {
        test('should use defaultEnvManager/defaultPackageManager for workspace root instead of empty path', async () => {
            // Setup: single folder workspace
            sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([workspaceFolder]);
            sinon.stub(workspaceApis, 'getConfiguration').returns(createMockConfigForWorkspace());
            sinon.stub(workspaceApis, 'getWorkspaceFolder').returns(workspaceFolder);

            // Create a project at the workspace root
            const rootProject = new PythonProjectsImpl('workspace', workspaceUri);

            await addPythonProjectSetting([
                {
                    project: rootProject,
                    envManager: VENV_MANAGER_ID,
                    packageManager: PIP_MANAGER_ID,
                },
            ]);

            // Should NOT write to pythonProjects at all for root projects in single folder workspace
            const pythonProjectsUpdates = updateCalls.filter((c) => c.key === 'pythonProjects');
            assert.strictEqual(
                pythonProjectsUpdates.length,
                0,
                'Should NOT write to pythonProjects for workspace root in single folder workspace',
            );

            // Instead should write to defaultEnvManager/defaultPackageManager
            // (only if values differ, which they don't in this test)
        });

        test('should write to pythonProjects for subfolders (not workspace root)', async () => {
            // Setup: single folder workspace
            sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([workspaceFolder]);
            sinon.stub(workspaceApis, 'getConfiguration').returns(createMockConfigForWorkspace());
            sinon.stub(workspaceApis, 'getWorkspaceFolder').returns(workspaceFolder);

            // Create a project at a subfolder (not workspace root)
            const subfolderPath = path.join(workspacePath, 'subfolder');
            const subfolderUri = Uri.file(subfolderPath);
            const subfolderProject = new PythonProjectsImpl('subfolder', subfolderUri);

            await addPythonProjectSetting([
                {
                    project: subfolderProject,
                    envManager: VENV_MANAGER_ID,
                    packageManager: PIP_MANAGER_ID,
                },
            ]);

            // Should write to pythonProjects for subfolders
            const pythonProjectsUpdates = updateCalls.filter((c) => c.key === 'pythonProjects');
            assert.strictEqual(pythonProjectsUpdates.length, 1, 'Should write to pythonProjects for subfolders');

            // The path should NOT be empty
            const projects = pythonProjectsUpdates[0].value as any[];
            assert.ok(projects.length > 0, 'Should have at least one project entry');
            assert.strictEqual(projects[0].path, 'subfolder', 'Path should be "subfolder", not empty');
        });
    });

    suite('addPythonProjectSetting - Multi-root Workspace', () => {
        test('should use "." for workspace root path instead of empty string', async () => {
            // Setup: multi-root workspace
            const secondWorkspaceUri = Uri.file(process.platform === 'win32' ? 'C:\\workspace2' : '/workspace2');
            const secondWorkspaceFolder: WorkspaceFolder = {
                uri: secondWorkspaceUri,
                name: 'workspace2',
                index: 1,
            };
            sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([workspaceFolder, secondWorkspaceFolder]);
            sinon.stub(workspaceApis, 'getConfiguration').returns(createMockConfigForWorkspace());
            sinon.stub(workspaceApis, 'getWorkspaceFolder').returns(workspaceFolder);

            // Create a project at the workspace root
            const rootProject = new PythonProjectsImpl('workspace', workspaceUri);

            await addPythonProjectSetting([
                {
                    project: rootProject,
                    envManager: VENV_MANAGER_ID,
                    packageManager: PIP_MANAGER_ID,
                },
            ]);

            // Should write to pythonProjects
            const pythonProjectsUpdates = updateCalls.filter((c) => c.key === 'pythonProjects');
            assert.strictEqual(pythonProjectsUpdates.length, 1, 'Should write to pythonProjects in multi-root');

            // The path should be "." not empty string
            const projects = pythonProjectsUpdates[0].value as any[];
            assert.ok(projects.length > 0, 'Should have at least one project entry');
            assert.strictEqual(projects[0].path, '.', 'Path should be "." not empty string for workspace root');
        });
    });

    suite('setAllManagerSettings - Multi-root Workspace', () => {
        test('should use "." for workspace root path instead of empty string when workspaceFile exists', async () => {
            // Setup: multi-root workspace with workspace file
            sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([workspaceFolder]);
            sinon.stub(workspaceApis, 'getWorkspaceFile').returns(Uri.file('/test.code-workspace'));
            const mockConfig = createMockConfigForWorkspace();
            (mockConfig as any).inspect = () => ({
                workspaceFolderValue: undefined,
                workspaceValue: undefined,
            });
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);
            sinon.stub(workspaceApis, 'getWorkspaceFolder').returns(workspaceFolder);

            // Create a project at the workspace root
            const rootProject = new PythonProjectsImpl('workspace', workspaceUri);

            await setAllManagerSettings([
                {
                    project: rootProject,
                    envManager: VENV_MANAGER_ID,
                    packageManager: PIP_MANAGER_ID,
                },
            ]);

            // Should write to pythonProjects
            const pythonProjectsUpdates = updateCalls.filter((c) => c.key === 'pythonProjects');
            assert.strictEqual(pythonProjectsUpdates.length, 1, 'Should write to pythonProjects');

            // The path should be "." not empty string
            const projects = pythonProjectsUpdates[0].value as any[];
            assert.ok(projects.length > 0, 'Should have at least one project entry');
            assert.strictEqual(projects[0].path, '.', 'Path should be "." not empty string for workspace root');
        });
    });
});

/**
 * Tests for migrating existing entries with empty path (Issue #1219, #1115)
 * When there's an existing entry with "path": "", it should be fixed or removed.
 */
suite('Setting Helpers - Empty Path Migration', () => {
    const VENV_MANAGER_ID = 'ms-python.python:venv';
    const PIP_MANAGER_ID = 'ms-python.python:pip';
    const CONDA_MANAGER_ID = 'ms-python.python:conda';

    const workspacePath = getTestWorkspacePath();
    const workspaceUri = Uri.file(workspacePath);
    const workspaceFolder: WorkspaceFolder = {
        uri: workspaceUri,
        name: 'workspace',
        index: 0,
    };

    let updateCalls: Array<{ key: string; value: unknown; target: ConfigurationTarget }>;

    setup(() => {
        updateCalls = [];
    });

    teardown(() => {
        sinon.restore();
    });

    function createMockConfigWithExistingEmptyPath(options?: {
        defaultEnvManager?: string;
        defaultPackageManager?: string;
    }): MockWorkspaceConfiguration {
        const mockConfig = new MockWorkspaceConfiguration();

        // Existing pythonProjects with buggy empty path entry
        const existingProjects = [
            {
                path: '', // Buggy empty path
                envManager: VENV_MANAGER_ID,
                packageManager: PIP_MANAGER_ID,
            },
        ];

        (mockConfig as any).get = <T>(key: string, defaultValue?: T): T | undefined => {
            if (key === 'pythonProjects') {
                return existingProjects as T;
            }
            if (key === 'defaultEnvManager') {
                return (options?.defaultEnvManager ?? VENV_MANAGER_ID) as T;
            }
            if (key === 'defaultPackageManager') {
                return (options?.defaultPackageManager ?? PIP_MANAGER_ID) as T;
            }
            return defaultValue;
        };

        mockConfig.update = (
            section: string,
            value: unknown,
            configurationTarget?: boolean | ConfigurationTarget,
        ): Promise<void> => {
            updateCalls.push({
                key: section,
                value,
                target: configurationTarget as ConfigurationTarget,
            });
            return Promise.resolve();
        };

        return mockConfig;
    }

    suite('addPythonProjectSetting - Migration of existing empty path', () => {
        test('should remove existing empty path entry and use defaults in single folder workspace', async () => {
            // Setup: single folder workspace with existing buggy empty path entry
            sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([workspaceFolder]);
            sinon.stub(workspaceApis, 'getConfiguration').returns(createMockConfigWithExistingEmptyPath());
            sinon.stub(workspaceApis, 'getWorkspaceFolder').returns(workspaceFolder);

            // Create a project at the workspace root
            const rootProject = new PythonProjectsImpl('workspace', workspaceUri);

            await addPythonProjectSetting([
                {
                    project: rootProject,
                    envManager: CONDA_MANAGER_ID,
                    packageManager: PIP_MANAGER_ID,
                },
            ]);

            // Should write to pythonProjects to remove the empty path entry
            const pythonProjectsUpdates = updateCalls.filter((c) => c.key === 'pythonProjects');
            assert.strictEqual(pythonProjectsUpdates.length, 1, 'Should write to pythonProjects');

            // The value should be undefined (empty array removed) or empty array
            const projects = pythonProjectsUpdates[0].value;
            assert.ok(
                projects === undefined || (Array.isArray(projects) && projects.length === 0),
                'Should remove the buggy entry or set to undefined',
            );

            // Should also write to defaultEnvManager since value changed
            const envManagerUpdates = updateCalls.filter((c) => c.key === 'defaultEnvManager');
            assert.strictEqual(envManagerUpdates.length, 1, 'Should write to defaultEnvManager when value differs');
            assert.strictEqual(envManagerUpdates[0].value, CONDA_MANAGER_ID);
        });

        test('should fix empty path to "." when updating in multi-root workspace', async () => {
            // Setup: multi-root workspace with existing buggy empty path entry
            const secondWorkspaceUri = Uri.file(process.platform === 'win32' ? 'C:\\workspace2' : '/workspace2');
            const secondWorkspaceFolder: WorkspaceFolder = {
                uri: secondWorkspaceUri,
                name: 'workspace2',
                index: 1,
            };
            sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([workspaceFolder, secondWorkspaceFolder]);
            sinon.stub(workspaceApis, 'getConfiguration').returns(createMockConfigWithExistingEmptyPath());
            sinon.stub(workspaceApis, 'getWorkspaceFolder').returns(workspaceFolder);

            // Create a project at the workspace root
            const rootProject = new PythonProjectsImpl('workspace', workspaceUri);

            await addPythonProjectSetting([
                {
                    project: rootProject,
                    envManager: CONDA_MANAGER_ID,
                    packageManager: PIP_MANAGER_ID,
                },
            ]);

            // Should write to pythonProjects
            const pythonProjectsUpdates = updateCalls.filter((c) => c.key === 'pythonProjects');
            assert.strictEqual(pythonProjectsUpdates.length, 1, 'Should write to pythonProjects');

            // The path should be fixed to "." not empty string
            const projects = pythonProjectsUpdates[0].value as any[];
            assert.ok(projects.length > 0, 'Should have at least one project entry');
            assert.strictEqual(projects[0].path, '.', 'Path should be fixed to "." not empty string');
            assert.strictEqual(projects[0].envManager, CONDA_MANAGER_ID, 'envManager should be updated');
        });
    });

    suite('setAllManagerSettings - Migration of existing empty path', () => {
        test('should remove existing empty path entry and use defaults in single folder workspace', async () => {
            // Setup: single folder workspace with existing buggy empty path entry
            sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([workspaceFolder]);
            sinon.stub(workspaceApis, 'getWorkspaceFile').returns(undefined); // No workspace file
            const mockConfig = createMockConfigWithExistingEmptyPath();
            (mockConfig as any).inspect = () => ({
                workspaceFolderValue: undefined,
                workspaceValue: [{ path: '', envManager: VENV_MANAGER_ID, packageManager: PIP_MANAGER_ID }],
            });
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);
            sinon.stub(workspaceApis, 'getWorkspaceFolder').returns(workspaceFolder);

            // Create a project at the workspace root
            const rootProject = new PythonProjectsImpl('workspace', workspaceUri);

            await setAllManagerSettings([
                {
                    project: rootProject,
                    envManager: CONDA_MANAGER_ID,
                    packageManager: PIP_MANAGER_ID,
                },
            ]);

            // Should write to pythonProjects to remove the empty path entry
            const pythonProjectsUpdates = updateCalls.filter((c) => c.key === 'pythonProjects');
            assert.strictEqual(pythonProjectsUpdates.length, 1, 'Should write to pythonProjects');

            // The value should be undefined or empty array (entry removed)
            const projects = pythonProjectsUpdates[0].value;
            assert.ok(
                projects === undefined || (Array.isArray(projects) && projects.length === 0),
                'Should remove the buggy entry',
            );

            // Should also write to defaultEnvManager since value changed
            const envManagerUpdates = updateCalls.filter((c) => c.key === 'defaultEnvManager');
            assert.strictEqual(envManagerUpdates.length, 1, 'Should write to defaultEnvManager when value differs');
            assert.strictEqual(envManagerUpdates[0].value, CONDA_MANAGER_ID);
        });

        test('should fix empty path to "." when updating in multi-root workspace', async () => {
            // Setup: multi-root workspace (with workspace file) and existing buggy empty path entry
            sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([workspaceFolder]);
            sinon.stub(workspaceApis, 'getWorkspaceFile').returns(Uri.file('/test.code-workspace'));
            const mockConfig = createMockConfigWithExistingEmptyPath();
            (mockConfig as any).inspect = () => ({
                workspaceFolderValue: [{ path: '', envManager: VENV_MANAGER_ID, packageManager: PIP_MANAGER_ID }],
                workspaceValue: undefined,
            });
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);
            sinon.stub(workspaceApis, 'getWorkspaceFolder').returns(workspaceFolder);

            // Create a project at the workspace root
            const rootProject = new PythonProjectsImpl('workspace', workspaceUri);

            await setAllManagerSettings([
                {
                    project: rootProject,
                    envManager: CONDA_MANAGER_ID,
                    packageManager: PIP_MANAGER_ID,
                },
            ]);

            // Should write to pythonProjects
            const pythonProjectsUpdates = updateCalls.filter((c) => c.key === 'pythonProjects');
            assert.strictEqual(pythonProjectsUpdates.length, 1, 'Should write to pythonProjects');

            // The path should be fixed to "." not empty string
            const projects = pythonProjectsUpdates[0].value as any[];
            assert.ok(projects.length > 0, 'Should have at least one project entry');
            assert.strictEqual(projects[0].path, '.', 'Path should be fixed to "." not empty string');
            assert.strictEqual(projects[0].envManager, CONDA_MANAGER_ID, 'envManager should be updated');
        });
    });
});
