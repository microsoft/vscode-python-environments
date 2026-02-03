/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from 'assert';
import * as sinon from 'sinon';
import { ConfigurationTarget } from 'vscode';
import * as workspaceApis from '../../../common/workspace.apis';
import {
    setAllManagerSettings,
    setEnvironmentManager,
    setPackageManager,
} from '../../../features/settings/settingHelpers';
import { MockWorkspaceConfiguration } from '../../mocks/mockWorkspaceConfig';

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
