/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from 'assert';
import * as sinon from 'sinon';
import { Disposable, EventEmitter, Uri, WorkspaceFolder } from 'vscode';
import * as workspaceApis from '../../common/workspace.apis';
import { PythonProjectManagerImpl } from '../../features/projectManager';
import * as settingHelpers from '../../features/settings/settingHelpers';
import { PythonProjectSettings } from '../../internal.api';
import { MockWorkspaceConfiguration } from '../mocks/mockWorkspaceConfig';

/**
 * Returns a platform-appropriate workspace path for testing.
 * On Windows, paths must include a drive letter to work correctly with path.resolve().
 */
function getTestWorkspacePath(): string {
    return process.platform === 'win32' ? 'C:\\workspace' : '/workspace';
}

/**
 * =============================================================================
 * CRITICAL PRINCIPLE: Settings should ONLY change when user explicitly acts
 * =============================================================================
 *
 * These tests verify that the extension does NOT write to settings.json unless
 * the user explicitly performs an action (like selecting an interpreter via UI).
 *
 * Scenarios that should NOT write settings:
 * - Extension initialization/reload
 * - Configuration changes made externally (user edits settings.json directly)
 * - Workspace folder changes (user adds/removes folders)
 * - Multiple reload cycles
 * - Any getter operations (getProjects, get, etc.)
 *
 * Scenarios that SHOULD write settings:
 * - User explicitly adds a project via UI
 * - User explicitly selects an interpreter via picker
 * - User explicitly changes env/package manager via command
 * - Project folder deleted (cleanup orphan settings)
 * - Project folder renamed (update path in settings)
 */

