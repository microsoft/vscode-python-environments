/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { ConfigurationTarget, Uri, WorkspaceFolder } from 'vscode';
import * as logging from '../../../common/logging';
import * as persistentState from '../../../common/persistentState';
import * as sender from '../../../common/telemetry/sender';
import * as workspaceApis from '../../../common/workspace.apis';
import {
    addPythonProjectSetting,
    migrateGlobalDefaultEnvManagerSetting,
    removeInlineScriptPythonProjectSettings,
    removePythonProjectSetting,
    setAllManagerSettings,
    setEnvironmentManager,
    setPackageManager,
} from '../../../features/settings/settingHelpers';
import { PythonProjectSettings, PythonProjectsImpl } from '../../../internal.api';
import { MockWorkspaceConfiguration } from '../../mocks/mockWorkspaceConfig';

/**
 * Returns a platform-appropriate workspace path for testing.
 * On Windows, paths must include a drive letter to work correctly with path.resolve().
 */
function getTestWorkspacePath(): string {
    return process.platform === 'win32' ? 'C:\\workspace' : '/workspace';
}

/**
 * These tests verify that manager edits without a project do not write settings
 * and are logged explicitly as ignored global edits.
 */
suite('Setting Helpers - Settings Write Behavior', () => {
    const SYSTEM_MANAGER_ID = 'ms-python.python:system';
    const VENV_MANAGER_ID = 'ms-python.python:venv';
    const PIP_MANAGER_ID = 'ms-python.python:pip';
    const CONDA_MANAGER_ID = 'ms-python.python:conda';

    let updateCalls: Array<{ key: string; value: unknown; target: boolean | ConfigurationTarget | undefined }>;

    setup(() => {
        updateCalls = [];
    });

    teardown(() => {
        sinon.restore();
    });

    /**
     * Creates a mock WorkspaceConfiguration that tracks update calls.
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
                target: configurationTarget,
            });
            return Promise.resolve();
        };

        return mockConfig;
    }

    suite('setAllManagerSettings - Global Settings', () => {
        test('should NOT write global defaultEnvManager even when value differs from current', async () => {
            const mockConfig = createMockConfig({
                currentEnvManager: VENV_MANAGER_ID,
            });
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);
            const traceVerboseStub = sinon.stub(logging, 'traceVerbose');

            await setAllManagerSettings([
                {
                    project: undefined, // Global scope
                    envManager: SYSTEM_MANAGER_ID,
                    packageManager: PIP_MANAGER_ID,
                },
            ]);

            const envManagerUpdates = updateCalls.filter((c) => c.key === 'defaultEnvManager');
            assert.strictEqual(envManagerUpdates.length, 0, 'Should never write defaultEnvManager for global edits');
            sinon.assert.calledWithMatch(
                traceVerboseStub,
                '[setAllManagerSettings] Ignoring 1 edit(s) without a project because python-envs does not persist manager defaults to User/global settings.',
            );
        });

        test('should NOT write global defaultPackageManager even when value differs from current', async () => {
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

            const pkgManagerUpdates = updateCalls.filter((c) => c.key === 'defaultPackageManager');
            assert.strictEqual(
                pkgManagerUpdates.length,
                0,
                'Should never write defaultPackageManager for global edits',
            );
        });
        test('should NOT write to global even when value differs from current', async () => {
            const mockConfig = createMockConfig({
                currentEnvManager: VENV_MANAGER_ID,
            });
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);
            const traceVerboseStub = sinon.stub(logging, 'traceVerbose');

            await setEnvironmentManager([
                {
                    project: undefined, // Global scope
                    envManager: SYSTEM_MANAGER_ID,
                },
            ]);

            const envManagerUpdates = updateCalls.filter((c) => c.key === 'defaultEnvManager');
            assert.strictEqual(envManagerUpdates.length, 0, 'Should never write defaultEnvManager for global edits');
            sinon.assert.calledWithMatch(
                traceVerboseStub,
                '[setEnvironmentManager] Ignoring 1 edit(s) without a project because python-envs does not persist manager defaults to User/global settings.',
            );
        });
    });

    suite('setPackageManager - Global Settings', () => {
        test('should NOT write to global even when value differs from current', async () => {
            const mockConfig = createMockConfig({
                currentPkgManager: PIP_MANAGER_ID,
            });
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);
            const traceVerboseStub = sinon.stub(logging, 'traceVerbose');

            await setPackageManager([
                {
                    project: undefined, // Global scope
                    packageManager: CONDA_MANAGER_ID,
                },
            ]);

            const pkgManagerUpdates = updateCalls.filter((c) => c.key === 'defaultPackageManager');
            assert.strictEqual(
                pkgManagerUpdates.length,
                0,
                'Should never write defaultPackageManager for global edits',
            );
            sinon.assert.calledWithMatch(
                traceVerboseStub,
                '[setPackageManager] Ignoring 1 edit(s) without a project because python-envs does not persist manager defaults to User/global settings.',
            );
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

    let updateCalls: Array<{ key: string; value: unknown; target: boolean | ConfigurationTarget | undefined }>;

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
                target: configurationTarget,
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

suite('Setting Helpers - Project Removal', () => {
    const INLINE_MANAGER_ID = 'ms-python.python:inline-script';
    const VENV_MANAGER_ID = 'ms-python.python:venv';
    const PIP_MANAGER_ID = 'ms-python.python:pip';
    const firstWorkspacePath = getTestWorkspacePath();
    const firstWorkspaceUri = Uri.file(firstWorkspacePath);
    const firstWorkspace: WorkspaceFolder = {
        uri: firstWorkspaceUri,
        name: 'workspace',
        index: 0,
    };
    const secondWorkspaceUri = Uri.file(process.platform === 'win32' ? 'C:\\workspace2' : '/workspace2');
    const secondWorkspace: WorkspaceFolder = {
        uri: secondWorkspaceUri,
        name: 'workspace2',
        index: 1,
    };

    let updateCalls: Array<{
        workspace: string;
        key: string;
        value: unknown;
        target: boolean | ConfigurationTarget | undefined;
    }>;

    setup(() => {
        updateCalls = [];
    });

    teardown(() => {
        sinon.restore();
    });

    function createProjectConfig(options: {
        workspaceName: string;
        globalValue?: PythonProjectSettings[];
        workspaceValue?: PythonProjectSettings[];
        workspaceFolderValue?: PythonProjectSettings[];
    }): MockWorkspaceConfiguration {
        const mockConfig = new MockWorkspaceConfiguration();
        const mergedProjects = [
            ...(options.globalValue ?? []),
            ...(options.workspaceValue ?? []),
            ...(options.workspaceFolderValue ?? []),
        ];
        (mockConfig as any).get = <T>(key: string, defaultValue?: T): T | undefined =>
            key === 'pythonProjects' ? (mergedProjects as unknown as T) : defaultValue;
        (mockConfig as any).inspect = (key: string) =>
            key === 'pythonProjects'
                ? {
                      globalValue: options.globalValue,
                      workspaceValue: options.workspaceValue,
                      workspaceFolderValue: options.workspaceFolderValue,
                  }
                : undefined;
        mockConfig.update = (
            section: string,
            value: unknown,
            configurationTarget?: boolean | ConfigurationTarget,
        ): Promise<void> => {
            updateCalls.push({
                workspace: options.workspaceName,
                key: section,
                value,
                target: configurationTarget,
            });
            return Promise.resolve();
        };
        return mockConfig;
    }

    function cloneSettings(settings: PythonProjectSettings[] | undefined): PythonProjectSettings[] {
        return (settings ?? []).map((setting) => ({ ...setting }));
    }

    function createSharedWorkspaceConfigs(options: {
        workspaceValue: PythonProjectSettings[];
        firstWorkspaceFolderValue?: PythonProjectSettings[];
        secondWorkspaceFolderValue?: PythonProjectSettings[];
    }): { firstConfig: MockWorkspaceConfiguration; secondConfig: MockWorkspaceConfiguration; getWorkspaceValue: () => PythonProjectSettings[] } {
        let sharedWorkspaceValue = cloneSettings(options.workspaceValue);
        const workspaceFolderValues = new Map<string, PythonProjectSettings[]>([
            [firstWorkspace.name, cloneSettings(options.firstWorkspaceFolderValue)],
            [secondWorkspace.name, cloneSettings(options.secondWorkspaceFolderValue)],
        ]);

        function createConfigForWorkspace(workspace: WorkspaceFolder): MockWorkspaceConfiguration {
            const mockConfig = new MockWorkspaceConfiguration();
            (mockConfig as any).get = <T>(key: string, defaultValue?: T): T | undefined =>
                key === 'pythonProjects'
                    ? ([...sharedWorkspaceValue, ...workspaceFolderValues.get(workspace.name)!] as unknown as T)
                    : defaultValue;
            (mockConfig as any).inspect = (key: string) =>
                key === 'pythonProjects'
                    ? {
                          workspaceValue: cloneSettings(sharedWorkspaceValue),
                          workspaceFolderValue: cloneSettings(workspaceFolderValues.get(workspace.name)),
                      }
                    : undefined;
            mockConfig.update = (
                section: string,
                value: unknown,
                configurationTarget?: boolean | ConfigurationTarget,
            ): Promise<void> => {
                updateCalls.push({
                    workspace: workspace.name,
                    key: section,
                    value,
                    target: configurationTarget,
                });
                const updatedSettings = cloneSettings(value as PythonProjectSettings[] | undefined);
                if (configurationTarget === ConfigurationTarget.Workspace) {
                    sharedWorkspaceValue = updatedSettings;
                } else if (configurationTarget === ConfigurationTarget.WorkspaceFolder) {
                    workspaceFolderValues.set(workspace.name, updatedSettings);
                }
                return Promise.resolve();
            };
            return mockConfig;
        }

        return {
            firstConfig: createConfigForWorkspace(firstWorkspace),
            secondConfig: createConfigForWorkspace(secondWorkspace),
            getWorkspaceValue: () => cloneSettings(sharedWorkspaceValue),
        };
    }

    suite('removePythonProjectSetting (bde7cf8-equivalent generic behavior)', () => {
        test('rewrites the merged effective array back to workspace scope', async () => {
            const project = new PythonProjectsImpl('script.py', Uri.file(path.join(firstWorkspacePath, 'script.py')));
            const config = createProjectConfig({
                workspaceName: firstWorkspace.name,
                workspaceValue: [
                    { path: 'script.py', envManager: INLINE_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                ],
                workspaceFolderValue: [
                    { path: 'script.py', envManager: VENV_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                ],
            });
            sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([firstWorkspace]);
            sinon.stub(workspaceApis, 'getWorkspaceFolder').returns(firstWorkspace);
            sinon.stub(workspaceApis, 'getConfiguration').returns(config);

            await removePythonProjectSetting([{ project }]);

            assert.strictEqual(updateCalls.length, 1, 'Should update pythonProjects once');
            assert.deepStrictEqual(updateCalls[0], {
                workspace: firstWorkspace.name,
                key: 'pythonProjects',
                value: [{ path: 'script.py', envManager: VENV_MANAGER_ID, packageManager: PIP_MANAGER_ID }],
                target: ConfigurationTarget.Workspace,
            });
        });

        test('ignores envManager metadata and removes the first same-path entry', async () => {
            const project = new PythonProjectsImpl('script.py', Uri.file(path.join(firstWorkspacePath, 'script.py')));
            const config = createProjectConfig({
                workspaceName: firstWorkspace.name,
                workspaceValue: [
                    { path: 'script.py', envManager: INLINE_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                    { path: 'script.py', envManager: VENV_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                    { path: 'other.py', envManager: INLINE_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                ],
            });
            sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([firstWorkspace]);
            sinon.stub(workspaceApis, 'getWorkspaceFolder').returns(firstWorkspace);
            sinon.stub(workspaceApis, 'getConfiguration').returns(config);

            await removePythonProjectSetting([{ project, envManager: VENV_MANAGER_ID }]);

            assert.strictEqual(updateCalls.length, 1, 'Should update pythonProjects once');
            assert.deepStrictEqual(updateCalls[0].value, [
                { path: 'script.py', envManager: VENV_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                { path: 'other.py', envManager: INLINE_MANAGER_ID, packageManager: PIP_MANAGER_ID },
            ]);
            assert.strictEqual(updateCalls[0].target, ConfigurationTarget.Workspace);
        });
    });

    suite('removeInlineScriptPythonProjectSettings', () => {
        test('removes global inline entries when no workspace folders are open', async () => {
            const config = createProjectConfig({
                workspaceName: 'global',
                globalValue: [
                    { path: 'script.py', envManager: INLINE_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                    { path: 'keep.py', envManager: VENV_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                ],
            });
            sinon.stub(workspaceApis, 'getWorkspaceFolders').returns(undefined);
            sinon.stub(workspaceApis, 'getConfiguration').callsFake((_section?: string, scope?: unknown) => {
                assert.strictEqual(scope, undefined);
                return config;
            });

            const removedProjects = await removeInlineScriptPythonProjectSettings([]);

            assert.deepStrictEqual(removedProjects, []);
            assert.deepStrictEqual(updateCalls, [
                {
                    workspace: 'global',
                    key: 'pythonProjects',
                    value: [{ path: 'keep.py', envManager: VENV_MANAGER_ID, packageManager: PIP_MANAGER_ID }],
                    target: ConfigurationTarget.Global,
                },
            ]);
        });

        test('removes all inline-script entries while preserving non-inline duplicates', async () => {
            const project = new PythonProjectsImpl('script.py', Uri.file(path.join(firstWorkspacePath, 'script.py')));
            const otherProject = new PythonProjectsImpl('other.py', Uri.file(path.join(firstWorkspacePath, 'other.py')));
            const config = createProjectConfig({
                workspaceName: firstWorkspace.name,
                workspaceValue: [
                    { path: 'script.py', envManager: INLINE_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                    { path: 'script.py', envManager: VENV_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                    { path: 'other.py', envManager: INLINE_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                ],
            });
            sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([firstWorkspace]);
            sinon.stub(workspaceApis, 'getWorkspaceFolder').returns(firstWorkspace);
            sinon.stub(workspaceApis, 'getConfiguration').returns(config);

            const removedProjects = await removeInlineScriptPythonProjectSettings([project, otherProject]);

            assert.deepStrictEqual(
                removedProjects.map((entry) => entry.uri.fsPath),
                [otherProject.uri.fsPath],
                'Only projects left without any non-inline setting should be removed from memory',
            );
            assert.strictEqual(updateCalls.length, 1, 'Should update pythonProjects once');
            assert.strictEqual(updateCalls[0].workspace, firstWorkspace.name);
            assert.strictEqual(updateCalls[0].key, 'pythonProjects');
            assert.strictEqual(updateCalls[0].target, ConfigurationTarget.Workspace);
            assert.deepStrictEqual(updateCalls[0].value, [
                { path: 'script.py', envManager: VENV_MANAGER_ID, packageManager: PIP_MANAGER_ID },
            ]);
        });

        test('removes an inline root setting without returning the intrinsic workspace project for unloading', async () => {
            const rootProject = new PythonProjectsImpl(firstWorkspace.name, firstWorkspace.uri);
            const config = createProjectConfig({
                workspaceName: firstWorkspace.name,
                workspaceValue: [
                    { path: '.', envManager: INLINE_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                ],
            });
            sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([firstWorkspace]);
            sinon.stub(workspaceApis, 'getWorkspaceFolder').returns(firstWorkspace);
            sinon.stub(workspaceApis, 'getConfiguration').returns(config);

            const removedProjects = await removeInlineScriptPythonProjectSettings([rootProject]);

            assert.deepStrictEqual(removedProjects, []);
            assert.deepStrictEqual(updateCalls, [
                {
                    workspace: firstWorkspace.name,
                    key: 'pythonProjects',
                    value: undefined,
                    target: ConfigurationTarget.Workspace,
                },
            ]);
        });

        test('removes inline-script settings even when the project is not loaded', async () => {
            const config = createProjectConfig({
                workspaceName: firstWorkspace.name,
                workspaceValue: [
                    { path: 'runner', envManager: INLINE_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                    { path: 'keep', envManager: VENV_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                ],
            });
            sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([firstWorkspace]);
            sinon.stub(workspaceApis, 'getConfiguration').returns(config);

            const removedProjects = await removeInlineScriptPythonProjectSettings([]);

            assert.deepStrictEqual(removedProjects, [], 'No loaded project should be returned for memory cleanup');
            assert.strictEqual(updateCalls.length, 1, 'Should update pythonProjects once');
            assert.deepStrictEqual(updateCalls[0].value, [
                { path: 'keep', envManager: VENV_MANAGER_ID, packageManager: PIP_MANAGER_ID },
            ]);
        });

        test('removes only one of two roots that share the same relative path', async () => {
            const firstProject = new PythonProjectsImpl('script.py', Uri.file(path.join(firstWorkspacePath, 'script.py')));
            const secondProject = new PythonProjectsImpl(
                'script.py',
                Uri.file(path.join(secondWorkspaceUri.fsPath, 'script.py')),
            );
            const firstConfig = createProjectConfig({
                workspaceName: firstWorkspace.name,
                workspaceFolderValue: [
                    { path: 'script.py', envManager: INLINE_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                ],
            });
            const secondConfig = createProjectConfig({
                workspaceName: secondWorkspace.name,
                workspaceFolderValue: [
                    { path: 'script.py', envManager: VENV_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                ],
            });
            sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([firstWorkspace, secondWorkspace]);
            sinon.stub(workspaceApis, 'getWorkspaceFolder').callsFake((uri) =>
                uri.fsPath.startsWith(secondWorkspaceUri.fsPath) ? secondWorkspace : firstWorkspace,
            );
            sinon.stub(workspaceApis, 'getConfiguration').callsFake((_section?: string, scope?: unknown) => {
                const uri = scope as Uri;
                return uri.fsPath === secondWorkspaceUri.fsPath ? secondConfig : firstConfig;
            });

            const removedProjects = await removeInlineScriptPythonProjectSettings([firstProject, secondProject]);

            assert.deepStrictEqual(removedProjects.map((project) => project.uri.fsPath), [firstProject.uri.fsPath]);
            assert.strictEqual(updateCalls.length, 1, 'Only the matching workspace folder should be updated');
            assert.strictEqual(updateCalls[0].workspace, firstWorkspace.name);
            assert.strictEqual(updateCalls[0].target, ConfigurationTarget.WorkspaceFolder);
            assert.strictEqual(updateCalls[0].value, undefined);
            assert.strictEqual(secondProject.uri.fsPath, path.join(secondWorkspaceUri.fsPath, 'script.py'));
        });

        test('removes a hidden shared inline entry while preserving a folder override for the same URI', async () => {
            const project = new PythonProjectsImpl('script.py', Uri.file(path.join(firstWorkspacePath, 'script.py')));
            const config = createProjectConfig({
                workspaceName: firstWorkspace.name,
                workspaceValue: [
                    {
                        path: 'script.py',
                        envManager: INLINE_MANAGER_ID,
                        packageManager: PIP_MANAGER_ID,
                        workspace: firstWorkspace.name,
                    },
                ],
                workspaceFolderValue: [
                    { path: 'script.py', envManager: VENV_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                ],
            });
            sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([firstWorkspace]);
            sinon.stub(workspaceApis, 'getWorkspaceFolder').returns(firstWorkspace);
            sinon.stub(workspaceApis, 'getConfiguration').returns(config);

            const removedProjects = await removeInlineScriptPythonProjectSettings([project]);

            assert.deepStrictEqual(removedProjects, [], 'Folder override should keep the project configured');
            const workspaceUpdate = updateCalls.find((call) => call.target === ConfigurationTarget.Workspace);
            const folderUpdate = updateCalls.find((call) => call.target === ConfigurationTarget.WorkspaceFolder);
            assert.ok(workspaceUpdate, 'WorkspaceValue source should be updated');
            assert.strictEqual(workspaceUpdate!.value, undefined);
            assert.strictEqual(folderUpdate, undefined, 'Folder override should not be rewritten');
        });

        test('aggregates shared workspaceValue removals across folders into one update', async () => {
            const firstProject = new PythonProjectsImpl('first', Uri.file(path.join(firstWorkspacePath, 'first')));
            const secondProject = new PythonProjectsImpl('second', Uri.file(path.join(secondWorkspaceUri.fsPath, 'second')));
            const { firstConfig, secondConfig, getWorkspaceValue } = createSharedWorkspaceConfigs({
                workspaceValue: [
                    {
                        path: 'first',
                        envManager: INLINE_MANAGER_ID,
                        packageManager: PIP_MANAGER_ID,
                        workspace: firstWorkspace.name,
                    },
                    {
                        path: 'second',
                        envManager: INLINE_MANAGER_ID,
                        packageManager: PIP_MANAGER_ID,
                        workspace: secondWorkspace.name,
                    },
                ],
            });
            sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([firstWorkspace, secondWorkspace]);
            sinon.stub(workspaceApis, 'getWorkspaceFolder').callsFake((uri) =>
                uri.fsPath.startsWith(secondWorkspaceUri.fsPath) ? secondWorkspace : firstWorkspace,
            );
            sinon.stub(workspaceApis, 'getConfiguration').callsFake((_section?: string, scope?: unknown) => {
                const uri = scope as Uri;
                return uri.fsPath === secondWorkspaceUri.fsPath ? secondConfig : firstConfig;
            });

            const removedProjects = await removeInlineScriptPythonProjectSettings([firstProject, secondProject]);

            assert.deepStrictEqual(
                removedProjects.map((project) => project.uri.fsPath).sort(),
                [firstProject.uri.fsPath, secondProject.uri.fsPath].sort(),
            );
            assert.strictEqual(
                updateCalls.filter((call) => call.target === ConfigurationTarget.Workspace).length,
                1,
                'Shared workspaceValue should be written once',
            );
            assert.deepStrictEqual(getWorkspaceValue(), []);
        });

        test('removes every inline shared entry without resurrecting non-inline siblings', async () => {
            const firstProject = new PythonProjectsImpl('first', Uri.file(path.join(firstWorkspacePath, 'first')));
            const secondProject = new PythonProjectsImpl(
                'second',
                Uri.file(path.join(secondWorkspaceUri.fsPath, 'second')),
            );
            const { firstConfig, secondConfig, getWorkspaceValue } = createSharedWorkspaceConfigs({
                workspaceValue: [
                    {
                        path: 'first',
                        envManager: INLINE_MANAGER_ID,
                        packageManager: PIP_MANAGER_ID,
                        workspace: firstWorkspace.name,
                    },
                    {
                        path: 'second',
                        envManager: INLINE_MANAGER_ID,
                        packageManager: PIP_MANAGER_ID,
                        workspace: secondWorkspace.name,
                    },
                    {
                        path: 'keep',
                        envManager: VENV_MANAGER_ID,
                        packageManager: PIP_MANAGER_ID,
                        workspace: secondWorkspace.name,
                    },
                ],
            });
            sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([firstWorkspace, secondWorkspace]);
            sinon.stub(workspaceApis, 'getWorkspaceFolder').callsFake((uri) =>
                uri.fsPath.startsWith(secondWorkspaceUri.fsPath) ? secondWorkspace : firstWorkspace,
            );
            sinon.stub(workspaceApis, 'getConfiguration').callsFake((_section?: string, scope?: unknown) => {
                const uri = scope as Uri;
                return uri.fsPath === secondWorkspaceUri.fsPath ? secondConfig : firstConfig;
            });

            const removedProjects = await removeInlineScriptPythonProjectSettings([firstProject, secondProject]);

            assert.deepStrictEqual(
                removedProjects.map((project) => project.uri.fsPath).sort(),
                [firstProject.uri.fsPath, secondProject.uri.fsPath].sort(),
            );
            assert.strictEqual(
                updateCalls.filter((call) => call.target === ConfigurationTarget.Workspace).length,
                1,
                'Shared workspaceValue should still be written once',
            );
            assert.deepStrictEqual(getWorkspaceValue(), [
                {
                    path: 'keep',
                    envManager: VENV_MANAGER_ID,
                    packageManager: PIP_MANAGER_ID,
                    workspace: secondWorkspace.name,
                },
            ]);
            assert.strictEqual(secondProject.uri.fsPath, path.join(secondWorkspaceUri.fsPath, 'second'));
        });

        test('removes matching inline-script projects independently in a multi-root workspace', async () => {
            const firstProject = new PythonProjectsImpl('script.py', Uri.file(path.join(firstWorkspacePath, 'script.py')));
            const secondProject = new PythonProjectsImpl(
                'script.py',
                Uri.file(path.join(secondWorkspaceUri.fsPath, 'script.py')),
            );
            const firstConfig = createProjectConfig({
                workspaceName: firstWorkspace.name,
                workspaceValue: [
                    { path: 'script.py', envManager: INLINE_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                ],
                workspaceFolderValue: [
                    { path: 'keep-folder.py', envManager: VENV_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                ],
            });
            const secondConfig = createProjectConfig({
                workspaceName: secondWorkspace.name,
                workspaceFolderValue: [
                    { path: 'script.py', envManager: INLINE_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                    { path: 'keep.py', envManager: VENV_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                ],
            });
            sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([firstWorkspace, secondWorkspace]);
            sinon.stub(workspaceApis, 'getWorkspaceFolder').callsFake((uri) =>
                uri.fsPath.startsWith(secondWorkspaceUri.fsPath) ? secondWorkspace : firstWorkspace,
            );
            sinon.stub(workspaceApis, 'getConfiguration').callsFake((_section?: string, scope?: unknown) => {
                const uri = scope as Uri;
                return uri.fsPath === secondWorkspaceUri.fsPath ? secondConfig : firstConfig;
            });

            const removedProjects = await removeInlineScriptPythonProjectSettings([firstProject, secondProject]);

            assert.deepStrictEqual(
                removedProjects.map((project) => project.uri.fsPath).sort(),
                [firstProject.uri.fsPath, secondProject.uri.fsPath].sort(),
            );
            assert.strictEqual(updateCalls.length, 2, 'Should update each workspace independently');
            const firstWorkspaceUpdate = updateCalls.find((call) => call.workspace === firstWorkspace.name);
            const secondWorkspaceUpdate = updateCalls.find((call) => call.workspace === secondWorkspace.name);
            assert.ok(firstWorkspaceUpdate, 'First workspace should receive an update');
            assert.ok(secondWorkspaceUpdate, 'Second workspace should receive an update');
            assert.strictEqual(firstWorkspaceUpdate!.value, undefined);
            assert.deepStrictEqual(secondWorkspaceUpdate!.value, [
                { path: 'keep.py', envManager: VENV_MANAGER_ID, packageManager: PIP_MANAGER_ID },
            ]);
            assert.ok(
                updateCalls.some((call) => call.workspace === firstWorkspace.name && call.target === ConfigurationTarget.Workspace) &&
                    updateCalls.some(
                        (call) =>
                            call.workspace === secondWorkspace.name &&
                            call.target === ConfigurationTarget.WorkspaceFolder,
                    ),
                'Should update the same configuration scope that originally contained each project entry',
            );
        });

        test('removes global inline entries once while preserving higher-precedence non-inline entries', async () => {
            const globalProject = new PythonProjectsImpl(
                'global.py',
                Uri.file(path.join(firstWorkspacePath, 'global.py')),
            );
            const workspaceProject = new PythonProjectsImpl(
                'workspace.py',
                Uri.file(path.join(firstWorkspacePath, 'workspace.py')),
            );
            const folderProject = new PythonProjectsImpl(
                'folder.py',
                Uri.file(path.join(secondWorkspaceUri.fsPath, 'folder.py')),
            );
            const firstConfig = createProjectConfig({
                workspaceName: firstWorkspace.name,
                globalValue: [
                    { path: 'global.py', envManager: INLINE_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                    { path: 'keep.py', envManager: VENV_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                ],
                workspaceValue: [
                    { path: 'workspace.py', envManager: INLINE_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                ],
                workspaceFolderValue: [
                    { path: 'global.py', envManager: VENV_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                ],
            });
            const secondConfig = createProjectConfig({
                workspaceName: secondWorkspace.name,
                globalValue: [
                    { path: 'global.py', envManager: INLINE_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                    { path: 'keep.py', envManager: VENV_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                ],
                workspaceFolderValue: [
                    { path: 'folder.py', envManager: INLINE_MANAGER_ID, packageManager: PIP_MANAGER_ID },
                ],
            });
            sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([firstWorkspace, secondWorkspace]);
            sinon.stub(workspaceApis, 'getWorkspaceFolder').callsFake((uri) =>
                uri.fsPath.startsWith(secondWorkspaceUri.fsPath) ? secondWorkspace : firstWorkspace,
            );
            sinon.stub(workspaceApis, 'getConfiguration').callsFake((_section?: string, scope?: unknown) => {
                const uri = scope as Uri;
                return uri.fsPath === secondWorkspaceUri.fsPath ? secondConfig : firstConfig;
            });

            const removedProjects = await removeInlineScriptPythonProjectSettings([
                globalProject,
                workspaceProject,
                folderProject,
            ]);

            assert.deepStrictEqual(
                removedProjects.map((project) => project.uri.fsPath).sort(),
                [workspaceProject.uri.fsPath, folderProject.uri.fsPath].sort(),
                'The folder-level non-inline entry keeps the global project loaded',
            );
            const globalUpdates = updateCalls.filter((call) => call.target === ConfigurationTarget.Global);
            assert.strictEqual(globalUpdates.length, 1, 'Global settings should be updated exactly once');
            assert.deepStrictEqual(globalUpdates[0].value, [
                { path: 'keep.py', envManager: VENV_MANAGER_ID, packageManager: PIP_MANAGER_ID },
            ]);
            assert.ok(
                updateCalls.some(
                    (call) =>
                        call.workspace === firstWorkspace.name &&
                        call.target === ConfigurationTarget.Workspace &&
                        call.value === undefined,
                ),
                'Workspace-scoped inline entry should be removed at its source',
            );
            assert.ok(
                updateCalls.some(
                    (call) =>
                        call.workspace === secondWorkspace.name &&
                        call.target === ConfigurationTarget.WorkspaceFolder &&
                        call.value === undefined,
                ),
                'Folder-scoped inline entry should be removed at its source',
            );
        });
    });
});

suite('Setting Helpers - migrateGlobalDefaultEnvManagerSetting', () => {
    const SYSTEM_MANAGER_ID = 'ms-python.python:system';
    const VENV_MANAGER_ID = 'ms-python.python:venv';
    const MIGRATION_FLAG_KEY = 'globalSettingsMigration.systemEnvManagerRemoved';
    const TELEMETRY_EVENT = 'MIGRATION.SYSTEM_ENV_MANAGER';

    let sandbox: sinon.SinonSandbox;
    let sendTelemetryEventStub: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        sendTelemetryEventStub = sandbox.stub(sender, 'sendTelemetryEvent');
    });

    teardown(() => {
        sandbox.restore();
    });

    function createMockPersistentState(data: Record<string, unknown> = {}) {
        const store: Record<string, unknown> = { ...data };
        return {
            get: async <T>(key: string): Promise<T | undefined> => store[key] as T | undefined,
            set: async <T>(key: string, value: T): Promise<void> => {
                store[key] = value;
            },
            clear: async (): Promise<void> => {
                Object.keys(store).forEach((k) => delete store[k]);
            },
        };
    }

    /**
     * Builds a mock WorkspaceConfiguration whose `inspect('defaultEnvManager')` returns the
     * provided sequence of values (one per call), so a test can simulate a different state
     * for the post-update re-inspect. If only one entry is given it is reused for every call.
     */
    function createMockConfig(options: {
        inspectSequence: Array<Record<string, unknown> | undefined>;
        updateImpl?: (key: string, value: unknown, target: ConfigurationTarget) => Promise<void>;
    }) {
        const updateCalls: Array<{ key: string; value: unknown; target: ConfigurationTarget }> = [];
        let callIndex = 0;
        const mockConfig = {
            get: () => undefined,
            has: () => false,
            inspect: (key: string) => {
                if (key !== 'defaultEnvManager') {
                    return undefined;
                }
                const i = Math.min(callIndex, options.inspectSequence.length - 1);
                callIndex += 1;
                return options.inspectSequence[i];
            },
            update: (key: string, value: unknown, target: ConfigurationTarget) => {
                updateCalls.push({ key, value, target });
                return options.updateImpl ? options.updateImpl(key, value, target) : Promise.resolve();
            },
        };
        return { mockConfig, updateCalls };
    }

    function assertTelemetryOutcome(expected: string, extraProps?: Record<string, unknown>) {
        assert.strictEqual(sendTelemetryEventStub.callCount, 1, 'Should emit exactly one telemetry event');
        const call = sendTelemetryEventStub.firstCall;
        assert.strictEqual(call.args[0], TELEMETRY_EVENT, 'Should use the correct event name');
        const props = call.args[2] as Record<string, unknown> | undefined;
        assert.ok(props, 'Telemetry event should have properties');
        assert.strictEqual(props!.outcome, expected, `outcome should be '${expected}'`);
        if (extraProps) {
            for (const [k, v] of Object.entries(extraProps)) {
                assert.strictEqual(props![k], v, `prop '${k}' should be '${String(v)}'`);
            }
        }
    }

    test('removes system defaultEnvManager from globalValue and marks migrated', async () => {
        const mockState = createMockPersistentState();
        sandbox.stub(persistentState, 'getGlobalPersistentState').resolves(mockState);

        const { mockConfig, updateCalls } = createMockConfig({
            inspectSequence: [{ globalValue: SYSTEM_MANAGER_ID }, { globalValue: undefined }],
        });
        sandbox.stub(workspaceApis, 'getConfiguration').returns(mockConfig as any);

        await migrateGlobalDefaultEnvManagerSetting();

        const removal = updateCalls.find(
            (c) => c.key === 'defaultEnvManager' && c.target === ConfigurationTarget.Global,
        );
        assert.ok(removal, 'Should remove defaultEnvManager from Global settings');
        assert.strictEqual(removal!.value, undefined, 'Should pass undefined to clear the setting');

        const migrated = await mockState.get<boolean>(MIGRATION_FLAG_KEY);
        assert.strictEqual(migrated, true, 'Should set migration flag');
        assertTelemetryOutcome('removed');
    });

    test('removes when stale value is in globalRemoteValue (remote context)', async () => {
        const mockState = createMockPersistentState();
        sandbox.stub(persistentState, 'getGlobalPersistentState').resolves(mockState);

        const { mockConfig, updateCalls } = createMockConfig({
            inspectSequence: [
                { globalRemoteValue: SYSTEM_MANAGER_ID, globalValue: undefined },
                { globalRemoteValue: undefined, globalValue: undefined },
            ],
        });
        sandbox.stub(workspaceApis, 'getConfiguration').returns(mockConfig as any);

        await migrateGlobalDefaultEnvManagerSetting();

        assert.strictEqual(updateCalls.length, 1, 'Should call update once');
        const migrated = await mockState.get<boolean>(MIGRATION_FLAG_KEY);
        assert.strictEqual(migrated, true);
        assertTelemetryOutcome('removed');
    });

    test('removes when stale value is in globalLocalValue', async () => {
        const mockState = createMockPersistentState();
        sandbox.stub(persistentState, 'getGlobalPersistentState').resolves(mockState);

        const { mockConfig, updateCalls } = createMockConfig({
            inspectSequence: [
                { globalLocalValue: SYSTEM_MANAGER_ID, globalValue: undefined },
                { globalLocalValue: undefined, globalValue: undefined },
            ],
        });
        sandbox.stub(workspaceApis, 'getConfiguration').returns(mockConfig as any);

        await migrateGlobalDefaultEnvManagerSetting();

        assert.strictEqual(updateCalls.length, 1, 'Should call update once');
        const migrated = await mockState.get<boolean>(MIGRATION_FLAG_KEY);
        assert.strictEqual(migrated, true);
        assertTelemetryOutcome('removed');
    });

    test('does not mark migrated when another user-scope slot still has the stale value (partial)', async () => {
        const mockState = createMockPersistentState();
        sandbox.stub(persistentState, 'getGlobalPersistentState').resolves(mockState);

        // Initial inspect: both globalValue and globalLocalValue have the stale value.
        // Post-update: only globalValue is cleared (current context); globalLocalValue persists.
        const { mockConfig, updateCalls } = createMockConfig({
            inspectSequence: [
                { globalValue: SYSTEM_MANAGER_ID, globalLocalValue: SYSTEM_MANAGER_ID },
                { globalValue: undefined, globalLocalValue: SYSTEM_MANAGER_ID },
            ],
        });
        sandbox.stub(workspaceApis, 'getConfiguration').returns(mockConfig as any);

        await migrateGlobalDefaultEnvManagerSetting();

        assert.strictEqual(updateCalls.length, 1, 'Should still attempt removal once');
        const migrated = await mockState.get<boolean>(MIGRATION_FLAG_KEY);
        assert.notStrictEqual(migrated, true, 'Should NOT set migration flag when another slot still holds the value');
        assertTelemetryOutcome('partial');
    });

    test('does not remove when no user-scope slot has the stale value (not_set) and marks migrated', async () => {
        const mockState = createMockPersistentState();
        sandbox.stub(persistentState, 'getGlobalPersistentState').resolves(mockState);

        const { mockConfig, updateCalls } = createMockConfig({
            inspectSequence: [{ globalValue: VENV_MANAGER_ID }],
        });
        sandbox.stub(workspaceApis, 'getConfiguration').returns(mockConfig as any);

        await migrateGlobalDefaultEnvManagerSetting();

        assert.strictEqual(updateCalls.length, 0, 'Should not call update when no stale value present');
        const migrated = await mockState.get<boolean>(MIGRATION_FLAG_KEY);
        assert.strictEqual(migrated, true, 'Should mark migrated so we never check again');
        assertTelemetryOutcome('not_set');
    });

    test('does not run migration if already migrated', async () => {
        const mockState = createMockPersistentState({
            [MIGRATION_FLAG_KEY]: true,
        });
        sandbox.stub(persistentState, 'getGlobalPersistentState').resolves(mockState);

        const { mockConfig, updateCalls } = createMockConfig({
            inspectSequence: [{ globalValue: SYSTEM_MANAGER_ID }],
        });
        const getConfigStub = sandbox.stub(workspaceApis, 'getConfiguration').returns(mockConfig as any);

        await migrateGlobalDefaultEnvManagerSetting();

        assert.strictEqual(updateCalls.length, 0, 'Should not write any settings if already migrated');
        assert.strictEqual(getConfigStub.callCount, 0, 'Should short-circuit before reading configuration');
        assert.strictEqual(sendTelemetryEventStub.callCount, 0, 'Should not emit telemetry on no-op runs');
    });

    test('does not set migration flag if update throws and reports failed telemetry', async () => {
        const mockState = createMockPersistentState();
        sandbox.stub(persistentState, 'getGlobalPersistentState').resolves(mockState);

        const updateError = new Error('settings.json read-only');
        let updateCalled = false;
        const { mockConfig } = createMockConfig({
            inspectSequence: [{ globalValue: SYSTEM_MANAGER_ID }],
            updateImpl: () => {
                updateCalled = true;
                return Promise.reject(updateError);
            },
        });
        sandbox.stub(workspaceApis, 'getConfiguration').returns(mockConfig as any);

        await migrateGlobalDefaultEnvManagerSetting();

        assert.strictEqual(updateCalled, true, 'Failure path must actually attempt the update');
        const migrated = await mockState.get<boolean>(MIGRATION_FLAG_KEY);
        assert.notStrictEqual(migrated, true, 'Should NOT set migration flag when removal fails');
        assertTelemetryOutcome('failed', { errorType: 'Error' });
    });
});
