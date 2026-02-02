/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from 'assert';
import * as sinon from 'sinon';
import { ConfigurationTarget, Disposable, EventEmitter, Uri, WorkspaceFolder } from 'vscode';
import * as workspaceApis from '../../common/workspace.apis';
import { PythonProjectManagerImpl } from '../../features/projectManager';
import * as settingHelpers from '../../features/settings/settingHelpers';
import { PythonProjectsImpl } from '../../internal.api';
import { MockWorkspaceConfiguration } from '../mocks/mockWorkspaceConfig';

/**
 * Tests for project manager file event handling (delete/rename).
 *
 * Testing strategy:
 * - These tests verify the INTEGRATION between file events and the project manager
 * - We mock settingHelpers to verify the correct helper is called with correct args
 * - The actual settingHelpers implementation is tested separately in the
 *   'updatePythonProjectSettingPath' suite below
 * - We use fake timers to avoid flaky setTimeout-based waits for debounce
 */
suite('Project Manager File Event Handling', () => {
    let disposables: Disposable[] = [];
    let deleteFilesEmitter: EventEmitter<{ files: readonly Uri[] }>;
    let renameFilesEmitter: EventEmitter<{ files: readonly { oldUri: Uri; newUri: Uri }[] }>;
    let workspaceFoldersChangeEmitter: EventEmitter<any>;
    let configChangeEmitter: EventEmitter<any>;
    let removePythonProjectSettingStub: sinon.SinonStub;
    let updatePythonProjectSettingPathStub: sinon.SinonStub;
    let clock: sinon.SinonFakeTimers;

    const workspaceUri = Uri.file('/workspace');
    const workspaceFolder: WorkspaceFolder = {
        uri: workspaceUri,
        name: 'workspace',
        index: 0,
    };

    setup(() => {
        // Use fake timers to avoid flaky setTimeout-based waits
        clock = sinon.useFakeTimers();

        // Create event emitters for file system events
        deleteFilesEmitter = new EventEmitter<{ files: readonly Uri[] }>();
        renameFilesEmitter = new EventEmitter<{ files: readonly { oldUri: Uri; newUri: Uri }[] }>();
        workspaceFoldersChangeEmitter = new EventEmitter<any>();
        configChangeEmitter = new EventEmitter<any>();
        disposables.push(deleteFilesEmitter, renameFilesEmitter, workspaceFoldersChangeEmitter, configChangeEmitter);

        // Stub workspace APIs
        sinon.stub(workspaceApis, 'onDidDeleteFiles').callsFake((listener: any) => {
            return deleteFilesEmitter.event(listener);
        });
        sinon.stub(workspaceApis, 'onDidRenameFiles').callsFake((listener: any) => {
            return renameFilesEmitter.event(listener);
        });
        sinon.stub(workspaceApis, 'onDidChangeWorkspaceFolders').callsFake((listener: any) => {
            return workspaceFoldersChangeEmitter.event(listener);
        });
        sinon.stub(workspaceApis, 'onDidChangeConfiguration').callsFake((listener: any) => {
            return configChangeEmitter.event(listener);
        });
        sinon.stub(workspaceApis, 'getWorkspaceFolders').callsFake(() => [workspaceFolder]);

        // Mock configuration
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

        // Stub setting helpers
        removePythonProjectSettingStub = sinon.stub(settingHelpers, 'removePythonProjectSetting').resolves();
        updatePythonProjectSettingPathStub = sinon.stub(settingHelpers, 'updatePythonProjectSettingPath').resolves();
        sinon.stub(settingHelpers, 'addPythonProjectSetting').resolves();
    });

    teardown(() => {
        sinon.restore();
        disposables.forEach((d) => d.dispose());
        disposables = [];
    });

    /**
     * Helper to directly add a project to the manager's internal map for testing.
     * This bypasses the `add()` method which has side effects (writes to settings).
     *
     * Trade-off: We test internal state rather than public API, but this keeps tests
     * focused on the file event handling behavior without needing to mock the full
     * settings write path that `add()` triggers.
     */
    function addProjectDirectly(pm: PythonProjectManagerImpl, name: string, uri: Uri): void {
        const project = new PythonProjectsImpl(name, uri);
        (pm as any)._projects.set(uri.toString(), project);
    }

    suite('handleDeletedFiles', () => {
        test('should remove project and update settings when project folder is deleted', async () => {
            const projectUri = Uri.file('/workspace/my-project');
            const pm = new PythonProjectManagerImpl();
            pm.initialize();

            // Directly add a project to the internal map
            addProjectDirectly(pm, 'my-project', projectUri);

            // Verify project exists
            assert.ok(pm.get(projectUri), 'Project should exist before deletion');

            // Track onDidChangeProjects events for UI refresh verification
            let changeEventFired = false;
            let projectsAfterEvent: readonly any[] = [];
            const changeListener = pm.onDidChangeProjects((projects) => {
                changeEventFired = true;
                projectsAfterEvent = projects ?? [];
            });

            // Fire delete event
            deleteFilesEmitter.fire({ files: [projectUri] });

            // Allow async operations to complete
            await clock.tickAsync(150);

            // Verify onDidChangeProjects was fired (triggers UI refresh)
            assert.ok(changeEventFired, 'onDidChangeProjects should be fired to trigger UI refresh');

            // Verify the deleted project is not in the event payload
            const deletedInEvent = projectsAfterEvent.find((p) => p.uri.toString() === projectUri.toString());
            assert.strictEqual(deletedInEvent, undefined, 'Deleted project should not be in change event');

            // Verify project is removed from getProjects()
            const projectsAfter = pm.getProjects();
            const deletedProject = projectsAfter.find((p) => p.uri.toString() === projectUri.toString());
            assert.strictEqual(deletedProject, undefined, 'Project should be removed after folder deletion');

            // Verify settings were updated
            assert.ok(removePythonProjectSettingStub.called, 'removePythonProjectSetting should be called');

            changeListener.dispose();
            pm.dispose();
        });

        test('should not remove workspace root folder on delete (handled by onDidChangeWorkspaceFolders)', async () => {
            const pm = new PythonProjectManagerImpl();
            pm.initialize();

            // Manually add the workspace root to simulate initialization
            // (Full initialization requires more complex mocking of vscode.workspace)
            addProjectDirectly(pm, 'workspace', workspaceUri);

            // Verify workspace root exists
            const workspaceRootProject = pm.get(workspaceUri);
            assert.ok(workspaceRootProject, 'Workspace root should be a project');

            // Fire delete event for workspace root
            deleteFilesEmitter.fire({ files: [workspaceUri] });

            // Allow async operations to complete
            await clock.tickAsync(150);

            // Settings should NOT be updated for workspace root (it's handled by onDidChangeWorkspaceFolders)
            assert.ok(
                !removePythonProjectSettingStub.called,
                'removePythonProjectSetting should not be called for workspace root',
            );

            pm.dispose();
        });

        test('should not affect untracked folders', async () => {
            const untrackedUri = Uri.file('/workspace/not-a-project');
            const pm = new PythonProjectManagerImpl();
            pm.initialize();

            const projectsBefore = pm.getProjects();

            // Fire delete event for untracked folder
            deleteFilesEmitter.fire({ files: [untrackedUri] });

            // Allow async operations to complete
            await clock.tickAsync(150);

            const projectsAfter = pm.getProjects();
            assert.strictEqual(projectsAfter.length, projectsBefore.length, 'Projects should remain unchanged');
            assert.ok(!removePythonProjectSettingStub.called, 'removePythonProjectSetting should not be called');

            pm.dispose();
        });
    });

    suite('handleRenamedFiles', () => {
        test('should update project path in settings when project folder is renamed', async () => {
            const oldUri = Uri.file('/workspace/old-name');
            const newUri = Uri.file('/workspace/new-name');
            const pm = new PythonProjectManagerImpl();
            pm.initialize();

            // Directly add a project to the internal map
            addProjectDirectly(pm, 'old-name', oldUri);

            // Track onDidChangeProjects events for UI refresh verification
            let changeEventFired = false;
            const changeListener = pm.onDidChangeProjects(() => {
                changeEventFired = true;
            });

            // Fire rename event
            renameFilesEmitter.fire({ files: [{ oldUri, newUri }] });

            // Allow async operations to complete (debounce is 100ms)
            await clock.tickAsync(150);

            // Verify settings path update was called
            assert.ok(updatePythonProjectSettingPathStub.called, 'updatePythonProjectSettingPath should be called');
            assert.ok(
                updatePythonProjectSettingPathStub.calledWith(oldUri, newUri),
                'updatePythonProjectSettingPath should be called with correct URIs',
            );

            // Verify onDidChangeProjects was fired (triggers UI refresh via updateDebounce)
            assert.ok(changeEventFired, 'onDidChangeProjects should be fired to trigger UI refresh');

            changeListener.dispose();
            pm.dispose();
        });

        test('should not update settings for workspace root folder rename', async () => {
            const pm = new PythonProjectManagerImpl();
            pm.initialize();

            const newUri = Uri.file('/new-workspace');

            // Fire rename event for workspace root
            renameFilesEmitter.fire({ files: [{ oldUri: workspaceUri, newUri }] });

            // Allow async operations to complete
            await clock.tickAsync(150);

            // Settings should NOT be updated for workspace root
            assert.ok(
                !updatePythonProjectSettingPathStub.called,
                'updatePythonProjectSettingPath should not be called for workspace root',
            );

            pm.dispose();
        });

        test('should not affect untracked folder renames', async () => {
            const oldUri = Uri.file('/workspace/untracked');
            const newUri = Uri.file('/workspace/untracked-renamed');
            const pm = new PythonProjectManagerImpl();
            pm.initialize();

            // Fire rename event for untracked folder
            renameFilesEmitter.fire({ files: [{ oldUri, newUri }] });

            // Allow async operations to complete
            await clock.tickAsync(150);

            assert.ok(
                !updatePythonProjectSettingPathStub.called,
                'updatePythonProjectSettingPath should not be called',
            );

            pm.dispose();
        });
    });
});

