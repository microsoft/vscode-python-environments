// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { ConfigurationChangeEvent, Uri, workspace, WorkspaceConfiguration, WorkspaceFolder } from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi, PythonProject } from '../../api';
import * as workspaceApis from '../../common/workspace.apis';
import {
    applyInitialEnvironmentSelection,
    registerInterpreterSettingsChangeListener,
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
            sandbox.stub(workspace, 'getConfiguration').returns(
                createMockConfig([
                    {
                        path: '/test/workspace',
                        envManager: 'ms-python.python:venv',
                        packageManager: 'ms-python.python:pip',
                    },
                ]) as WorkspaceConfiguration,
            );
            const mockProject: Partial<PythonProject> = { uri: testUri, name: 'test' };
            mockProjectManager.get.returns(mockProject as PythonProject);
            const mockWorkspaceFolder: Partial<WorkspaceFolder> = { uri: testUri };
            sandbox.stub(workspace, 'getWorkspaceFolder').returns(mockWorkspaceFolder as WorkspaceFolder);
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
            sandbox.stub(workspace, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
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
            sandbox.stub(workspace, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
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
            sandbox.stub(workspace, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
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

        test('should fall through to Priority 4 when defaultInterpreterPath cannot be resolved', async () => {
            sandbox.stub(workspace, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
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

            sandbox.stub(workspace, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
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
                userPyenvPath,
                'environmentPath should use user configured path',
            );
        });
    });

    suite('Priority 4: Auto-discovery', () => {
        test('should use local venv when found', async () => {
            sandbox.stub(workspace, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
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
            sandbox.stub(workspace, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
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
            sandbox.stub(workspace, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
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
            sandbox.stub(workspace, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
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
            sandbox.stub(workspace, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
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
            sandbox.stub(workspace, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
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
        sandbox.stub(workspace, 'workspaceFolders').value([{ uri: testUri, name: 'test', index: 0 }]);
        sandbox.stub(workspace, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
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
        sandbox.stub(workspace, 'workspaceFolders').value([
            { uri: uri1, name: 'workspace1', index: 0 },
            { uri: uri2, name: 'workspace2', index: 1 },
        ]);
        sandbox.stub(workspace, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
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
        sandbox.stub(workspace, 'workspaceFolders').value([]);
        sandbox.stub(workspace, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
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

        sandbox.stub(workspace, 'workspaceFolders').value([{ uri: testUri, name: 'test', index: 0 }]);
        sandbox.stub(workspace, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
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

        sandbox.stub(workspace, 'workspaceFolders').value([{ uri: testUri, name: 'test', index: 0 }]);
        sandbox.stub(workspace, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
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

        sandbox.stub(workspace, 'workspaceFolders').value([{ uri: testUri, name: 'test', index: 0 }]);
        sandbox.stub(workspace, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
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

        sandbox.stub(workspace, 'workspaceFolders').value([{ uri: testUri, name: 'test', index: 0 }]);
        sandbox.stub(workspace, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
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
        sandbox.stub(workspace, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
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
        sandbox.stub(workspace, 'getConfiguration').returns(
            createMockConfig([
                {
                    path: '/test/workspace',
                    envManager: 'ms-python.python:venv', // Project says venv
                    packageManager: 'ms-python.python:pip',
                },
            ]) as WorkspaceConfiguration,
        );
        const mockProject: Partial<PythonProject> = { uri: testUri, name: 'test' };
        mockProjectManager.get.returns(mockProject as PythonProject);
        const mockWorkspaceFolder: Partial<WorkspaceFolder> = { uri: testUri };
        sandbox.stub(workspace, 'getWorkspaceFolder').returns(mockWorkspaceFolder as WorkspaceFolder);

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
        sandbox.stub(workspace, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
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
        sandbox.stub(workspace, 'workspaceFolders').value([
            { uri: folder1Uri, name: 'folder1', index: 0 },
            { uri: folder2Uri, name: 'folder2', index: 1 },
        ]);
        sandbox.stub(workspace, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
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
        sandbox.stub(workspace, 'workspaceFolders').value([
            { uri: folder1Uri, name: 'folder1', index: 0 },
            { uri: folder2Uri, name: 'folder2', index: 1 },
        ]);
        sandbox.stub(workspace, 'getConfiguration').returns(createMockConfig([]) as WorkspaceConfiguration);
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

        sandbox.stub(workspace, 'workspaceFolders').value([
            { uri: folder1Uri, name: 'folder1', index: 0 },
            { uri: folder2Uri, name: 'folder2', index: 1 },
        ]);

        // Different pythonProjects settings for each folder
        sandbox.stub(workspace, 'getConfiguration').callsFake((_section?: string, scope?: unknown) => {
            const scopeUri = scope as Uri | undefined;
            if (scopeUri?.fsPath === folder1Uri.fsPath) {
                return createMockConfig([
                    { path: '/workspace/folder1', envManager: 'ms-python.python:venv' },
                ]) as WorkspaceConfiguration;
            }
            if (scopeUri?.fsPath === folder2Uri.fsPath) {
                return createMockConfig([
                    { path: '/workspace/folder2', envManager: 'ms-python.python:system' },
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

        sandbox.stub(workspace, 'getWorkspaceFolder').callsFake((uri: Uri) => {
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
