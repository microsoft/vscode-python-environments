// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import { Disposable, extensions, Uri } from 'vscode';
import {
    Capabilities,
    EnvironmentCapability,
    EnvironmentManager,
    PackageCapability,
    PackageManager,
    PythonEnvironment,
    PythonEnvironmentApi,
    resolvePackageManagerCapability,
} from '../../api';
import { ENVS_EXTENSION_ID } from '../constants';

suite('Manager capabilities integration', function () {
    this.timeout(60_000);
    let api: PythonEnvironmentApi;
    let environment: PythonEnvironment;
    let manager: EnvironmentManager;
    let packages: PackageManager;
    let capabilities: Capabilities<PackageCapability>;
    let environmentCapabilities: Capabilities<EnvironmentCapability>;
    let manageCalls: number;
    const disposables: Disposable[] = [];
    const environmentManagerId = `${ENVS_EXTENSION_ID}:capability-test-environment`;

    suiteSetup(async () => {
        const extension = extensions.getExtension<PythonEnvironmentApi>(ENVS_EXTENSION_ID);
        assert.ok(extension, 'Extension not found');
        api = extension.isActive ? extension.exports : await extension.activate();
        assert.ok(api, 'API not available');
    });

    setup(() => {
        capabilities = {};
        environmentCapabilities = {};
        manageCalls = 0;
        packages = {
            name: 'capability-test-packages',
            get capabilities() {
                return capabilities;
            },
            manage: async () => {
                manageCalls++;
            },
            refresh: async () => {},
            getPackages: async () => [],
            getDirectPackageNames: async () => {
                throw new Error('A capability query must not invoke the optional operation');
            },
        };
        manager = {
            name: 'capability-test-environment',
            get capabilities() {
                return environmentCapabilities;
            },
            preferredPackageManagerId: `${ENVS_EXTENSION_ID}:${packages.name}`,
            refresh: async () => {},
            getEnvironments: async () => [],
            get: async () => undefined,
            set: async () => {},
            resolve: async () => undefined,
            create: async () => {
                throw new Error('A capability query must not invoke the optional operation');
            },
            remove: async () => {
                throw new Error('A capability query must not invoke the optional operation');
            },
        };
        disposables.push(
            api.registerPackageManager(packages, { extensionId: ENVS_EXTENSION_ID }),
            api.registerEnvironmentManager(manager, { extensionId: ENVS_EXTENSION_ID }),
        );
        const uri = Uri.file('.');
        environment = api.createPythonEnvironmentItem(
            {
                name: 'capability-test',
                displayName: 'Capability test',
                displayPath: uri.fsPath,
                version: '3.12',
                environmentPath: uri,
                execInfo: { run: { executable: 'python' } },
                sysPrefix: uri.fsPath,
            },
            manager,
        );
    });

    test('optional hooks infer support while advertisements override it across the extension boundary', async () => {
        assert.deepStrictEqual(await api.getPackageCapability(environment, 'packages.direct'), { supported: true });
        const unsupported = { supported: false, reason: 'Disabled for test' } as const;
        capabilities = { 'packages.direct': async () => unsupported };
        assert.deepStrictEqual(await api.getPackageCapability(environment, 'packages.direct'), unsupported);
        capabilities = {};
        delete packages.getDirectPackageNames;
        assert.deepStrictEqual(await api.getPackageCapability(environment, 'packages.direct'), {
            supported: false,
            reason: 'Capability not implemented',
        });
        capabilities = { 'packages.direct': async () => ({ supported: true }) };
        assert.deepStrictEqual(await api.getPackageCapability(environment, 'packages.direct'), { supported: true });
    });

    test('quick creation infers legacy hooks while preserving contextual parent overrides', async () => {
        assert.strictEqual(
            (await api.getEnvironmentCapability(environmentManagerId, 'environments.create.quick')).supported,
            false,
        );
        manager.quickCreateConfig = () => {
            throw new Error('A capability query must not invoke quick-create metadata');
        };
        manager.clearCache = async () => {
            throw new Error('A capability query must not clear caches');
        };
        for (const key of ['environments.create.quick', 'environments.clearCache'] as const) {
            assert.deepStrictEqual(await api.getEnvironmentCapability(environmentManagerId, key), { supported: true });
        }
        const unsupported = { supported: false, reason: 'Creation disabled in this scope' } as const;
        environmentCapabilities = {
            'environments.create': async (context) => {
                assert.strictEqual(context.scope, 'global');
                return unsupported;
            },
        };
        assert.deepStrictEqual(
            await api.getEnvironmentCapability(environmentManagerId, 'environments.create.quick', { scope: 'global' }),
            unsupported,
        );
    });

    teardown(() => {
        disposables.splice(0).reverse().forEach((disposable) => disposable.dispose());
    });

    test('legacy structural providers receive defaults through the extension API', async () => {
        assert.deepStrictEqual(
            await api.getEnvironmentCapability(environmentManagerId, 'environments.list'),
            { supported: true },
        );
        for (const key of [
            'environments.create',
            'environments.create.additionalPackages',
            'environments.remove',
            'environments.remove.headless',
        ] as const) {
            assert.deepStrictEqual(await api.getEnvironmentCapability(environmentManagerId, key), { supported: true });
        }
        assert.strictEqual(
            (await api.getEnvironmentCapability(environmentManagerId, 'environments.create.quick')).supported,
            false,
        );
        assert.deepStrictEqual(await api.getPackageCapability(environment, 'packages.manage.install'), {
            supported: true,
        });
        assert.strictEqual((await api.getPackageCapability(environment, 'packages.direct')).supported, true);
        assert.strictEqual(manageCalls, 0);
    });

    test('explicit creation/removal opt-outs override raw methods and inherited options', async () => {
        const unsupported = { supported: false, reason: 'Disabled for test' } as const;
        environmentCapabilities = {
            'environments.create': async () => unsupported,
            'environments.remove': async () => unsupported,
        };
        for (const key of [
            'environments.create',
            'environments.create.additionalPackages',
            'environments.remove',
            'environments.remove.headless',
        ] as const) {
            assert.deepStrictEqual(await api.getEnvironmentCapability(environmentManagerId, key), unsupported);
        }
    });

    test('environment queries preserve explicit scope and reject contradictory ownership', async () => {
        const scopes = ['global', [Uri.file('first'), Uri.file('second')]] as const;
        for (const scope of scopes) {
            // Copy the URI tuple into the mutable array accepted by the existing scope contract.
            const queryScope = scope === 'global' ? scope : [...scope];
            environmentCapabilities = {
                'environments.create': async (context) => {
                    assert.strictEqual(context.scope, queryScope);
                    assert.strictEqual(context.environment, environment);
                    return { supported: true };
                },
            };
            assert.deepStrictEqual(
                await api.getEnvironmentCapability(environmentManagerId, 'environments.create', {
                    scope: queryScope,
                    environment,
                }),
                { supported: true },
            );
        }
        await assert.rejects(() =>
            api.getEnvironmentCapability(`${ENVS_EXTENSION_ID}:another-manager`, 'environments.list', {
                environment,
            }),
        );
    });

    test('uninstalled managers report unsupported without interaction', async () => {
        const support = await api.getEnvironmentCapability(
            'capability-tests.uninstalled:missing',
            'environments.list',
        );
        assert.strictEqual(support.supported, false);
        if (!support.supported) {
            assert.ok(support.reason);
        }
    });

    test('dynamic overrides and default prerequisites cross the extension boundary', async () => {
        let enabled = false;
        capabilities = {
            'packages.manage': async (context) => {
                assert.strictEqual(context.environment, environment);
                return enabled ? { supported: true } : { supported: false, reason: 'Disabled for test' };
            },
            'packages.manage.install': (context) =>
                resolvePackageManagerCapability(packages, 'packages.manage', context),
        };
        assert.deepStrictEqual(await api.getPackageCapability(environment, 'packages.manage.upgrade'), {
            supported: false,
            reason: 'Disabled for test',
        });
        enabled = true;
        assert.deepStrictEqual(await api.getPackageCapability(environment, 'packages.manage.upgrade'), {
            supported: true,
        });
        assert.strictEqual(manageCalls, 0);
    });

    test('prerequisite cycles are detected across separately loaded API modules', async () => {
        capabilities = {
            'packages.manage': (context) =>
                resolvePackageManagerCapability(packages, 'packages.manage.install', context),
        };
        await assert.rejects(
            () => api.getPackageCapability(environment, 'packages.manage'),
            /Capability dependency cycle/,
        );
    });

    test('unsupported advertisements do not enforce or change existing operations', async () => {
        capabilities = {
            'packages.manage': async () => ({ supported: false, reason: 'Advisory only' }),
        };
        assert.strictEqual((await api.getPackageCapability(environment, 'packages.manage')).supported, false);
        await api.managePackages(environment, { install: ['example'], runHeadless: true });
        assert.strictEqual(manageCalls, 1);
    });
});