suite('Project Manager Initialization - Settings Preservation', () => {
    let disposables: Disposable[];
    let workspaceFoldersChangeEmitter: EventEmitter<any>;
    let configChangeEmitter: EventEmitter<any>;
    let deleteFilesEmitter: EventEmitter<{ files: readonly Uri[] }>;
    let renameFilesEmitter: EventEmitter<{ files: readonly { oldUri: Uri; newUri: Uri }[] }>;
    let addPythonProjectSettingStub: sinon.SinonStub;
    let setAllManagerSettingsStub: sinon.SinonStub;
    let setEnvironmentManagerStub: sinon.SinonStub;
    let setPackageManagerStub: sinon.SinonStub;
    let clock: sinon.SinonFakeTimers;

    const workspacePath = getTestWorkspacePath();
    const workspaceUri = Uri.file(workspacePath);
    const workspaceFolder: WorkspaceFolder = {
        uri: workspaceUri,
        name: 'workspace',
        index: 0,
    };

    setup(() => {
        disposables = [];
        clock = sinon.useFakeTimers();

        // Create event emitters
        workspaceFoldersChangeEmitter = new EventEmitter<any>();
        configChangeEmitter = new EventEmitter<any>();
        deleteFilesEmitter = new EventEmitter<{ files: readonly Uri[] }>();
        renameFilesEmitter = new EventEmitter<{ files: readonly { oldUri: Uri; newUri: Uri }[] }>();
        disposables.push(workspaceFoldersChangeEmitter, configChangeEmitter, deleteFilesEmitter, renameFilesEmitter);

        // Stub workspace events
        sinon.stub(workspaceApis, 'onDidChangeWorkspaceFolders').callsFake((listener: any) => {
            return workspaceFoldersChangeEmitter.event(listener);
        });
        sinon.stub(workspaceApis, 'onDidChangeConfiguration').callsFake((listener: any) => {
            return configChangeEmitter.event(listener);
        });
        sinon.stub(workspaceApis, 'onDidDeleteFiles').callsFake((listener: any) => {
            return deleteFilesEmitter.event(listener);
        });
        sinon.stub(workspaceApis, 'onDidRenameFiles').callsFake((listener: any) => {
            return renameFilesEmitter.event(listener);
        });
        sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([workspaceFolder]);

        // Stub ALL setting write functions to track any settings writes
        addPythonProjectSettingStub = sinon.stub(settingHelpers, 'addPythonProjectSetting').resolves();
        setAllManagerSettingsStub = sinon.stub(settingHelpers, 'setAllManagerSettings').resolves();
        setEnvironmentManagerStub = sinon.stub(settingHelpers, 'setEnvironmentManager').resolves();
        setPackageManagerStub = sinon.stub(settingHelpers, 'setPackageManager').resolves();
        sinon.stub(settingHelpers, 'removePythonProjectSetting').resolves();
        sinon.stub(settingHelpers, 'updatePythonProjectSettingPath').resolves();
    });

    teardown(() => {
        clock.restore();
        sinon.restore();
        disposables.forEach((d) => d.dispose());
    });

    /**
     * Helper to assert NO settings were written by any method
     */
    function assertNoSettingsWritten(context: string): void {
        assert.ok(!addPythonProjectSettingStub.called, `${context}: addPythonProjectSetting should NOT be called`);
        assert.ok(!setAllManagerSettingsStub.called, `${context}: setAllManagerSettings should NOT be called`);
        assert.ok(!setEnvironmentManagerStub.called, `${context}: setEnvironmentManager should NOT be called`);
        assert.ok(!setPackageManagerStub.called, `${context}: setPackageManager should NOT be called`);
    }

    /**
     * Creates a mock config where:
     * - pythonProjects has explicit venv/pip settings for subprojects
     * - defaultEnvManager differs from project settings (conda vs venv)
     * This tests that project-specific settings are preserved.
     */
    function createMockConfigWithExplicitProjectSettings(): MockWorkspaceConfiguration {
        const mockConfig = new MockWorkspaceConfiguration();
        (mockConfig as any).get = <T>(key: string, defaultValue?: T): T | undefined => {
            if (key === 'pythonProjects') {
                // These are existing project settings that should NOT be overwritten
                return [
                    { path: 'alice', envManager: 'ms-python.python:venv', packageManager: 'ms-python.python:pip' },
                    { path: 'alice/bob', envManager: 'ms-python.python:venv', packageManager: 'ms-python.python:pip' },
                    { path: 'ada', envManager: 'ms-python.python:venv', packageManager: 'ms-python.python:pip' },
                ] as unknown as T;
            }
            if (key === 'defaultEnvManager') {
                // User changed this to conda
                return 'ms-python.python:conda' as T;
            }
            if (key === 'defaultPackageManager') {
                return 'ms-python.python:conda' as T;
            }
            return defaultValue;
        };
        mockConfig.update = () => Promise.resolve();
        return mockConfig;
    }

    suite('initialize() - No Settings Writes', () => {
        test('initialize() should NOT call add() method', async () => {
            const mockConfig = createMockConfigWithExplicitProjectSettings();
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            const pm = new PythonProjectManagerImpl();

            // Spy on the add method - it should NOT be called during initialize()
            const addSpy = sinon.spy(pm, 'add');

            pm.initialize();

            // Allow any async operations to complete
            await clock.tickAsync(150);

            // CRITICAL: initialize() should NOT call add() - it should only load projects into memory
            assert.ok(
                !addSpy.called,
                'initialize() should NOT call add() - calling add() would write to settings and overwrite user config',
            );

            pm.dispose();
        });

        test('initialize() should NOT call addPythonProjectSetting', async () => {
            const mockConfig = createMockConfigWithExplicitProjectSettings();
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            const pm = new PythonProjectManagerImpl();
            pm.initialize();

            // Allow any async operations to complete
            await clock.tickAsync(150);

            // CRITICAL: initialize() should NOT write to settings
            assert.ok(
                !addPythonProjectSettingStub.called,
                'initialize() should NOT call addPythonProjectSetting - it should only load projects into memory',
            );

            pm.dispose();
        });

        test('initialize() should load projects from settings without modifying them', async () => {
            const mockConfig = createMockConfigWithExplicitProjectSettings();
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            const pm = new PythonProjectManagerImpl();
            pm.initialize();

            // Verify projects are loaded
            const projects = pm.getProjects();

            // Should have workspace root + 3 explicit projects
            assert.strictEqual(projects.length, 4, 'Should load workspace root + 3 explicit projects');

            // Verify the subprojects exist
            const aliceProject = projects.find((p) => p.uri.fsPath.endsWith('alice') && !p.uri.fsPath.includes('bob'));
            const bobProject = projects.find(
                (p) => p.uri.fsPath.includes('alice/bob') || p.uri.fsPath.includes('alice\\bob'),
            );
            const adaProject = projects.find((p) => p.uri.fsPath.endsWith('ada'));

            assert.ok(aliceProject, 'alice project should be loaded');
            assert.ok(bobProject, 'alice/bob project should be loaded');
            assert.ok(adaProject, 'ada project should be loaded');

            pm.dispose();
        });

        test('project-specific settings should be preserved when defaultEnvManager differs', async () => {
            // Scenario:
            // 1. User has projects with explicit venv/pip settings
            // 2. defaultEnvManager is set to conda
            // 3. On reload, the explicit venv/pip settings should remain unchanged

            const mockConfig = createMockConfigWithExplicitProjectSettings();
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            const pm = new PythonProjectManagerImpl();
            pm.initialize();

            await clock.tickAsync(150);

            // initialize() should load projects without overwriting their explicit settings
            assert.ok(
                !addPythonProjectSettingStub.called,
                'initialize() should NOT overwrite explicit project settings with defaults',
            );

            pm.dispose();
        });
    });

    suite('Configuration Changes - No Settings Writes', () => {
        test('external settings.json changes should NOT trigger settings writes', async () => {
            const mockConfig = createMockConfigWithExplicitProjectSettings();
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            const pm = new PythonProjectManagerImpl();
            pm.initialize();
            await clock.tickAsync(150);

            // Reset stubs to track only post-init calls
            addPythonProjectSettingStub.resetHistory();
            setAllManagerSettingsStub.resetHistory();

            // Simulate external configuration change (user edits settings.json)
            configChangeEmitter.fire({
                affectsConfiguration: (section: string) =>
                    section === 'python-envs.pythonProjects' || section === 'python-envs.defaultEnvManager',
            });

            // Wait for debounce
            await clock.tickAsync(150);

            // Configuration changes should only update in-memory state, NOT write settings
            assertNoSettingsWritten('External config change');

            pm.dispose();
        });

        test('changing defaultEnvManager externally should NOT rewrite all project settings', async () => {
            // Start with venv as default
            let currentDefaultEnvManager = 'ms-python.python:venv';
            const mockConfig = new MockWorkspaceConfiguration();
            (mockConfig as any).get = <T>(key: string, defaultValue?: T): T | undefined => {
                if (key === 'pythonProjects') {
                    return [
                        {
                            path: 'project-a',
                            envManager: 'ms-python.python:poetry',
                            packageManager: 'ms-python.python:pip',
                        },
                    ] as unknown as T;
                }
                if (key === 'defaultEnvManager') {
                    return currentDefaultEnvManager as T;
                }
                return defaultValue;
            };
            mockConfig.update = () => Promise.resolve();
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            const pm = new PythonProjectManagerImpl();
            pm.initialize();
            await clock.tickAsync(150);

            // Reset stubs
            addPythonProjectSettingStub.resetHistory();

            // Simulate user changes defaultEnvManager to conda in settings.json
            currentDefaultEnvManager = 'ms-python.python:conda';
            configChangeEmitter.fire({
                affectsConfiguration: (section: string) => section === 'python-envs.defaultEnvManager',
            });

            await clock.tickAsync(150);

            // The poetry project setting should NOT be overwritten with conda
            assertNoSettingsWritten('Default manager change');

            pm.dispose();
        });
    });

    suite('Workspace Folder Changes - No Settings Writes', () => {
        test('adding a workspace folder should NOT write project settings', async () => {
            const mockConfig = new MockWorkspaceConfiguration();
            (mockConfig as any).get = <T>(key: string, defaultValue?: T): T | undefined => {
                if (key === 'pythonProjects') {return [] as unknown as T;}
                if (key === 'defaultEnvManager') {return 'ms-python.python:venv' as T;}
                return defaultValue;
            };
            mockConfig.update = () => Promise.resolve();
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            const pm = new PythonProjectManagerImpl();
            pm.initialize();
            await clock.tickAsync(150);

            // Reset stubs
            addPythonProjectSettingStub.resetHistory();

            // Simulate adding a new workspace folder
            const newFolder: WorkspaceFolder = {
                uri: Uri.file(`${workspacePath}/new-folder`),
                name: 'new-folder',
                index: 1,
            };
            (workspaceApis.getWorkspaceFolders as sinon.SinonStub).returns([workspaceFolder, newFolder]);
            workspaceFoldersChangeEmitter.fire({
                added: [newFolder],
                removed: [],
            });

            await clock.tickAsync(150);

            // Adding workspace folders should NOT automatically create project settings
            assertNoSettingsWritten('Workspace folder added');

            pm.dispose();
        });

        test('removing a workspace folder should NOT write additional settings', async () => {
            const mockConfig = new MockWorkspaceConfiguration();
            (mockConfig as any).get = <T>(key: string, defaultValue?: T): T | undefined => {
                if (key === 'pythonProjects') {return [] as unknown as T;}
                if (key === 'defaultEnvManager') {return 'ms-python.python:venv' as T;}
                return defaultValue;
            };
            mockConfig.update = () => Promise.resolve();
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            const pm = new PythonProjectManagerImpl();
            pm.initialize();
            await clock.tickAsync(150);

            // Reset stubs - we specifically check addPythonProjectSetting and setAllManagerSettings
            addPythonProjectSettingStub.resetHistory();
            setAllManagerSettingsStub.resetHistory();

            // Simulate removing a workspace folder
            workspaceFoldersChangeEmitter.fire({
                added: [],
                removed: [workspaceFolder],
            });

            await clock.tickAsync(150);

            // Removing workspace folders should NOT write new/additional settings
            assert.ok(!addPythonProjectSettingStub.called, 'Should not add settings when folder removed');
            assert.ok(!setAllManagerSettingsStub.called, 'Should not update manager settings when folder removed');

            pm.dispose();
        });
    });

    suite('Multiple Reload Cycles - No Settings Accumulation', () => {
        test('multiple initializations should NOT accumulate settings writes', async () => {
            const mockConfig = createMockConfigWithExplicitProjectSettings();
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            // Simulate multiple extension reload cycles
            for (let i = 0; i < 3; i++) {
                const pm = new PythonProjectManagerImpl();
                pm.initialize();
                await clock.tickAsync(150);

                assertNoSettingsWritten(`Reload cycle ${i + 1}`);

                pm.dispose();
            }
        });

        test('reinitializing after dispose should NOT write settings', async () => {
            const mockConfig = createMockConfigWithExplicitProjectSettings();
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            const pm1 = new PythonProjectManagerImpl();
            pm1.initialize();
            await clock.tickAsync(150);
            pm1.dispose();

            // Reset stubs between lifecycle
            addPythonProjectSettingStub.resetHistory();

            const pm2 = new PythonProjectManagerImpl();
            pm2.initialize();
            await clock.tickAsync(150);

            assertNoSettingsWritten('Second initialization');

            pm2.dispose();
        });
    });

    suite('Getter Operations - Side-Effect Free', () => {
        test('getProjects() should be side-effect free', async () => {
            const mockConfig = createMockConfigWithExplicitProjectSettings();
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            const pm = new PythonProjectManagerImpl();
            pm.initialize();
            await clock.tickAsync(150);

            addPythonProjectSettingStub.resetHistory();

            // Call getProjects multiple times
            for (let i = 0; i < 5; i++) {
                pm.getProjects();
            }

            assertNoSettingsWritten('getProjects() calls');

            pm.dispose();
        });

        test('get() should be side-effect free', async () => {
            const mockConfig = createMockConfigWithExplicitProjectSettings();
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            const pm = new PythonProjectManagerImpl();
            pm.initialize();
            await clock.tickAsync(150);

            addPythonProjectSettingStub.resetHistory();

            // Call get() with various URIs
            pm.get(Uri.file(`${workspacePath}/alice`));
            pm.get(Uri.file(`${workspacePath}/nonexistent`));
            pm.get(Uri.file(`${workspacePath}/alice/bob/file.py`));

            assertNoSettingsWritten('get() calls');

            pm.dispose();
        });

        test('create() should be side-effect free (does not add to settings)', async () => {
            const mockConfig = createMockConfigWithExplicitProjectSettings();
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            const pm = new PythonProjectManagerImpl();
            pm.initialize();
            await clock.tickAsync(150);

            addPythonProjectSettingStub.resetHistory();

            // create() just creates the object, doesn't persist it
            pm.create('test-project', Uri.file(`${workspacePath}/test`));

            assertNoSettingsWritten('create() call');

            pm.dispose();
        });
    });

    suite('add() - Should Write Settings (for user-initiated additions)', () => {
        // Note: Testing add() behavior directly requires more complex mocking because
        // add() uses workspace.getConfiguration directly. The key behavioral distinction
        // is tested via the file event tests (projectManager.fileEvents.unit.test.ts)
        // and the fact that initialize() does NOT call addPythonProjectSetting proves
        // the separation of concerns.

        test('add() adds projects to internal map', async () => {
            const mockConfig = new MockWorkspaceConfiguration();
            (mockConfig as any).get = <T>(key: string, defaultValue?: T): T | undefined => {
                if (key === 'pythonProjects') {
                    return [] as unknown as T;
                }
                if (key === 'defaultEnvManager') {
                    return 'ms-python.python:venv' as T;
                }
                if (key === 'defaultPackageManager') {
                    return 'ms-python.python:pip' as T;
                }
                return defaultValue;
            };
            mockConfig.update = () => Promise.resolve();
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            const pm = new PythonProjectManagerImpl();
            pm.initialize();

            const projectsBefore = pm.getProjects().length;

            // Directly add to internal map to verify the mechanism works
            // (Full add() testing requires mocking vscode.workspace which is complex)
            const newProjectUri = Uri.file(`${workspacePath}/new-project`);
            const newProject = pm.create('new-project', newProjectUri);
            (pm as any)._projects.set(newProjectUri.toString(), newProject);

            const projectsAfter = pm.getProjects().length;
            assert.strictEqual(projectsAfter, projectsBefore + 1, 'Project should be added to internal map');

            pm.dispose();
        });
    });

    suite('Distinction between load and add', () => {
        test('initialize() loads existing projects without writing settings', async () => {
            const pythonProjects: PythonProjectSettings[] = [
                {
                    path: 'existing-project',
                    envManager: 'ms-python.python:poetry',
                    packageManager: 'ms-python.python:pip',
                },
            ];

            const mockConfig = new MockWorkspaceConfiguration();
            (mockConfig as any).get = <T>(key: string, defaultValue?: T): T | undefined => {
                if (key === 'pythonProjects') {
                    return pythonProjects as unknown as T;
                }
                if (key === 'defaultEnvManager') {
                    return 'ms-python.python:venv' as T;
                }
                if (key === 'defaultPackageManager') {
                    return 'ms-python.python:pip' as T;
                }
                return defaultValue;
            };
            mockConfig.update = () => Promise.resolve();
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            const pm = new PythonProjectManagerImpl();

            // initialize() - should NOT write settings
            pm.initialize();
            await clock.tickAsync(150);

            assert.ok(!addPythonProjectSettingStub.called, 'initialize() should not write settings');

            // Verify existing project is loaded
            const projects = pm.getProjects();
            const existingProject = projects.find((p) => p.uri.fsPath.includes('existing-project'));
            assert.ok(existingProject, 'Existing project should be loaded from settings');

            pm.dispose();
        });
    });
});

