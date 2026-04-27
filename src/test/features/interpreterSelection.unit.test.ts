// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { ConfigurationChangeEvent, Uri, WorkspaceConfiguration, WorkspaceFolder } from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi, PythonProject, SetEnvironmentScope } from '../../api';
import * as windowApis from '../../common/window.apis';
import * as workspaceApis from '../../common/workspace.apis';
import {
    applyInitialEnvironmentSelection,
    registerInterpreterSettingsChangeListener,
    resetSettingWarnings,
    resolveEnvironmentByPriority,
    resolveGlobalEnvironmentByPriority,
} from '../../features/interpreterSelection';
import * as helpers from '../../helpers';
import { EnvironmentManagers, InternalEnvironmentManager, PythonProjectManager } from '../../internal.api';
import { NativePythonFinder } from '../../managers/common/nativePythonFinder';

/**
 * Creates a mock WorkspaceConfiguration for testing.
 */
function createMockConfig(pythonProjects: unknown[] = []): Partial<WorkspaceConfiguration> {
    return {
        get: (key: string) => {
            if (key === 'pythonProjects') {
                return pythonProjects;
            }
            return undefined;
        },
    };
}

suite('Interpreter Selection - Priority Chain', () => {
    let sandbox: sinon.SinonSandbox;
    let mockEnvManagers: sinon.SinonStubbedInstance<EnvironmentManagers>;
    let mockProjectManager: sinon.SinonStubbedInstance<PythonProjectManager>;
    let mockNativeFinder: sinon.SinonStubbedInstance<NativePythonFinder>;
    let mockApi: sinon.SinonStubbedInstance<PythonEnvironmentApi>;
    let mockVenvManager: sinon.SinonStubbedInstance<InternalEnvironmentManager>;
    let mockSystemManager: sinon.SinonStubbedInstance<InternalEnvironmentManager>;

    const testUri = Uri.file('/test/workspace');
    const mockVenvEnv: PythonEnvironment = {
        envId: { id: 'venv-env-1', managerId: 'ms-python.python:venv' },
        name: 'Test Venv',
        displayName: 'Test Venv',
        version: '3.11.0',
        displayPath: '/test/workspace/.venv',
        environmentPath: Uri.file('/test/workspace/.venv'),
        sysPrefix: '/test/workspace/.venv',
        execInfo: { run: { executable: '/test/workspace/.venv/bin/python' } },
    };
    const mockSystemEnv: PythonEnvironment = {
        envId: { id: 'system-env-1', managerId: 'ms-python.python:system' },
        name: 'System Python',
        displayName: 'System Python 3.11',
        version: '3.11.0',
        displayPath: '/usr/bin/python3.11',
        environmentPath: Uri.file('/usr/bin/python3.11'),
        sysPrefix: '/usr',
        execInfo: { run: { executable: '/usr/bin/python3.11' } },
    };

    setup(() => {
        sandbox = sinon.createSandbox();

        // Create mock managers
        mockVenvManager = {
            id: 'ms-python.python:venv',
            name: 'venv',
            displayName: 'Venv',
            get: sandbox.stub(),
            set: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<InternalEnvironmentManager>;

        mockSystemManager = {
            id: 'ms-python.python:system',
            name: 'system',
            displayName: 'System',
            get: sandbox.stub(),
            set: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<InternalEnvironmentManager>;

        mockEnvManagers = {
            getEnvironmentManager: sandbox.stub(),
            setEnvironment: sandbox.stub().resolves(),
            managers: [mockVenvManager, mockSystemManager],
        } as unknown as sinon.SinonStubbedInstance<EnvironmentManagers>;

        mockProjectManager = {
            get: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<PythonProjectManager>;

        mockNativeFinder = {
            resolve: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<NativePythonFinder>;

        mockApi = {
            resolveEnvironment: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<PythonEnvironmentApi>;

        // Default: getEnvironmentManager returns the manager for a given ID
        mockEnvManagers.getEnvironmentManager.callsFake((scope: unknown) => {
            const id = typeof scope === 'string' ? scope : undefined;
            if (id === 'ms-python.python:venv') {
                return mockVenvManager;
            }
            if (id === 'ms-python.python:system') {
                return mockSystemManager;
            }
            return undefined;
        });
    });

    teardown(() => {
        sandbox.restore();
    });

    suite('Priority 1: pythonProjects[]', () => {
        test('should use manager from pythonProjects[] when configured', async () => {
            // Setup: pythonProjects[] has a venv manager configured
            sandbox.stub(workspaceApis, 'getConfiguration').returns(
                createMockConfig([
                    {
                        path: '.',
                        envManager: 'ms-python.python:venv',
                        packageManager: 'ms-python.python:pip',
                    },
                ]) as WorkspaceConfiguration,
            );
            const mockProject: Partial<PythonProject> = { uri: testUri, name: 'test' };
            mockProjectManager.get.returns(mockProject as PythonProject);
            const mockWorkspaceFolder: Partial<WorkspaceFolder> = { uri: testUri };
            sandbox.stub(workspaceApis, 'getWorkspaceFolder').returns(mockWorkspaceFolder as WorkspaceFolder);
            sandbox.stub(helpers, 'getUserConfiguredSetting').returns(undefined);

            const result = await resolveEnvironmentByPriority(
                testUri,
                mockEnvManagers as unknown as EnvironmentManagers,
                mockProjectManager as unknown as PythonProjectManager,
                mockNativeFinder as unknown as NativePythonFinder,
                mockApi as unknown as PythonEnvironmentApi,
            );

            assert.strictEqual(result.source, 'pythonProjects');
            assert.strictEqual(result.manager.id, 'ms-python.python:venv');
        });
    });

    suite('Priority 2: User-configured defaultEnvManager', () => {
        test('should use user-configured defaultEnvManager when set', async () => {
            // Setup: No pythonProjects[], but user configured defaultEnvManager
            sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
            sandbox.stub(helpers, 'getUserConfiguredSetting').callsFake((section: string, key: string) => {
                if (section === 'python-envs' && key === 'defaultEnvManager') {
                    return 'ms-python.python:venv';
                }
                return undefined;
            });

            const result = await resolveEnvironmentByPriority(
                testUri,
                mockEnvManagers as unknown as EnvironmentManagers,
                mockProjectManager as unknown as PythonProjectManager,
                mockNativeFinder as unknown as NativePythonFinder,
                mockApi as unknown as PythonEnvironmentApi,
            );

            assert.strictEqual(result.source, 'defaultEnvManager');
            assert.strictEqual(result.manager.id, 'ms-python.python:venv');
        });

        test('should skip to Priority 3 when defaultEnvManager is not user-configured (only fallback)', async () => {
            // Setup: No pythonProjects[], no user-configured defaultEnvManager (returns undefined)
            // But there IS a user-configured defaultInterpreterPath
            sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
            sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([]);
            sandbox.stub(helpers, 'getUserConfiguredSetting').callsFake((section: string, key: string) => {
                if (section === 'python' && key === 'defaultInterpreterPath') {
                    return '/usr/bin/python3.11';
                }
                return undefined; // defaultEnvManager NOT user-configured
            });
            mockNativeFinder.resolve.resolves({ executable: '/usr/bin/python3.11', version: '3.11.0', prefix: '/usr' });
            mockApi.resolveEnvironment.resolves(mockSystemEnv);

            const result = await resolveEnvironmentByPriority(
                testUri,
                mockEnvManagers as unknown as EnvironmentManagers,
                mockProjectManager as unknown as PythonProjectManager,
                mockNativeFinder as unknown as NativePythonFinder,
                mockApi as unknown as PythonEnvironmentApi,
            );

            assert.strictEqual(result.source, 'defaultInterpreterPath');
        });
    });

    suite('Priority 3: python.defaultInterpreterPath', () => {
        test('should use defaultInterpreterPath when set and resolvable', async () => {
            sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
            sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([]);
            sandbox.stub(helpers, 'getUserConfiguredSetting').callsFake((section: string, key: string) => {
                if (section === 'python' && key === 'defaultInterpreterPath') {
                    return '/usr/bin/python3.11';
                }
                return undefined;
            });
            mockNativeFinder.resolve.resolves({ executable: '/usr/bin/python3.11', version: '3.11.0', prefix: '/usr' });
            mockApi.resolveEnvironment.resolves(mockSystemEnv);

            const result = await resolveEnvironmentByPriority(
                testUri,
                mockEnvManagers as unknown as EnvironmentManagers,
                mockProjectManager as unknown as PythonProjectManager,
                mockNativeFinder as unknown as NativePythonFinder,
                mockApi as unknown as PythonEnvironmentApi,
            );

            assert.strictEqual(result.source, 'defaultInterpreterPath');
            assert.ok(result.environment);
            assert.strictEqual(result.environment.displayPath, '/usr/bin/python3.11');
        });

        test('should resolve ${workspaceFolder} in defaultInterpreterPath before native resolution', async () => {
            const workspaceUri = Uri.file(path.resolve('/test/workspace'));
            // resolveVariables does simple string substitution, so forward slashes in the setting remain
            const expandedInterpreterPath = workspaceUri.fsPath + '/backend/.venv/bin/python';
            const workspaceFolder = { name: 'workspace', uri: workspaceUri } as WorkspaceFolder;

            sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
            sandbox.stub(workspaceApis, 'getWorkspaceFolder').returns(workspaceFolder);
            sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([workspaceFolder]);
            sandbox.stub(helpers, 'getUserConfiguredSetting').callsFake((section: string, key: string) => {
                if (section === 'python' && key === 'defaultInterpreterPath') {
                    return '${workspaceFolder}/backend/.venv/bin/python';
                }
                return undefined;
            });
            mockNativeFinder.resolve.resolves({
                executable: expandedInterpreterPath,
                version: '3.11.0',
                prefix: path.join(workspaceUri.fsPath, 'backend', '.venv'),
            });
            mockApi.resolveEnvironment.resolves({
                ...mockVenvEnv,
                displayPath: expandedInterpreterPath,
                environmentPath: Uri.file(expandedInterpreterPath),
                execInfo: { run: { executable: expandedInterpreterPath } },
            });

            const result = await resolveEnvironmentByPriority(
                workspaceUri,
                mockEnvManagers as unknown as EnvironmentManagers,
                mockProjectManager as unknown as PythonProjectManager,
                mockNativeFinder as unknown as NativePythonFinder,
                mockApi as unknown as PythonEnvironmentApi,
            );

            assert.strictEqual(result.source, 'defaultInterpreterPath');
            assert.ok(result.environment);
            assert.strictEqual(result.environment.displayPath, expandedInterpreterPath);
            assert.ok(mockNativeFinder.resolve.calledOnceWithExactly(expandedInterpreterPath));
        });

        test('should skip native resolution when defaultInterpreterPath has unresolved variables', async () => {
            // When resolveVariables can't resolve ${workspaceFolder} (e.g., global scope with no workspace),
            // the path still contains '${' and should be skipped without calling nativeFinder.resolve
            sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
            sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([]);
            sandbox.stub(workspaceApis, 'getWorkspaceFolder').returns(undefined);
            sandbox.stub(helpers, 'getUserConfiguredSetting').callsFake((section: string, key: string) => {
                if (section === 'python' && key === 'defaultInterpreterPath') {
                    return '${workspaceFolder}/.venv/bin/python3';
                }
                return undefined;
            });
            mockVenvManager.get.resolves(mockVenvEnv);

            const result = await resolveEnvironmentByPriority(
                testUri,
                mockEnvManagers as unknown as EnvironmentManagers,
                mockProjectManager as unknown as PythonProjectManager,
                mockNativeFinder as unknown as NativePythonFinder,
                mockApi as unknown as PythonEnvironmentApi,
            );

            // Should fall through to auto-discovery without calling nativeFinder.resolve
            assert.strictEqual(result.source, 'autoDiscovery');
            assert.ok(
                mockNativeFinder.resolve.notCalled,
                'nativeFinder.resolve should not be called with unresolved variables',
            );
        });

        test('should fall through to Priority 4 when defaultInterpreterPath cannot be resolved', async () => {
            sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
            sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([]);
            sandbox.stub(helpers, 'getUserConfiguredSetting').callsFake((section: string, key: string) => {
                if (section === 'python' && key === 'defaultInterpreterPath') {
                    return '/nonexistent/python';
                }
                return undefined;
            });
            mockNativeFinder.resolve.rejects(new Error('Not found'));
            mockVenvManager.get.resolves(mockVenvEnv);

            const result = await resolveEnvironmentByPriority(
                testUri,
                mockEnvManagers as unknown as EnvironmentManagers,
                mockProjectManager as unknown as PythonProjectManager,
                mockNativeFinder as unknown as NativePythonFinder,
                mockApi as unknown as PythonEnvironmentApi,
            );

            assert.strictEqual(result.source, 'autoDiscovery');
        });

        test('should use original user path even when nativeFinder resolves to a different executable', async () => {
            // This test covers the scenario where user configures a pyenv path but
            // nativeFinder resolves to a different path (e.g., homebrew python due to symlinks)
            const userPyenvPath = '/Users/test/.pyenv/versions/3.13.7/bin/python';
            const resolvedHomebrewPath = '/opt/homebrew/bin/python3';

            sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
            sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([]);
            sandbox.stub(helpers, 'getUserConfiguredSetting').callsFake((section: string, key: string) => {
                if (section === 'python' && key === 'defaultInterpreterPath') {
                    return userPyenvPath;
                }
                return undefined;
            });

            // Native finder resolves to a DIFFERENT path (e.g., following symlinks)
            mockNativeFinder.resolve.resolves({
                executable: resolvedHomebrewPath,
                version: '3.14.2',
                prefix: '/opt/homebrew',
            });

            // API resolves the homebrew path to a homebrew environment
            const homebrewEnv: PythonEnvironment = {
                envId: { id: 'homebrew-env', managerId: 'ms-python.python:system' },
                name: 'Homebrew Python',
                displayName: 'Python 3.14.2 (homebrew)',
                version: '3.14.2',
                displayPath: resolvedHomebrewPath,
                environmentPath: Uri.file(resolvedHomebrewPath),
                sysPrefix: '/opt/homebrew',
                execInfo: { run: { executable: resolvedHomebrewPath } },
            };
            mockApi.resolveEnvironment.resolves(homebrewEnv);

            const result = await resolveEnvironmentByPriority(
                testUri,
                mockEnvManagers as unknown as EnvironmentManagers,
                mockProjectManager as unknown as PythonProjectManager,
                mockNativeFinder as unknown as NativePythonFinder,
                mockApi as unknown as PythonEnvironmentApi,
            );

            // Should still use defaultInterpreterPath source
            assert.strictEqual(result.source, 'defaultInterpreterPath');
            assert.ok(result.environment);

            // The environment should use the USER's original path, not the resolved one
            assert.strictEqual(
                result.environment.displayPath,
                userPyenvPath,
                'displayPath should use user configured path',
            );
            assert.strictEqual(
                result.environment.execInfo?.run?.executable,
                userPyenvPath,
                'executable should use user configured path',
            );
            assert.strictEqual(
                result.environment.environmentPath?.fsPath,
                Uri.file(userPyenvPath).fsPath,
                'environmentPath should use user configured path',
            );
        });
    });

    suite('Priority 4: Auto-discovery', () => {
        test('should use local venv when found', async () => {
            sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
            sandbox.stub(helpers, 'getUserConfiguredSetting').returns(undefined);
            mockVenvManager.get.resolves(mockVenvEnv);

            const result = await resolveEnvironmentByPriority(
                testUri,
                mockEnvManagers as unknown as EnvironmentManagers,
                mockProjectManager as unknown as PythonProjectManager,
                mockNativeFinder as unknown as NativePythonFinder,
                mockApi as unknown as PythonEnvironmentApi,
            );

            assert.strictEqual(result.source, 'autoDiscovery');
            assert.strictEqual(result.manager.id, 'ms-python.python:venv');
            assert.strictEqual(result.environment, mockVenvEnv);
        });

        test('should fall back to system manager when no local venv', async () => {
            sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
            sandbox.stub(helpers, 'getUserConfiguredSetting').returns(undefined);
            mockVenvManager.get.resolves(undefined); // No local venv

            const result = await resolveEnvironmentByPriority(
                testUri,
                mockEnvManagers as unknown as EnvironmentManagers,
                mockProjectManager as unknown as PythonProjectManager,
                mockNativeFinder as unknown as NativePythonFinder,
                mockApi as unknown as PythonEnvironmentApi,
            );

            assert.strictEqual(result.source, 'autoDiscovery');
            assert.strictEqual(result.manager.id, 'ms-python.python:system');
        });

        test('should throw error when no managers are available', async () => {
            sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
            sandbox.stub(helpers, 'getUserConfiguredSetting').returns(undefined);

            // Create mock with no managers
            const emptyEnvManagers = {
                getEnvironmentManager: sandbox.stub().returns(undefined),
                setEnvironment: sandbox.stub().resolves(),
                managers: [],
            } as unknown as sinon.SinonStubbedInstance<EnvironmentManagers>;

            await assert.rejects(
                async () =>
                    resolveEnvironmentByPriority(
                        testUri,
                        emptyEnvManagers as unknown as EnvironmentManagers,
                        mockProjectManager as unknown as PythonProjectManager,
                        mockNativeFinder as unknown as NativePythonFinder,
                        mockApi as unknown as PythonEnvironmentApi,
                    ),
                /No environment managers available/,
            );
        });
    });

    suite('Edge Cases', () => {
        test('should fall through when nativeFinder resolves but returns no executable', async () => {
            sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
            sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([]);
            sandbox.stub(helpers, 'getUserConfiguredSetting').callsFake((section: string, key: string) => {
                if (section === 'python' && key === 'defaultInterpreterPath') {
                    return '/some/path/python';
                }
                return undefined;
            });
            // nativeFinder resolves but with undefined executable
            mockNativeFinder.resolve.resolves({ executable: undefined, version: '3.11.0', prefix: '/usr' });
            mockVenvManager.get.resolves(mockVenvEnv);

            const result = await resolveEnvironmentByPriority(
                testUri,
                mockEnvManagers as unknown as EnvironmentManagers,
                mockProjectManager as unknown as PythonProjectManager,
                mockNativeFinder as unknown as NativePythonFinder,
                mockApi as unknown as PythonEnvironmentApi,
            );

            // Should fall through to auto-discovery since resolution failed
            assert.strictEqual(result.source, 'autoDiscovery');
        });

        test('should fall through when api.resolveEnvironment returns undefined', async () => {
            sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
            sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([]);
            sandbox.stub(helpers, 'getUserConfiguredSetting').callsFake((section: string, key: string) => {
                if (section === 'python' && key === 'defaultInterpreterPath') {
                    return '/usr/bin/python3.11';
                }
                return undefined;
            });
            mockNativeFinder.resolve.resolves({ executable: '/usr/bin/python3.11', version: '3.11.0', prefix: '/usr' });
            mockApi.resolveEnvironment.resolves(undefined); // API returns undefined
            mockVenvManager.get.resolves(mockVenvEnv);

            const result = await resolveEnvironmentByPriority(
                testUri,
                mockEnvManagers as unknown as EnvironmentManagers,
                mockProjectManager as unknown as PythonProjectManager,
                mockNativeFinder as unknown as NativePythonFinder,
                mockApi as unknown as PythonEnvironmentApi,
            );

            // Should fall through to auto-discovery
            assert.strictEqual(result.source, 'autoDiscovery');
        });

        test('should use first available manager when venv and system managers not found', async () => {
            sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
            sandbox.stub(helpers, 'getUserConfiguredSetting').returns(undefined);

            const mockCondaManager = {
                id: 'ms-python.python:conda',
                name: 'conda',
                displayName: 'Conda',
                get: sandbox.stub().resolves(undefined),
                set: sandbox.stub(),
            } as unknown as sinon.SinonStubbedInstance<InternalEnvironmentManager>;

            // Only conda manager available, no venv or system
            const condaOnlyEnvManagers = {
                getEnvironmentManager: sandbox.stub().returns(undefined),
                setEnvironment: sandbox.stub().resolves(),
                managers: [mockCondaManager],
            } as unknown as sinon.SinonStubbedInstance<EnvironmentManagers>;

            const result = await resolveEnvironmentByPriority(
                testUri,
                condaOnlyEnvManagers as unknown as EnvironmentManagers,
                mockProjectManager as unknown as PythonProjectManager,
                mockNativeFinder as unknown as NativePythonFinder,
                mockApi as unknown as PythonEnvironmentApi,
            );

            assert.strictEqual(result.source, 'autoDiscovery');
            assert.strictEqual(result.manager.id, 'ms-python.python:conda');
        });
    });
});

suite('Interpreter Selection - applyInitialEnvironmentSelection', () => {
    let sandbox: sinon.SinonSandbox;
    let mockEnvManagers: sinon.SinonStubbedInstance<EnvironmentManagers>;
    let mockProjectManager: sinon.SinonStubbedInstance<PythonProjectManager>;
    let mockNativeFinder: sinon.SinonStubbedInstance<NativePythonFinder>;
    let mockApi: sinon.SinonStubbedInstance<PythonEnvironmentApi>;
    let mockVenvManager: sinon.SinonStubbedInstance<InternalEnvironmentManager>;
    let mockSystemManager: sinon.SinonStubbedInstance<InternalEnvironmentManager>;

    const testUri = Uri.file('/test/workspace');
    const mockVenvEnv: PythonEnvironment = {
        envId: { id: 'venv-env-1', managerId: 'ms-python.python:venv' },
        name: 'Test Venv',
        displayName: 'Test Venv',
        version: '3.11.0',
        displayPath: '/test/workspace/.venv',
        environmentPath: Uri.file('/test/workspace/.venv'),
        sysPrefix: '/test/workspace/.venv',
        execInfo: { run: { executable: '/test/workspace/.venv/bin/python' } },
    };

    setup(() => {
        sandbox = sinon.createSandbox();
        resetSettingWarnings();

        mockVenvManager = {
            id: 'ms-python.python:venv',
            name: 'venv',
            displayName: 'Venv',
            get: sandbox.stub().resolves(mockVenvEnv),
            set: sandbox.stub().resolves(),
        } as unknown as sinon.SinonStubbedInstance<InternalEnvironmentManager>;

        mockSystemManager = {
            id: 'ms-python.python:system',
            name: 'system',
            displayName: 'System',
            get: sandbox.stub(),
            set: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<InternalEnvironmentManager>;

        mockEnvManagers = {
            getEnvironmentManager: sandbox.stub(),
            setEnvironment: sandbox.stub().resolves(),
            setEnvironments: sandbox.stub().resolves(),
            managers: [mockVenvManager, mockSystemManager],
        } as unknown as sinon.SinonStubbedInstance<EnvironmentManagers>;

        mockProjectManager = {
            get: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<PythonProjectManager>;

        mockNativeFinder = {
            resolve: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<NativePythonFinder>;

        mockApi = {
            resolveEnvironment: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<PythonEnvironmentApi>;

        mockEnvManagers.getEnvironmentManager.callsFake((scope: unknown) => {
            const id = typeof scope === 'string' ? scope : undefined;
            if (id === 'ms-python.python:venv') {
                return mockVenvManager;
            }
            if (id === 'ms-python.python:system') {
                return mockSystemManager;
            }
            return undefined;
        });
    });

    teardown(() => {
        sandbox.restore();
    });

    test('should call setEnvironment with shouldPersistSettings=false', async () => {
        sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([{ uri: testUri, name: 'test', index: 0 }]);
        sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
        sandbox.stub(helpers, 'getUserConfiguredSetting').returns(undefined);

        await applyInitialEnvironmentSelection(
            mockEnvManagers as unknown as EnvironmentManagers,
            mockProjectManager as unknown as PythonProjectManager,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        // Verify setEnvironment was called with shouldPersistSettings=false
        assert.ok(mockEnvManagers.setEnvironment.called);
        const callArgs = mockEnvManagers.setEnvironment.firstCall.args;
        assert.strictEqual(callArgs[2], false, 'shouldPersistSettings should be false');
    });

    test('should process all workspace folders', async () => {
        const uri1 = Uri.file('/workspace1');
        const uri2 = Uri.file('/workspace2');
        sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([
            { uri: uri1, name: 'workspace1', index: 0 },
            { uri: uri2, name: 'workspace2', index: 1 },
        ]);
        sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
        sandbox.stub(helpers, 'getUserConfiguredSetting').returns(undefined);

        await applyInitialEnvironmentSelection(
            mockEnvManagers as unknown as EnvironmentManagers,
            mockProjectManager as unknown as PythonProjectManager,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        // Should be called once for each workspace folder
        assert.strictEqual(mockEnvManagers.setEnvironment.callCount, 2);
    });

    test('should also set global environment when no workspace folders', async () => {
        sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([]);
        sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
        sandbox.stub(helpers, 'getUserConfiguredSetting').returns(undefined);

        await applyInitialEnvironmentSelection(
            mockEnvManagers as unknown as EnvironmentManagers,
            mockProjectManager as unknown as PythonProjectManager,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        // Should call setEnvironments for global scope
        assert.ok(mockEnvManagers.setEnvironments.called, 'setEnvironments should be called for global scope');
        const callArgs = mockEnvManagers.setEnvironments.firstCall.args;
        assert.strictEqual(callArgs[0], 'global', 'First arg should be "global"');
        assert.strictEqual(callArgs[2], false, 'shouldPersistSettings should be false');
    });

    test('should not show warning when defaultInterpreterPath with ${workspaceFolder} is used in workspace scope (issue #1316)', async () => {
        // Scenario from issue #1316: workspace settings.json has
        //   "python.defaultInterpreterPath": "${workspaceFolder}/python-embedded/python.exe"
        // The per-folder chain resolves it correctly, but the global chain cannot.
        // The global chain should silently skip — no warning popup should be shown.
        const workspaceFolder = { uri: testUri, name: 'test', index: 0 } as WorkspaceFolder;
        sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([workspaceFolder]);
        sandbox.stub(workspaceApis, 'getWorkspaceFolder').returns(workspaceFolder);
        sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);

        const expandedPath = path.join(testUri.fsPath, 'python-embedded', 'python.exe');
        sandbox.stub(helpers, 'getUserConfiguredSetting').callsFake((section: string, key: string) => {
            if (section === 'python' && key === 'defaultInterpreterPath') {
                return '${workspaceFolder}/python-embedded/python.exe';
            }
            return undefined;
        });

        // For workspace scope: nativeFinder resolves the expanded path successfully
        mockNativeFinder.resolve.resolves({
            executable: expandedPath,
            version: '3.12.10',
            prefix: path.join(testUri.fsPath, 'python-embedded'),
        });
        const mockResolvedEnv: PythonEnvironment = {
            envId: { id: 'embedded-env', managerId: 'ms-python.python:system' },
            name: 'Embedded Python',
            displayName: 'Python 3.12.10',
            version: '3.12.10',
            displayPath: expandedPath,
            environmentPath: Uri.file(expandedPath),
            sysPrefix: path.join(testUri.fsPath, 'python-embedded'),
            execInfo: { run: { executable: expandedPath } },
        };
        mockApi.resolveEnvironment.resolves(mockResolvedEnv);

        // Stub showWarningMessage to track if it's called
        const showWarnStub = sandbox.stub(windowApis, 'showWarningMessage').resolves(undefined);

        await applyInitialEnvironmentSelection(
            mockEnvManagers as unknown as EnvironmentManagers,
            mockProjectManager as unknown as PythonProjectManager,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        // The workspace folder should be set successfully
        assert.ok(mockEnvManagers.setEnvironment.called, 'setEnvironment should be called for workspace folder');

        // No warning should be shown — the global chain should silently skip ${workspaceFolder}
        assert.ok(
            showWarnStub.notCalled,
            'showWarningMessage should not be called when ${workspaceFolder} is only unresolvable in global scope',
        );
    });

    test('should catch and continue when workspace folder resolution throws', async () => {
        // When manager.get() throws for a folder, the error should be caught
        // and the function should still complete (falling through to awaited global scope).
        sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([{ uri: testUri, name: 'test', index: 0 }]);
        sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
        sandbox.stub(helpers, 'getUserConfiguredSetting').returns(undefined);

        // Make venvManager.get() throw for the workspace folder
        mockVenvManager.get.rejects(new Error('Simulated venv discovery failure'));
        // systemManager.get() throws for workspace scope but succeeds for global scope
        mockSystemManager.get.callsFake((scope: Uri | undefined) => {
            if (scope) {
                return Promise.reject(new Error('Simulated system discovery failure'));
            }
            return Promise.resolve(undefined);
        });

        // Should NOT throw — the per-folder catch block handles it
        await applyInitialEnvironmentSelection(
            mockEnvManagers as unknown as EnvironmentManagers,
            mockProjectManager as unknown as PythonProjectManager,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        // setEnvironment should NOT have been called for the failed folder
        assert.ok(
            mockEnvManagers.setEnvironment.notCalled,
            'setEnvironment should not be called when folder resolution throws',
        );

        // Global scope should still be resolved (awaited, since no workspace folder succeeded)
        assert.ok(
            mockEnvManagers.setEnvironments.called,
            'setEnvironments should still be called for global scope after folder failure',
        );
    });

    test('should continue processing remaining folders when one folder throws', async () => {
        // In multi-root: if folder 1's resolution throws (e.g., setEnvironment fails),
        // the error is caught and folder 2 should still be processed.
        const uri1 = Uri.file('/workspace1');
        const uri2 = Uri.file('/workspace2');
        sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([
            { uri: uri1, name: 'workspace1', index: 0 },
            { uri: uri2, name: 'workspace2', index: 1 },
        ]);
        sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
        sandbox.stub(helpers, 'getUserConfiguredSetting').returns(undefined);

        // setEnvironment throws for folder 1 only, succeeds for folder 2
        mockEnvManagers.setEnvironment.callsFake((scope: SetEnvironmentScope) => {
            if (scope && !Array.isArray(scope) && scope.fsPath === uri1.fsPath) {
                return Promise.reject(new Error('Folder 1 setEnvironment failure'));
            }
            return Promise.resolve();
        });

        await applyInitialEnvironmentSelection(
            mockEnvManagers as unknown as EnvironmentManagers,
            mockProjectManager as unknown as PythonProjectManager,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        // setEnvironment should be called for both folders (folder 1 threw, folder 2 succeeded)
        assert.strictEqual(
            mockEnvManagers.setEnvironment.callCount,
            2,
            'setEnvironment should be attempted for both folders',
        );
        // Folder 2 succeeded — verify it was called with the correct URI
        const secondCallUri = mockEnvManagers.setEnvironment.secondCall.args[0] as Uri;
        assert.strictEqual(secondCallUri.fsPath, uri2.fsPath, 'Second call should be for folder 2');
    });

    test('should show warning when pythonProjects references unregistered manager', async () => {
        // Priority 1 error path: pythonProjects[] names a manager that isn't registered.
        // Should fall through to auto-discovery and show a warning.
        const workspaceFolder = { uri: testUri, name: 'test', index: 0 } as WorkspaceFolder;
        sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([workspaceFolder]);
        sandbox.stub(workspaceApis, 'getWorkspaceFolder').returns(workspaceFolder);
        sandbox
            .stub(workspaceApis, 'getConfiguration')
            .returns(
                createMockConfig([{ path: '.', envManager: 'ms-python.python:nonexistent' }]) as WorkspaceConfiguration,
            );
        sandbox.stub(helpers, 'getUserConfiguredSetting').returns(undefined);

        mockProjectManager.get.returns({ uri: testUri, name: 'test' } as PythonProject);

        const showWarnStub = sandbox.stub(windowApis, 'showWarningMessage').resolves(undefined);

        await applyInitialEnvironmentSelection(
            mockEnvManagers as unknown as EnvironmentManagers,
            mockProjectManager as unknown as PythonProjectManager,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        // Should still set the environment (falls through to auto-discovery)
        assert.ok(mockEnvManagers.setEnvironment.called, 'setEnvironment should be called via fallback');

        // Should show a warning about the unregistered manager
        assert.ok(showWarnStub.called, 'showWarningMessage should be called for unregistered pythonProjects manager');
    });

    test('should show warning when defaultEnvManager references unregistered manager', async () => {
        // Priority 2 error path: defaultEnvManager names a manager that isn't registered.
        sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([{ uri: testUri, name: 'test', index: 0 }]);
        sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
        sandbox.stub(helpers, 'getUserConfiguredSetting').callsFake((section: string, key: string) => {
            if (section === 'python-envs' && key === 'defaultEnvManager') {
                return 'ms-python.python:nonexistent';
            }
            return undefined;
        });

        const showWarnStub = sandbox.stub(windowApis, 'showWarningMessage').resolves(undefined);

        await applyInitialEnvironmentSelection(
            mockEnvManagers as unknown as EnvironmentManagers,
            mockProjectManager as unknown as PythonProjectManager,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        // Should still set the environment (falls through to auto-discovery)
        assert.ok(mockEnvManagers.setEnvironment.called, 'setEnvironment should be called via fallback');

        // Should show a warning about the unregistered manager
        assert.ok(showWarnStub.called, 'showWarningMessage should be called for unregistered defaultEnvManager');
    });

    test('should handle global scope errors when deferred to background', async () => {
        // When workspace folder resolves but global scope has setting errors,
        // notifyUserOfSettingErrors should still be called from the background task.
        sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([{ uri: testUri, name: 'test', index: 0 }]);
        sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);

        // Global scope gets a defaultEnvManager that doesn't exist → produces a SettingResolutionError
        sandbox.stub(helpers, 'getUserConfiguredSetting').callsFake((section: string, key: string, scope?: Uri) => {
            if (!scope && section === 'python-envs' && key === 'defaultEnvManager') {
                return 'ms-python.python:nonexistent-global';
            }
            return undefined;
        });

        const showWarnStub = sandbox.stub(windowApis, 'showWarningMessage').resolves(undefined);

        // Use a deferred promise to deterministically wait for the background global scope
        let resolveGlobalDone!: () => void;
        const globalDone = new Promise<void>((resolve) => {
            resolveGlobalDone = resolve;
        });
        mockEnvManagers.setEnvironments.callsFake(async () => {
            resolveGlobalDone();
        });

        await applyInitialEnvironmentSelection(
            mockEnvManagers as unknown as EnvironmentManagers,
            mockProjectManager as unknown as PythonProjectManager,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        // Workspace folder should resolve (venv found)
        assert.ok(mockEnvManagers.setEnvironment.called, 'setEnvironment should be called for workspace folder');

        // Wait for the background global scope to call setEnvironments
        await globalDone;
        // Flush microtasks so the .then() handler for notifyUserOfSettingErrors runs
        await new Promise<void>((resolve) => process.nextTick(resolve));

        // Global scope should still resolve (falls to auto-discovery) and show warning
        assert.ok(mockEnvManagers.setEnvironments.called, 'setEnvironments should be called for global scope');
        assert.ok(
            showWarnStub.called,
            'showWarningMessage should be called for global scope setting error even when deferred',
        );
    });

    test('should handle global scope crash when deferred to background', async () => {
        // When workspace folder resolves but global scope crashes (resolveGlobalScope catch block),
        // the error should be logged and not propagate.
        sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([{ uri: testUri, name: 'test', index: 0 }]);
        sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
        sandbox.stub(helpers, 'getUserConfiguredSetting').returns(undefined);

        // Use a deferred promise to deterministically wait for the background global scope
        let resolveGlobalDone!: () => void;
        const globalDone = new Promise<void>((resolve) => {
            resolveGlobalDone = resolve;
        });
        mockEnvManagers.setEnvironments.callsFake(async () => {
            resolveGlobalDone();
            throw new Error('Simulated global scope crash');
        });

        // Should NOT throw — errors are caught inside resolveGlobalScope
        await applyInitialEnvironmentSelection(
            mockEnvManagers as unknown as EnvironmentManagers,
            mockProjectManager as unknown as PythonProjectManager,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        // Wait for the background global scope to call setEnvironments
        await globalDone;
        // Flush microtasks so the catch handler runs
        await new Promise<void>((resolve) => process.nextTick(resolve));

        // Workspace folder should still have resolved
        assert.ok(mockEnvManagers.setEnvironment.called, 'setEnvironment should be called for workspace folder');

        // setEnvironments was called (and threw), proving the global scope was attempted
        assert.ok(
            mockEnvManagers.setEnvironments.called,
            'setEnvironments should have been attempted for global scope',
        );
    });

    test('notifyUserOfSettingErrors shows warning with Open Settings for defaultInterpreterPath', async () => {
        // Trigger the defaultInterpreterPath error branch of notifyUserOfSettingErrors.
        sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([{ uri: testUri, name: 'test', index: 0 }]);
        sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
        sandbox.stub(helpers, 'getUserConfiguredSetting').callsFake((section: string, key: string) => {
            if (section === 'python' && key === 'defaultInterpreterPath') {
                return '/nonexistent/python';
            }
            return undefined;
        });
        // nativeFinder.resolve fails — path can't be resolved
        mockNativeFinder.resolve.rejects(new Error('Not found'));

        const showWarnStub = sandbox.stub(windowApis, 'showWarningMessage').resolves(undefined);

        await applyInitialEnvironmentSelection(
            mockEnvManagers as unknown as EnvironmentManagers,
            mockProjectManager as unknown as PythonProjectManager,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        assert.ok(showWarnStub.called, 'showWarningMessage should be called for unresolvable defaultInterpreterPath');
        const warningMessage = showWarnStub.firstCall.args[0] as string;
        assert.ok(warningMessage.includes('/nonexistent/python'), 'Warning message should include the configured path');
    });
});

suite('Interpreter Selection - resolveGlobalEnvironmentByPriority', () => {
    let sandbox: sinon.SinonSandbox;
    let mockEnvManagers: sinon.SinonStubbedInstance<EnvironmentManagers>;
    let mockNativeFinder: sinon.SinonStubbedInstance<NativePythonFinder>;
    let mockApi: sinon.SinonStubbedInstance<PythonEnvironmentApi>;
    let mockVenvManager: sinon.SinonStubbedInstance<InternalEnvironmentManager>;
    let mockSystemManager: sinon.SinonStubbedInstance<InternalEnvironmentManager>;

    const mockSystemEnv: PythonEnvironment = {
        envId: { id: 'system-env-1', managerId: 'ms-python.python:system' },
        name: 'System Python',
        displayName: 'System Python 3.11',
        version: '3.11.0',
        displayPath: '/usr/bin/python3.11',
        environmentPath: Uri.file('/usr/bin/python3.11'),
        sysPrefix: '/usr',
        execInfo: { run: { executable: '/usr/bin/python3.11' } },
    };

    setup(() => {
        sandbox = sinon.createSandbox();

        mockVenvManager = {
            id: 'ms-python.python:venv',
            name: 'venv',
            displayName: 'Venv',
            get: sandbox.stub(),
            set: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<InternalEnvironmentManager>;

        mockSystemManager = {
            id: 'ms-python.python:system',
            name: 'system',
            displayName: 'System',
            get: sandbox.stub(),
            set: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<InternalEnvironmentManager>;

        mockEnvManagers = {
            getEnvironmentManager: sandbox.stub(),
            setEnvironment: sandbox.stub().resolves(),
            setEnvironments: sandbox.stub().resolves(),
            managers: [mockVenvManager, mockSystemManager],
        } as unknown as sinon.SinonStubbedInstance<EnvironmentManagers>;

        mockNativeFinder = {
            resolve: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<NativePythonFinder>;

        mockApi = {
            resolveEnvironment: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<PythonEnvironmentApi>;

        mockEnvManagers.getEnvironmentManager.callsFake((scope: unknown) => {
            const id = typeof scope === 'string' ? scope : undefined;
            if (id === 'ms-python.python:venv') {
                return mockVenvManager;
            }
            if (id === 'ms-python.python:system') {
                return mockSystemManager;
            }
            if (id === undefined) {
                return mockSystemManager; // Default manager for global scope
            }
            return undefined;
        });
    });

    teardown(() => {
        sandbox.restore();
    });

    test('should use user-configured defaultEnvManager for global scope', async () => {
        sandbox.stub(helpers, 'getUserConfiguredSetting').callsFake((section: string, key: string) => {
            if (section === 'python-envs' && key === 'defaultEnvManager') {
                return 'ms-python.python:venv';
            }
            return undefined;
        });

        const result = await resolveGlobalEnvironmentByPriority(
            mockEnvManagers as unknown as EnvironmentManagers,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        assert.strictEqual(result.source, 'defaultEnvManager');
        assert.strictEqual(result.manager.id, 'ms-python.python:venv');
    });

    test('should use defaultInterpreterPath for global scope when configured', async () => {
        const userPyenvPath = '/Users/test/.pyenv/versions/3.13.7/bin/python';

        sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([]);
        sandbox.stub(helpers, 'getUserConfiguredSetting').callsFake((section: string, key: string) => {
            if (section === 'python' && key === 'defaultInterpreterPath') {
                return userPyenvPath;
            }
            return undefined;
        });

        mockNativeFinder.resolve.resolves({
            executable: userPyenvPath,
            version: '3.13.7',
            prefix: '/Users/test/.pyenv/versions/3.13.7',
        });
        mockApi.resolveEnvironment.resolves(mockSystemEnv);

        const result = await resolveGlobalEnvironmentByPriority(
            mockEnvManagers as unknown as EnvironmentManagers,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        assert.strictEqual(result.source, 'defaultInterpreterPath');
        assert.ok(result.environment);
        assert.strictEqual(result.environment.displayPath, userPyenvPath);
        assert.strictEqual(result.environment.execInfo?.run?.executable, userPyenvPath);
    });

    test('should use original user path for global scope even when nativeFinder resolves to different executable', async () => {
        // This is the key bug fix test - user configures pyenv path, native finder returns homebrew
        const userPyenvPath = '/Users/test/.pyenv/versions/3.13.7/bin/python';
        const resolvedHomebrewPath = '/opt/homebrew/bin/python3';

        sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([]);
        sandbox.stub(helpers, 'getUserConfiguredSetting').callsFake((section: string, key: string) => {
            if (section === 'python' && key === 'defaultInterpreterPath') {
                return userPyenvPath;
            }
            return undefined;
        });

        // Native finder resolves to a DIFFERENT path (e.g., following symlinks)
        mockNativeFinder.resolve.resolves({
            executable: resolvedHomebrewPath,
            version: '3.14.2',
            prefix: '/opt/homebrew',
        });

        // API resolves the homebrew path to a homebrew environment
        const homebrewEnv: PythonEnvironment = {
            envId: { id: 'homebrew-env', managerId: 'ms-python.python:system' },
            name: 'Homebrew Python',
            displayName: 'Python 3.14.2 (homebrew)',
            version: '3.14.2',
            displayPath: resolvedHomebrewPath,
            environmentPath: Uri.file(resolvedHomebrewPath),
            sysPrefix: '/opt/homebrew',
            execInfo: { run: { executable: resolvedHomebrewPath } },
        };
        mockApi.resolveEnvironment.resolves(homebrewEnv);

        const result = await resolveGlobalEnvironmentByPriority(
            mockEnvManagers as unknown as EnvironmentManagers,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        // Should still use defaultInterpreterPath source
        assert.strictEqual(result.source, 'defaultInterpreterPath');
        assert.ok(result.environment);

        // The environment should use the USER's original path, not the resolved one
        assert.strictEqual(
            result.environment.displayPath,
            userPyenvPath,
            'displayPath should use user configured path',
        );
        assert.strictEqual(
            result.environment.execInfo?.run?.executable,
            userPyenvPath,
            'executable should use user configured path',
        );
    });

    test('should fall back to system manager when no user settings for global scope', async () => {
        sandbox.stub(helpers, 'getUserConfiguredSetting').returns(undefined);

        const result = await resolveGlobalEnvironmentByPriority(
            mockEnvManagers as unknown as EnvironmentManagers,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        assert.strictEqual(result.source, 'autoDiscovery');
        assert.strictEqual(result.manager.id, 'ms-python.python:system');
    });

    test('should silently skip ${workspaceFolder} in defaultInterpreterPath for global scope (issue #1316)', async () => {
        // When defaultInterpreterPath contains ${workspaceFolder}, the global priority chain
        // cannot resolve it (no workspace folder context). It should silently fall through
        // to auto-discovery without generating an error that triggers a user notification.
        sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([]);
        sandbox.stub(workspaceApis, 'getWorkspaceFolder').returns(undefined);
        sandbox.stub(helpers, 'getUserConfiguredSetting').callsFake((section: string, key: string) => {
            if (section === 'python' && key === 'defaultInterpreterPath') {
                return '${workspaceFolder}/python-embedded/python.exe';
            }
            return undefined;
        });

        const result = await resolveGlobalEnvironmentByPriority(
            mockEnvManagers as unknown as EnvironmentManagers,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        // Should fall through to auto-discovery without calling nativeFinder.resolve
        assert.strictEqual(result.source, 'autoDiscovery');
        assert.ok(
            mockNativeFinder.resolve.notCalled,
            'nativeFinder.resolve should not be called with unresolved variables',
        );
    });
});

suite('Interpreter Selection - registerInterpreterSettingsChangeListener', () => {
    let sandbox: sinon.SinonSandbox;
    let mockEnvManagers: sinon.SinonStubbedInstance<EnvironmentManagers>;
    let mockProjectManager: sinon.SinonStubbedInstance<PythonProjectManager>;
    let mockNativeFinder: sinon.SinonStubbedInstance<NativePythonFinder>;
    let mockApi: sinon.SinonStubbedInstance<PythonEnvironmentApi>;
    let mockVenvManager: sinon.SinonStubbedInstance<InternalEnvironmentManager>;
    let mockSystemManager: sinon.SinonStubbedInstance<InternalEnvironmentManager>;

    const testUri = Uri.file('/test/workspace');
    const mockVenvEnv: PythonEnvironment = {
        envId: { id: 'venv-env-1', managerId: 'ms-python.python:venv' },
        name: 'Test Venv',
        displayName: 'Test Venv',
        version: '3.11.0',
        displayPath: '/test/workspace/.venv',
        environmentPath: Uri.file('/test/workspace/.venv'),
        sysPrefix: '/test/workspace/.venv',
        execInfo: { run: { executable: '/test/workspace/.venv/bin/python' } },
    };

    setup(() => {
        sandbox = sinon.createSandbox();

        mockVenvManager = {
            id: 'ms-python.python:venv',
            name: 'venv',
            displayName: 'Venv',
            get: sandbox.stub().resolves(mockVenvEnv),
            set: sandbox.stub().resolves(),
        } as unknown as sinon.SinonStubbedInstance<InternalEnvironmentManager>;

        mockSystemManager = {
            id: 'ms-python.python:system',
            name: 'system',
            displayName: 'System',
            get: sandbox.stub(),
            set: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<InternalEnvironmentManager>;

        mockEnvManagers = {
            getEnvironmentManager: sandbox.stub(),
            setEnvironment: sandbox.stub().resolves(),
            setEnvironments: sandbox.stub().resolves(),
            managers: [mockVenvManager, mockSystemManager],
        } as unknown as sinon.SinonStubbedInstance<EnvironmentManagers>;

        mockProjectManager = {
            get: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<PythonProjectManager>;

        mockNativeFinder = {
            resolve: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<NativePythonFinder>;

        mockApi = {
            resolveEnvironment: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<PythonEnvironmentApi>;

        mockEnvManagers.getEnvironmentManager.callsFake((scope: unknown) => {
            const id = typeof scope === 'string' ? scope : undefined;
            if (id === 'ms-python.python:venv') {
                return mockVenvManager;
            }
            if (id === 'ms-python.python:system') {
                return mockSystemManager;
            }
            return undefined;
        });
    });

    teardown(() => {
        sandbox.restore();
    });

    test('should re-run priority chain when python.defaultInterpreterPath changes', async () => {
        // Capture the callback registered with onDidChangeConfiguration
        let configChangeCallback: ((e: ConfigurationChangeEvent) => void) | undefined;
        sandbox.stub(workspaceApis, 'onDidChangeConfiguration').callsFake((callback) => {
            configChangeCallback = callback;
            return { dispose: () => {} };
        });

        sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([{ uri: testUri, name: 'test', index: 0 }]);
        sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
        sandbox.stub(helpers, 'getUserConfiguredSetting').returns(undefined);

        // Register the listener
        const disposable = registerInterpreterSettingsChangeListener(
            mockEnvManagers as unknown as EnvironmentManagers,
            mockProjectManager as unknown as PythonProjectManager,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        assert.ok(configChangeCallback, 'Config change callback should be registered');

        // Simulate a configuration change for defaultInterpreterPath
        const mockEvent: ConfigurationChangeEvent = {
            affectsConfiguration: (section: string) => section === 'python.defaultInterpreterPath',
        };

        // Reset the call count before triggering the change
        mockEnvManagers.setEnvironment.resetHistory();
        mockEnvManagers.setEnvironments.resetHistory();

        // Trigger the configuration change
        await configChangeCallback(mockEvent);

        // Verify that applyInitialEnvironmentSelection was called (which calls setEnvironment/setEnvironments)
        assert.ok(
            mockEnvManagers.setEnvironment.called || mockEnvManagers.setEnvironments.called,
            'Should re-run priority chain when defaultInterpreterPath changes',
        );

        disposable.dispose();
    });

    test('should re-run priority chain when python-envs.defaultEnvManager changes', async () => {
        let configChangeCallback: ((e: ConfigurationChangeEvent) => void) | undefined;
        sandbox.stub(workspaceApis, 'onDidChangeConfiguration').callsFake((callback) => {
            configChangeCallback = callback;
            return { dispose: () => {} };
        });

        sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([{ uri: testUri, name: 'test', index: 0 }]);
        sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
        sandbox.stub(helpers, 'getUserConfiguredSetting').returns(undefined);

        const disposable = registerInterpreterSettingsChangeListener(
            mockEnvManagers as unknown as EnvironmentManagers,
            mockProjectManager as unknown as PythonProjectManager,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        assert.ok(configChangeCallback, 'Config change callback should be registered');

        const mockEvent: ConfigurationChangeEvent = {
            affectsConfiguration: (section: string) => section === 'python-envs.defaultEnvManager',
        };

        mockEnvManagers.setEnvironment.resetHistory();
        mockEnvManagers.setEnvironments.resetHistory();

        await configChangeCallback(mockEvent);

        assert.ok(
            mockEnvManagers.setEnvironment.called || mockEnvManagers.setEnvironments.called,
            'Should re-run priority chain when defaultEnvManager changes',
        );

        disposable.dispose();
    });

    test('should re-run priority chain when python-envs.pythonProjects changes', async () => {
        let configChangeCallback: ((e: ConfigurationChangeEvent) => void) | undefined;
        sandbox.stub(workspaceApis, 'onDidChangeConfiguration').callsFake((callback) => {
            configChangeCallback = callback;
            return { dispose: () => {} };
        });

        sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([{ uri: testUri, name: 'test', index: 0 }]);
        sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
        sandbox.stub(helpers, 'getUserConfiguredSetting').returns(undefined);

        const disposable = registerInterpreterSettingsChangeListener(
            mockEnvManagers as unknown as EnvironmentManagers,
            mockProjectManager as unknown as PythonProjectManager,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        assert.ok(configChangeCallback, 'Config change callback should be registered');

        const mockEvent: ConfigurationChangeEvent = {
            affectsConfiguration: (section: string) => section === 'python-envs.pythonProjects',
        };

        mockEnvManagers.setEnvironment.resetHistory();
        mockEnvManagers.setEnvironments.resetHistory();

        await configChangeCallback(mockEvent);

        assert.ok(
            mockEnvManagers.setEnvironment.called || mockEnvManagers.setEnvironments.called,
            'Should re-run priority chain when pythonProjects changes',
        );

        disposable.dispose();
    });

    test('should NOT re-run priority chain when unrelated configuration changes', async () => {
        let configChangeCallback: ((e: ConfigurationChangeEvent) => void) | undefined;
        sandbox.stub(workspaceApis, 'onDidChangeConfiguration').callsFake((callback) => {
            configChangeCallback = callback;
            return { dispose: () => {} };
        });

        sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([{ uri: testUri, name: 'test', index: 0 }]);
        sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
        sandbox.stub(helpers, 'getUserConfiguredSetting').returns(undefined);

        const disposable = registerInterpreterSettingsChangeListener(
            mockEnvManagers as unknown as EnvironmentManagers,
            mockProjectManager as unknown as PythonProjectManager,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        assert.ok(configChangeCallback, 'Config change callback should be registered');

        // Simulate a configuration change for an unrelated setting
        const mockEvent: ConfigurationChangeEvent = {
            affectsConfiguration: (section: string) => section === 'editor.fontSize',
        };

        mockEnvManagers.setEnvironment.resetHistory();
        mockEnvManagers.setEnvironments.resetHistory();

        await configChangeCallback(mockEvent);

        assert.ok(
            !mockEnvManagers.setEnvironment.called && !mockEnvManagers.setEnvironments.called,
            'Should NOT re-run priority chain when unrelated configuration changes',
        );

        disposable.dispose();
    });
});

suite('Interpreter Selection - Settings over Cache Priority', () => {
    let sandbox: sinon.SinonSandbox;
    let mockEnvManagers: sinon.SinonStubbedInstance<EnvironmentManagers>;
    let mockProjectManager: sinon.SinonStubbedInstance<PythonProjectManager>;
    let mockNativeFinder: sinon.SinonStubbedInstance<NativePythonFinder>;
    let mockApi: sinon.SinonStubbedInstance<PythonEnvironmentApi>;
    let mockVenvManager: sinon.SinonStubbedInstance<InternalEnvironmentManager>;
    let mockSystemManager: sinon.SinonStubbedInstance<InternalEnvironmentManager>;
    let mockCondaManager: sinon.SinonStubbedInstance<InternalEnvironmentManager>;

    const testUri = Uri.file('/test/workspace');
    const mockVenvEnv: PythonEnvironment = {
        envId: { id: 'venv-env-1', managerId: 'ms-python.python:venv' },
        name: 'Test Venv',
        displayName: 'Test Venv',
        version: '3.11.0',
        displayPath: '/test/workspace/.venv',
        environmentPath: Uri.file('/test/workspace/.venv'),
        sysPrefix: '/test/workspace/.venv',
        execInfo: { run: { executable: '/test/workspace/.venv/bin/python' } },
    };

    setup(() => {
        sandbox = sinon.createSandbox();

        mockVenvManager = {
            id: 'ms-python.python:venv',
            name: 'venv',
            displayName: 'Venv',
            get: sandbox.stub().resolves(mockVenvEnv),
            set: sandbox.stub().resolves(),
        } as unknown as sinon.SinonStubbedInstance<InternalEnvironmentManager>;

        mockSystemManager = {
            id: 'ms-python.python:system',
            name: 'system',
            displayName: 'System',
            get: sandbox.stub(),
            set: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<InternalEnvironmentManager>;

        mockCondaManager = {
            id: 'ms-python.python:conda',
            name: 'conda',
            displayName: 'Conda',
            get: sandbox.stub(),
            set: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<InternalEnvironmentManager>;

        mockEnvManagers = {
            getEnvironmentManager: sandbox.stub(),
            setEnvironment: sandbox.stub().resolves(),
            setEnvironments: sandbox.stub().resolves(),
            managers: [mockVenvManager, mockSystemManager, mockCondaManager],
        } as unknown as sinon.SinonStubbedInstance<EnvironmentManagers>;

        mockProjectManager = {
            get: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<PythonProjectManager>;

        mockNativeFinder = {
            resolve: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<NativePythonFinder>;

        mockApi = {
            resolveEnvironment: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<PythonEnvironmentApi>;

        mockEnvManagers.getEnvironmentManager.callsFake((scope: unknown) => {
            const id = typeof scope === 'string' ? scope : undefined;
            if (id === 'ms-python.python:venv') {
                return mockVenvManager;
            }
            if (id === 'ms-python.python:system') {
                return mockSystemManager;
            }
            if (id === 'ms-python.python:conda') {
                return mockCondaManager;
            }
            return undefined;
        });
    });

    teardown(() => {
        sandbox.restore();
    });

    test('should use user-configured defaultEnvManager even when cache has different manager', async () => {
        // This test verifies settings take priority over cache
        // Setup: User has configured defaultEnvManager=conda, but cache has venv
        sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
        sandbox.stub(helpers, 'getUserConfiguredSetting').callsFake((section: string, key: string) => {
            if (section === 'python-envs' && key === 'defaultEnvManager') {
                return 'ms-python.python:conda'; // User wants conda
            }
            return undefined;
        });

        // Even though the cache might have venv, the user's setting for conda should be respected
        const result = await resolveEnvironmentByPriority(
            testUri,
            mockEnvManagers as unknown as EnvironmentManagers,
            mockProjectManager as unknown as PythonProjectManager,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        // The result should use the user's configured manager (conda), not the cached one
        assert.strictEqual(result.source, 'defaultEnvManager');
        assert.strictEqual(result.manager.id, 'ms-python.python:conda');
    });

    test('should use pythonProjects manager even when defaultEnvManager is set', async () => {
        // This test verifies pythonProjects[] has highest priority (Priority 1 over Priority 2)
        // Use '.' as relative path - path.resolve(workspaceFolder, '.') equals workspaceFolder
        sandbox.stub(workspaceApis, 'getConfiguration').returns(
            createMockConfig([
                {
                    path: '.',
                    envManager: 'ms-python.python:venv', // Project says venv
                    packageManager: 'ms-python.python:pip',
                },
            ]) as WorkspaceConfiguration,
        );
        const mockProject: Partial<PythonProject> = { uri: testUri, name: 'test' };
        mockProjectManager.get.returns(mockProject as PythonProject);
        const mockWorkspaceFolder: Partial<WorkspaceFolder> = { uri: testUri };
        sandbox.stub(workspaceApis, 'getWorkspaceFolder').returns(mockWorkspaceFolder as WorkspaceFolder);

        sandbox.stub(helpers, 'getUserConfiguredSetting').callsFake((section: string, key: string) => {
            if (section === 'python-envs' && key === 'defaultEnvManager') {
                return 'ms-python.python:conda'; // User's default is conda
            }
            return undefined;
        });

        const result = await resolveEnvironmentByPriority(
            testUri,
            mockEnvManagers as unknown as EnvironmentManagers,
            mockProjectManager as unknown as PythonProjectManager,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        // pythonProjects[] (venv) should take priority over defaultEnvManager (conda)
        assert.strictEqual(result.source, 'pythonProjects');
        assert.strictEqual(result.manager.id, 'ms-python.python:venv');
    });

    test('should fall back to auto-discovery when no user settings configured', async () => {
        // When no settings are configured, cache from auto-discovery should be used
        sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
        sandbox.stub(helpers, 'getUserConfiguredSetting').returns(undefined);

        const result = await resolveEnvironmentByPriority(
            testUri,
            mockEnvManagers as unknown as EnvironmentManagers,
            mockProjectManager as unknown as PythonProjectManager,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        // Should fall through to auto-discovery
        assert.strictEqual(result.source, 'autoDiscovery');
    });
});

suite('Interpreter Selection - Multi-Root Workspace', () => {
    let sandbox: sinon.SinonSandbox;
    let mockEnvManagers: sinon.SinonStubbedInstance<EnvironmentManagers>;
    let mockProjectManager: sinon.SinonStubbedInstance<PythonProjectManager>;
    let mockNativeFinder: sinon.SinonStubbedInstance<NativePythonFinder>;
    let mockApi: sinon.SinonStubbedInstance<PythonEnvironmentApi>;
    let mockVenvManager: sinon.SinonStubbedInstance<InternalEnvironmentManager>;
    let mockSystemManager: sinon.SinonStubbedInstance<InternalEnvironmentManager>;

    const folder1Uri = Uri.file('/workspace/folder1');
    const folder2Uri = Uri.file('/workspace/folder2');

    const mockVenvEnv1: PythonEnvironment = {
        envId: { id: 'venv-env-folder1', managerId: 'ms-python.python:venv' },
        name: 'Folder1 Venv',
        displayName: 'Folder1 Venv 3.11',
        version: '3.11.0',
        displayPath: '/workspace/folder1/.venv',
        environmentPath: Uri.file('/workspace/folder1/.venv'),
        sysPrefix: '/workspace/folder1/.venv',
        execInfo: { run: { executable: '/workspace/folder1/.venv/bin/python' } },
    };

    const mockVenvEnv2: PythonEnvironment = {
        envId: { id: 'venv-env-folder2', managerId: 'ms-python.python:venv' },
        name: 'Folder2 Venv',
        displayName: 'Folder2 Venv 3.12',
        version: '3.12.0',
        displayPath: '/workspace/folder2/.venv',
        environmentPath: Uri.file('/workspace/folder2/.venv'),
        sysPrefix: '/workspace/folder2/.venv',
        execInfo: { run: { executable: '/workspace/folder2/.venv/bin/python' } },
    };

    setup(() => {
        sandbox = sinon.createSandbox();

        mockVenvManager = {
            id: 'ms-python.python:venv',
            name: 'venv',
            displayName: 'Venv',
            get: sandbox.stub(),
            set: sandbox.stub().resolves(),
        } as unknown as sinon.SinonStubbedInstance<InternalEnvironmentManager>;

        mockSystemManager = {
            id: 'ms-python.python:system',
            name: 'system',
            displayName: 'System',
            get: sandbox.stub(),
            set: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<InternalEnvironmentManager>;

        mockEnvManagers = {
            getEnvironmentManager: sandbox.stub(),
            setEnvironment: sandbox.stub().resolves(),
            setEnvironments: sandbox.stub().resolves(),
            managers: [mockVenvManager, mockSystemManager],
        } as unknown as sinon.SinonStubbedInstance<EnvironmentManagers>;

        mockProjectManager = {
            get: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<PythonProjectManager>;

        mockNativeFinder = {
            resolve: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<NativePythonFinder>;

        mockApi = {
            resolveEnvironment: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<PythonEnvironmentApi>;

        mockEnvManagers.getEnvironmentManager.callsFake((scope: unknown) => {
            const id = typeof scope === 'string' ? scope : undefined;
            if (id === 'ms-python.python:venv') {
                return mockVenvManager;
            }
            if (id === 'ms-python.python:system') {
                return mockSystemManager;
            }
            return undefined;
        });
    });

    teardown(() => {
        sandbox.restore();
    });

    test('each folder should get its own local venv in multi-root workspace', async () => {
        // Setup: Two workspace folders, each with their own local venv
        sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([
            { uri: folder1Uri, name: 'folder1', index: 0 },
            { uri: folder2Uri, name: 'folder2', index: 1 },
        ]);
        sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
        sandbox.stub(helpers, 'getUserConfiguredSetting').returns(undefined);

        // Venv manager returns different venvs for each folder
        mockVenvManager.get.callsFake((scope: Uri | undefined) => {
            if (scope?.fsPath === folder1Uri.fsPath) {
                return Promise.resolve(mockVenvEnv1);
            }
            if (scope?.fsPath === folder2Uri.fsPath) {
                return Promise.resolve(mockVenvEnv2);
            }
            return Promise.resolve(undefined);
        });

        await applyInitialEnvironmentSelection(
            mockEnvManagers as unknown as EnvironmentManagers,
            mockProjectManager as unknown as PythonProjectManager,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        // Verify setEnvironment was called twice - once for each folder
        assert.strictEqual(
            mockEnvManagers.setEnvironment.callCount,
            2,
            'setEnvironment should be called for each folder',
        );

        // Verify first folder got its own venv (not overwritten)
        const firstCall = mockEnvManagers.setEnvironment.firstCall;
        const firstUri = firstCall.args[0] as Uri;
        assert.strictEqual(firstUri.fsPath, folder1Uri.fsPath, 'First call should be for folder1');
        assert.strictEqual(firstCall.args[1]?.envId.id, 'venv-env-folder1', 'Folder1 should get its own venv');

        // Verify second folder got its own venv
        const secondCall = mockEnvManagers.setEnvironment.secondCall;
        const secondUri = secondCall.args[0] as Uri;
        assert.strictEqual(secondUri.fsPath, folder2Uri.fsPath, 'Second call should be for folder2');
        assert.strictEqual(secondCall.args[1]?.envId.id, 'venv-env-folder2', 'Folder2 should get its own venv');

        // Both should NOT persist to settings
        assert.strictEqual(firstCall.args[2], false, 'First folder should not persist to settings');
        assert.strictEqual(secondCall.args[2], false, 'Second folder should not persist to settings');
    });

    test('first folder venv should not be overwritten when second folder has no venv', async () => {
        // This tests the scenario in issue #1145 where the first folder's venv gets overwritten
        sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([
            { uri: folder1Uri, name: 'folder1', index: 0 },
            { uri: folder2Uri, name: 'folder2', index: 1 },
        ]);
        sandbox.stub(workspaceApis, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
        sandbox.stub(helpers, 'getUserConfiguredSetting').returns(undefined);

        // First folder has a venv, second folder does not
        mockVenvManager.get.callsFake((scope: Uri | undefined) => {
            if (scope?.fsPath === folder1Uri.fsPath) {
                return Promise.resolve(mockVenvEnv1);
            }
            // folder2 has no local venv
            return Promise.resolve(undefined);
        });

        await applyInitialEnvironmentSelection(
            mockEnvManagers as unknown as EnvironmentManagers,
            mockProjectManager as unknown as PythonProjectManager,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        // Verify first folder still gets its own venv
        const firstCall = mockEnvManagers.setEnvironment.firstCall;
        const firstUri = firstCall.args[0] as Uri;
        assert.strictEqual(firstUri.fsPath, folder1Uri.fsPath);
        assert.strictEqual(firstCall.args[1]?.envId.id, 'venv-env-folder1', 'Folder1 venv should NOT be overwritten');

        // Second folder falls back to system (no local venv) - this is correct behavior
        const secondCall = mockEnvManagers.setEnvironment.secondCall;
        const secondUri = secondCall.args[0] as Uri;
        assert.strictEqual(secondUri.fsPath, folder2Uri.fsPath);
        // The second folder should get undefined (system fallback) since it has no venv
    });

    test('multi-root workspace respects per-folder pythonProjects settings', async () => {
        // Setup: Two folders with different pythonProjects[] settings
        const mockProject1: Partial<PythonProject> = { uri: folder1Uri, name: 'project1' };
        const mockProject2: Partial<PythonProject> = { uri: folder2Uri, name: 'project2' };

        sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns([
            { uri: folder1Uri, name: 'folder1', index: 0 },
            { uri: folder2Uri, name: 'folder2', index: 1 },
        ]);

        // Different pythonProjects settings for each folder
        // Use '.' as relative path - path.resolve(workspaceFolder, '.') equals workspaceFolder
        sandbox.stub(workspaceApis, 'getConfiguration').callsFake((_section?: string, scope?: unknown) => {
            const scopeUri = scope as Uri | undefined;
            if (scopeUri?.fsPath === folder1Uri.fsPath) {
                return createMockConfig([{ path: '.', envManager: 'ms-python.python:venv' }]) as WorkspaceConfiguration;
            }
            if (scopeUri?.fsPath === folder2Uri.fsPath) {
                return createMockConfig([
                    { path: '.', envManager: 'ms-python.python:system' },
                ]) as WorkspaceConfiguration;
            }
            return createMockConfig([]) as WorkspaceConfiguration;
        });

        mockProjectManager.get.callsFake((uri: Uri) => {
            if (uri.fsPath === folder1Uri.fsPath) {
                return mockProject1 as PythonProject;
            }
            if (uri.fsPath === folder2Uri.fsPath) {
                return mockProject2 as PythonProject;
            }
            return undefined;
        });

        sandbox.stub(workspaceApis, 'getWorkspaceFolder').callsFake((uri: Uri) => {
            if (uri.fsPath === folder1Uri.fsPath) {
                return { uri: folder1Uri, name: 'folder1', index: 0 } as WorkspaceFolder;
            }
            if (uri.fsPath === folder2Uri.fsPath) {
                return { uri: folder2Uri, name: 'folder2', index: 1 } as WorkspaceFolder;
            }
            return undefined;
        });

        sandbox.stub(helpers, 'getUserConfiguredSetting').returns(undefined);

        mockVenvManager.get.resolves(mockVenvEnv1);
        mockSystemManager.get.resolves(undefined);

        await applyInitialEnvironmentSelection(
            mockEnvManagers as unknown as EnvironmentManagers,
            mockProjectManager as unknown as PythonProjectManager,
            mockNativeFinder as unknown as NativePythonFinder,
            mockApi as unknown as PythonEnvironmentApi,
        );

        // Both folders should be processed independently
        assert.strictEqual(mockEnvManagers.setEnvironment.callCount, 2, 'Both folders should be processed');
    });
});
