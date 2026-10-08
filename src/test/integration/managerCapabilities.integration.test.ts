// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import { ConfigurationTarget, Disposable, extensions, Uri, workspace } from 'vscode';
import {
    Capabilities,
    EnvironmentManager,
    EnvironmentManagerCapability,
    PackageManager,
    PackageManagerCapability,
    PythonEnvironment,
    PythonEnvironmentApi,
    resolvePackageManagerCapability,
} from '../../api';
import { ENVS_EXTENSION_ID } from '../constants';

// Minimal advertisements used by these tests. Only the keys a test cares about need overriding;
// every other key resolves unsupported, matching the no-defaults contract providers must honor.
const noPackageCapabilities: Capabilities<PackageManagerCapability> = {} as Capabilities<PackageManagerCapability>;
const noEnvironmentCapabilities: Capabilities<EnvironmentManagerCapability> =
    {} as Capabilities<EnvironmentManagerCapability>;

suite('Manager capabilities integration', function () {
    this.timeout(60_000);
    let api: PythonEnvironmentApi;
    let environment: PythonEnvironment;
    let packages: PackageManager;
    let packageCapabilities: Capabilities<PackageManagerCapability>;
    let environmentCapabilities: Capabilities<EnvironmentManagerCapability>;
    const disposables: Disposable[] = [];

    suiteSetup(async () => {
        const extension = extensions.getExtension<PythonEnvironmentApi>(ENVS_EXTENSION_ID);
        assert.ok(extension, 'Extension not found');
        api = extension.isActive ? extension.exports : await extension.activate();
        assert.ok(api, 'API not available');
    });

    setup(() => {
        packageCapabilities = noPackageCapabilities;
        environmentCapabilities = noEnvironmentCapabilities;
        packages = {
            name: 'capability-test-packages',
            get capabilities() {
                return packageCapabilities;
            },
            manage: async () => assert.fail('Capability queries must not manage packages'),
            refresh: async () => {},
            getPackages: async () => [],
        };
        const manager: EnvironmentManager = {
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

    test('environment queries resolve unsupported when not advertised, and honor provider overrides', async () => {
        assert.deepStrictEqual(
            await api.getEnvironmentManagerCapability(environment.envId.managerId, 'environments.list'),
            { supported: false, reason: 'Capability not implemented' },
        );
        const unsupported = { supported: false, reason: 'Disabled in this scope' } as const;
        environmentCapabilities = {
            ...noEnvironmentCapabilities,
            'environments.list': async (context) => {
                assert.strictEqual(context.scope, 'global');
                return unsupported;
            },
        };
        assert.deepStrictEqual(
            await api.getEnvironmentManagerCapability(environment.envId.managerId, 'environments.list', { scope: 'global' }),
            unsupported,
        );
    });

    test('package queries reach the configured project-bound provider, not its root', async () => {
        const folder = workspace.workspaceFolders?.[0];
        assert.ok(folder, 'The integration workspace must be open');
        const project = api.getPythonProject(folder.uri);
        assert.ok(project, 'The workspace project must be registered');
        const scopedSupport = { supported: false, reason: 'Project-bound provider response' } as const;
        const provider: PackageManager = {
            ...packages,
            name: 'capability-test-scoped',
            capabilities: {
                ...noPackageCapabilities,
                'packages.list': async () => assert.fail('The unbound root must not be queried'),
            },
            createForProject: (boundProject) => ({
                ...packages,
                name: 'capability-test-scoped',
                capabilities: {
                    ...noPackageCapabilities,
                    'packages.list': async (context) => {
                        assert.strictEqual(boundProject.uri.toString(), project.uri.toString());
                        assert.strictEqual(context.project, boundProject);
                        assert.strictEqual(context.environment, environment);
                        return scopedSupport;
                    },
                },
            }),
        };
        disposables.push(api.registerPackageManager(provider, { extensionId: ENVS_EXTENSION_ID }));
        const config = workspace.getConfiguration('python-envs', folder.uri);
        const target = workspace.workspaceFolders?.length === 1 ? ConfigurationTarget.Workspace : ConfigurationTarget.WorkspaceFolder;
        const inspected = config.inspect<unknown[]>('pythonProjects');
        const previous = target === ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.workspaceFolderValue;
        try {
            await config.update('pythonProjects', [
                { path: '.', packageManager: `${ENVS_EXTENSION_ID}:${provider.name}` },
                ...config.get<unknown[]>('pythonProjects', []),
            ], target);
            assert.deepStrictEqual(
                await api.getPackageManagerCapability(environment, 'packages.list', project),
                scopedSupport,
            );
        } finally {
            await config.update('pythonProjects', previous, target);
        }
    });

    test('package prerequisites preserve context and reasons across separately loaded modules', async () => {
        const denied = { supported: false, reason: 'Disabled by provider' } as const;
        packageCapabilities = {
            ...noPackageCapabilities,
            'packages.manage': async (context) => {
                assert.strictEqual(context.environment, environment);
                return denied;
            },
            'packages.manage.install': (context) =>
                resolvePackageManagerCapability(packages, 'packages.manage', context),
        };
        assert.deepStrictEqual(await api.getPackageManagerCapability(environment, 'packages.manage.install'), denied);
    });
});
