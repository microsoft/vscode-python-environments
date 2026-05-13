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
