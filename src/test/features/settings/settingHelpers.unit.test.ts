/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from 'assert';
import * as sinon from 'sinon';
import { ConfigurationTarget } from 'vscode';
import * as workspaceApis from '../../../common/workspace.apis';
import { setAllManagerSettings, setEnvironmentManager, setPackageManager } from '../../../features/settings/settingHelpers';
import { MockWorkspaceConfiguration } from '../../mocks/mockWorkspaceConfig';

/**
 * These tests verify that settings are NOT written unnecessarily when:
 * 1. Setting the system manager (which is the implicit default/fallback)
 * 2. Setting pip package manager (the default)
 *
 * This prevents the bug where opening a non-Python repo with defaultInterpreterPath
 * set would write unwanted settings like "defaultEnvManager: system" to global settings.
 *
 * Note: These tests focus on the global settings path (project=undefined) because
 * workspace-scoped tests would require mocking workspace.getWorkspaceFolder which
 * cannot be easily stubbed in unit tests.
 */
suite('Setting Helpers - Avoid Unnecessary Settings Writes', () => {
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
                return (options.defaultEnvManagerGlobalValue ?? VENV_MANAGER_ID) as T;
            }
            if (key === 'defaultPackageManager') {
                return (options.defaultPackageManagerGlobalValue ?? PIP_MANAGER_ID) as T;
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
        test('should NOT write global defaultEnvManager when setting system manager with no existing setting', async () => {
            const mockConfig = createMockConfig({
                // No explicit global settings
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
            assert.strictEqual(
                envManagerUpdates.length,
                0,
                'Should NOT write global defaultEnvManager when setting system manager with no existing setting',
            );
        });

        test('should NOT write global defaultPackageManager when setting pip with no existing setting', async () => {
            const mockConfig = createMockConfig({
                // No explicit global settings
            });
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            await setAllManagerSettings([
                {
                    project: undefined, // Global scope
                    envManager: SYSTEM_MANAGER_ID,
                    packageManager: PIP_MANAGER_ID,
                },
            ]);

            const pkgManagerUpdates = updateCalls.filter(
                (c) => c.key === 'defaultPackageManager' && c.target === ConfigurationTarget.Global,
            );
            assert.strictEqual(
                pkgManagerUpdates.length,
                0,
                'Should NOT write global defaultPackageManager when setting pip with no existing setting',
            );
        });

        test('should write global defaultEnvManager when there is an existing global setting', async () => {
            const mockConfig = createMockConfig({
                defaultEnvManagerGlobalValue: VENV_MANAGER_ID, // Existing global setting
                defaultPackageManagerGlobalValue: PIP_MANAGER_ID,
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
            assert.strictEqual(
                envManagerUpdates.length,
                1,
                'Should write global defaultEnvManager when there is an existing global setting',
            );
            assert.strictEqual(envManagerUpdates[0].value, SYSTEM_MANAGER_ID);
        });

        test('should write global defaultEnvManager when setting NON-system manager (venv) with no existing setting', async () => {
            const mockConfig = createMockConfig({
                // No explicit global settings, but mock get to return system
            });
            // Override get to return system (so setting venv would be a change)
            (mockConfig as any).get = <T>(key: string): T | undefined => {
                if (key === 'defaultEnvManager') {
                    return SYSTEM_MANAGER_ID as T;
                }
                if (key === 'defaultPackageManager') {
                    return PIP_MANAGER_ID as T;
                }
                return undefined;
            };
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            await setAllManagerSettings([
                {
                    project: undefined,
                    envManager: VENV_MANAGER_ID, // Non-system manager
                    packageManager: PIP_MANAGER_ID,
                },
            ]);

            const envManagerUpdates = updateCalls.filter(
                (c) => c.key === 'defaultEnvManager' && c.target === ConfigurationTarget.Global,
            );
            assert.strictEqual(
                envManagerUpdates.length,
                1,
                'Should write global defaultEnvManager when setting venv (non-system) manager',
            );
            assert.strictEqual(envManagerUpdates[0].value, VENV_MANAGER_ID);
        });

        test('should write global defaultPackageManager when setting NON-pip manager (conda) with no existing setting', async () => {
            const mockConfig = createMockConfig({
                // No explicit global settings
            });
            // Override get to return current pip value 
            (mockConfig as any).get = <T>(key: string): T | undefined => {
                if (key === 'defaultEnvManager') {
                    return VENV_MANAGER_ID as T;
                }
                if (key === 'defaultPackageManager') {
                    return PIP_MANAGER_ID as T;
                }
                return undefined;
            };
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            await setAllManagerSettings([
                {
                    project: undefined,
                    envManager: VENV_MANAGER_ID, // Non-system manager to trigger pkg manager write
                    packageManager: CONDA_MANAGER_ID, // Non-pip manager
                },
            ]);

            const pkgManagerUpdates = updateCalls.filter(
                (c) => c.key === 'defaultPackageManager' && c.target === ConfigurationTarget.Global,
            );
            assert.strictEqual(
                pkgManagerUpdates.length,
                1,
                'Should write global defaultPackageManager when setting non-pip manager',
            );
            assert.strictEqual(pkgManagerUpdates[0].value, CONDA_MANAGER_ID);
        });
    });

    suite('setEnvironmentManager - Global Settings', () => {
        test('should NOT write when setting system manager with no existing global setting', async () => {
            const mockConfig = createMockConfig({
                // No existing settings
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
            assert.strictEqual(
                envManagerUpdates.length,
                0,
                'Should NOT write global defaultEnvManager for system manager with no existing setting',
            );
        });

        test('should write when there is an existing global setting', async () => {
            const mockConfig = createMockConfig({
                defaultEnvManagerGlobalValue: VENV_MANAGER_ID,
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
            assert.strictEqual(envManagerUpdates.length, 1, 'Should write when updating existing global setting');
        });
    });

    suite('setPackageManager - Global Settings', () => {
        test('should NOT write when setting pip manager with no existing global setting', async () => {
            const mockConfig = createMockConfig({
                // No existing settings
            });
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            await setPackageManager([
                {
                    project: undefined, // Global scope
                    packageManager: PIP_MANAGER_ID,
                },
            ]);

            const pkgManagerUpdates = updateCalls.filter(
                (c) => c.key === 'defaultPackageManager' && c.target === ConfigurationTarget.Global,
            );
            assert.strictEqual(
                pkgManagerUpdates.length,
                0,
                'Should NOT write global defaultPackageManager for pip manager with no existing setting',
            );
        });

        test('should write when there is an existing global setting', async () => {
            const mockConfig = createMockConfig({
                defaultPackageManagerGlobalValue: CONDA_MANAGER_ID,
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
            assert.strictEqual(pkgManagerUpdates.length, 1, 'Should write when updating existing global setting');
        });
    });
});

