// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import { Disposable, extensions, Uri } from 'vscode';
import {
    Capabilities,
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
    let packages: PackageManager;
    let capabilities: Capabilities<PackageCapability>;
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
        };
        const manager: EnvironmentManager = {
            name: 'capability-test-environment',
            preferredPackageManagerId: `${ENVS_EXTENSION_ID}:${packages.name}`,
            refresh: async () => {},
            getEnvironments: async () => [],
            get: async () => undefined,
            set: async () => {},
            resolve: async () => undefined,
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

    teardown(() => {
        disposables.splice(0).reverse().forEach((disposable) => disposable.dispose());
    });

    test('legacy structural providers receive defaults through the extension API', async () => {
        assert.deepStrictEqual(
            await api.getEnvironmentCapability(environmentManagerId, 'environments.list'),
            { supported: true },
        );
        assert.strictEqual(
            (await api.getEnvironmentCapability(environmentManagerId, 'environments.create')).supported,
            false,
        );
        assert.deepStrictEqual(await api.getPackageCapability(environment, 'packages.manage.install'), {
            supported: true,
        });
        assert.strictEqual((await api.getPackageCapability(environment, 'packages.direct')).supported, false);
        assert.strictEqual(manageCalls, 0);
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