suite('updatePythonProjectSettingPath', () => {
    let updateCalls: Array<{ key: string; value: unknown; target: ConfigurationTarget }>;

    setup(() => {
        updateCalls = [];
    });

    teardown(() => {
        sinon.restore();
    });

    test('should update project path in pythonProjects setting', async () => {
        const workspaceUri = Uri.file('/workspace');
        const workspaceFolder: WorkspaceFolder = {
            uri: workspaceUri,
            name: 'workspace',
            index: 0,
        };

        sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([workspaceFolder]);

        const mockConfig = new MockWorkspaceConfiguration();
        (mockConfig as any).get = <T>(key: string): T | undefined => {
            if (key === 'pythonProjects') {
                return [
                    {
                        path: 'old-project',
                        envManager: 'ms-python.python:venv',
                        packageManager: 'ms-python.python:pip',
                    },
                ] as unknown as T;
            }
            return undefined;
        };
        mockConfig.update = (section: string, value: unknown, target?: boolean | ConfigurationTarget) => {
            updateCalls.push({ key: section, value, target: target as ConfigurationTarget });
            return Promise.resolve();
        };
        sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

        const oldUri = Uri.file('/workspace/old-project');
        const newUri = Uri.file('/workspace/new-project');

        await settingHelpers.updatePythonProjectSettingPath(oldUri, newUri);

        assert.strictEqual(updateCalls.length, 1, 'Should have one update call');
        assert.strictEqual(updateCalls[0].key, 'pythonProjects');
        const updatedProjects = updateCalls[0].value as Array<{ path: string }>;
        assert.strictEqual(updatedProjects[0].path, 'new-project', 'Path should be updated to new-project');
    });

    test('should not update if project not found in settings', async () => {
        const workspaceUri = Uri.file('/workspace');
        const workspaceFolder: WorkspaceFolder = {
            uri: workspaceUri,
            name: 'workspace',
            index: 0,
        };

        sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([workspaceFolder]);

        const mockConfig = new MockWorkspaceConfiguration();
        (mockConfig as any).get = <T>(key: string): T | undefined => {
            if (key === 'pythonProjects') {
                return [
                    {
                        path: 'other-project',
                        envManager: 'ms-python.python:venv',
                        packageManager: 'ms-python.python:pip',
                    },
                ] as unknown as T;
            }
            return undefined;
        };
        mockConfig.update = (section: string, value: unknown, target?: boolean | ConfigurationTarget) => {
            updateCalls.push({ key: section, value, target: target as ConfigurationTarget });
            return Promise.resolve();
        };
        sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

        const oldUri = Uri.file('/workspace/non-existent');
        const newUri = Uri.file('/workspace/renamed');

        await settingHelpers.updatePythonProjectSettingPath(oldUri, newUri);

        assert.strictEqual(updateCalls.length, 0, 'Should not update settings when project not found');
    });

    test('should preserve envManager and packageManager when updating path', async () => {
        const workspaceUri = Uri.file('/workspace');
        const workspaceFolder: WorkspaceFolder = {
            uri: workspaceUri,
            name: 'workspace',
            index: 0,
        };

        sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([workspaceFolder]);

        const mockConfig = new MockWorkspaceConfiguration();
        (mockConfig as any).get = <T>(key: string): T | undefined => {
            if (key === 'pythonProjects') {
                return [
                    {
                        path: 'pyenv-project',
                        envManager: 'ms-python.python:pyenv',
                        packageManager: 'ms-python.python:conda',
                    },
                ] as unknown as T;
            }
            return undefined;
        };
        mockConfig.update = (section: string, value: unknown, target?: boolean | ConfigurationTarget) => {
            updateCalls.push({ key: section, value, target: target as ConfigurationTarget });
            return Promise.resolve();
        };
        sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

        const oldUri = Uri.file('/workspace/pyenv-project');
        const newUri = Uri.file('/workspace/pyenv-project-renamed');

        await settingHelpers.updatePythonProjectSettingPath(oldUri, newUri);

        assert.strictEqual(updateCalls.length, 1, 'Should have one update call');
        const updatedProjects = updateCalls[0].value as Array<{
            path: string;
            envManager: string;
            packageManager: string;
        }>;
        assert.strictEqual(updatedProjects[0].path, 'pyenv-project-renamed', 'Path should be updated');
        assert.strictEqual(
            updatedProjects[0].envManager,
            'ms-python.python:pyenv',
            'envManager should be preserved (not reset to default)',
        );
        assert.strictEqual(
            updatedProjects[0].packageManager,
            'ms-python.python:conda',
            'packageManager should be preserved (not reset to default)',
        );
    });
});