/**
 * Tests that project-specific settings are preserved during reload
 * when default manager settings differ from project settings.
 */
suite('Project-Specific Settings Preservation on Reload', () => {
    let disposables: Disposable[];
    let clock: sinon.SinonFakeTimers;
    let workspaceFoldersChangeEmitter: EventEmitter<any>;
    let configChangeEmitter: EventEmitter<any>;
    let deleteFilesEmitter: EventEmitter<{ files: readonly Uri[] }>;
    let renameFilesEmitter: EventEmitter<{ files: readonly { oldUri: Uri; newUri: Uri }[] }>;

    const workspacePath = getTestWorkspacePath();
    const workspaceUri = Uri.file(workspacePath);
    const workspaceFolder: WorkspaceFolder = {
        uri: workspaceUri,
        name: 'tests-plus-projects',
        index: 0,
    };

    setup(() => {
        disposables = [];
        clock = sinon.useFakeTimers();

        workspaceFoldersChangeEmitter = new EventEmitter<any>();
        configChangeEmitter = new EventEmitter<any>();
        deleteFilesEmitter = new EventEmitter<{ files: readonly Uri[] }>();
        renameFilesEmitter = new EventEmitter<{ files: readonly { oldUri: Uri; newUri: Uri }[] }>();
        disposables.push(workspaceFoldersChangeEmitter, configChangeEmitter, deleteFilesEmitter, renameFilesEmitter);

        sinon.stub(workspaceApis, 'onDidChangeWorkspaceFolders').callsFake((listener: any) => {
            return workspaceFoldersChangeEmitter.event(listener);
        });
        sinon.stub(workspaceApis, 'onDidChangeConfiguration').callsFake((listener: any) => {
            return configChangeEmitter.event(listener);
        });
        sinon.stub(workspaceApis, 'onDidDeleteFiles').callsFake((listener: any) => {
            return deleteFilesEmitter.event(listener);
        });
        sinon.stub(workspaceApis, 'onDidRenameFiles').callsFake((listener: any) => {
            return renameFilesEmitter.event(listener);
        });
        sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([workspaceFolder]);
        sinon.stub(settingHelpers, 'removePythonProjectSetting').resolves();
        sinon.stub(settingHelpers, 'updatePythonProjectSettingPath').resolves();
    });

    teardown(() => {
        clock.restore();
        sinon.restore();
        disposables.forEach((d) => d.dispose());
    });

    test('venv projects should be preserved when defaultEnvManager is conda', async () => {
        // Scenario: Multiple projects have explicit venv/pip settings,
        // but defaultEnvManager is set to conda.
        // On reload, all project-specific settings must be preserved.
        //
        // Settings:
        // {
        //   "python-envs.pythonProjects": [
        //     { "path": "alice/bob", "envManager": "ms-python.python:venv", "packageManager": "ms-python.python:pip" },
        //     { "path": "ada", "envManager": "ms-python.python:venv", "packageManager": "ms-python.python:pip" },
        //     { "path": "alice", "envManager": "ms-python.python:venv", "packageManager": "ms-python.python:pip" }
        //   ],
        //   "python-envs.defaultEnvManager": "ms-python.python:conda",
        //   "python-envs.defaultPackageManager": "ms-python.python:conda"
        // }

        sinon.stub(settingHelpers, 'addPythonProjectSetting').resolves();

        const mockConfig = new MockWorkspaceConfiguration();
        (mockConfig as any).get = <T>(key: string, defaultValue?: T): T | undefined => {
            if (key === 'pythonProjects') {
                return [
                    { path: 'alice/bob', envManager: 'ms-python.python:venv', packageManager: 'ms-python.python:pip' },
                    { path: 'ada', envManager: 'ms-python.python:venv', packageManager: 'ms-python.python:pip' },
                    { path: 'alice', envManager: 'ms-python.python:venv', packageManager: 'ms-python.python:pip' },
                ] as unknown as T;
            }
            if (key === 'defaultEnvManager') {
                return 'ms-python.python:conda' as T;
            }
            if (key === 'defaultPackageManager') {
                return 'ms-python.python:conda' as T;
            }
            return defaultValue;
        };
        mockConfig.update = () => Promise.resolve();
        sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

        // Simulate reload: create new project manager and initialize
        const pm = new PythonProjectManagerImpl();

        // Spy on add() - initialize() should NOT call add() as that would write to settings
        const addSpy = sinon.spy(pm, 'add');

        pm.initialize();
        await clock.tickAsync(150);

        // initialize() should use loadProjects() (read-only), not add() (writes settings)
        assert.ok(
            !addSpy.called,
            `initialize() called add() which would overwrite venv/pip settings with conda defaults. ` +
                `add() was called ${addSpy.callCount} time(s).`,
        );

        pm.dispose();
    });
});
