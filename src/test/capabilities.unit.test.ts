// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import { Disposable, Uri } from 'vscode';
import {
    Capabilities,
    CapabilityContext,
    defaultEnvironmentCapabilities,
    defaultPackageCapabilities,
    EnvironmentManagerCapability,
    PackageManagerCapability,
    resolveEnvironmentManagerCapability,
    resolvePackageManagerCapability,
    Support,
} from '../capabilities';
import { InternalEnvironmentManager, InternalPackageManager } from '../managers/common/registeredManagers';
import type { EnvironmentManager, PackageManager, PythonProject } from '../types';

function unexpectedOperation(): never {
    throw new Error('A capability query must not invoke a manager operation');
}

function environmentManager(overrides: Partial<EnvironmentManager> = {}): EnvironmentManager {
    return {
        name: 'environment',
        preferredPackageManagerId: 'test:packages',
        refresh: async () => unexpectedOperation(),
        getEnvironments: async () => unexpectedOperation(),
        get: async () => unexpectedOperation(),
        set: async () => unexpectedOperation(),
        resolve: async () => unexpectedOperation(),
        ...overrides,
    };
}

function packageManager(overrides: Partial<PackageManager> = {}): PackageManager {
    return {
        name: 'packages',
        manage: async () => unexpectedOperation(),
        refresh: async () => unexpectedOperation(),
        getPackages: async () => unexpectedOperation(),
        ...overrides,
    };
}

const environmentDefaults: Record<EnvironmentManagerCapability, boolean> = {
    'environments.list': true,
    'environments.refresh': true,
    'environments.resolve': true,
    'environments.getSelected': true,
    'environments.setSelected': true,
    'environments.create': false,
    'environments.create.quick': false,
    'environments.create.additionalPackages': false,
    'environments.remove': false,
    'environments.remove.headless': false,
    'environments.clearCache': false,
    'environments.events.changed': false,
    'environments.events.selectionChanged': false,
};

const packageDefaults: Record<PackageManagerCapability, boolean> = {
    'packages.list': true,
    'packages.list.skipCache': true,
    'packages.refresh': true,
    'packages.manage': true,
    'packages.manage.install': true,
    'packages.manage.uninstall': true,
    'packages.manage.upgrade': true,
    'packages.manage.headless': true,
    'packages.manage.showSkipOption': true,
    'packages.direct': false,
    'packages.version': false,
    'packages.availableVersions': false,
    'packages.formatInstallSpec': true,
    'packages.clearCache': false,
    'packages.watchTargets': false,
    'packages.events.changed': false,
};

suite('Manager capabilities', () => {
    const unsupported: Support = { supported: false, reason: 'Not supported by this provider' };

    for (const key of Object.keys(environmentDefaults) as EnvironmentManagerCapability[]) {
        test(`environment default and explicit overrides: ${key}`, async () => {
            for (const capabilities of [undefined, {}]) {
                const manager = environmentManager({ capabilities });
                const result = await resolveEnvironmentManagerCapability(manager, key);
                assert.strictEqual(result.supported, environmentDefaults[key]);
                if (!result.supported) {
                    assert.strictEqual(result.reason, 'Capability not implemented');
                }
                assert.strictEqual(manager.capabilities, capabilities);
            }
            assert.deepStrictEqual(
                await resolveEnvironmentManagerCapability(
                    environmentManager({ capabilities: { [key]: async () => unsupported } }),
                    key,
                ),
                unsupported,
            );
            assert.deepStrictEqual(
                await resolveEnvironmentManagerCapability(
                    environmentManager({ capabilities: { [key]: async () => ({ supported: true }) } }),
                    key,
                ),
                { supported: true },
            );
        });
    }

    for (const key of Object.keys(packageDefaults) as PackageManagerCapability[]) {
        test(`package default and explicit overrides: ${key}`, async () => {
            for (const capabilities of [undefined, {}]) {
                const manager = packageManager({ capabilities });
                const result = await resolvePackageManagerCapability(manager, key);
                assert.strictEqual(result.supported, packageDefaults[key]);
                if (!result.supported) {
                    assert.strictEqual(result.reason, 'Capability not implemented');
                }
                assert.strictEqual(manager.capabilities, capabilities);
            }
            assert.deepStrictEqual(
                await resolvePackageManagerCapability(
                    packageManager({ capabilities: { [key]: async () => unsupported } }),
                    key,
                ),
                unsupported,
            );
            assert.deepStrictEqual(
                await resolvePackageManagerCapability(
                    packageManager({ capabilities: { [key]: async () => ({ supported: true }) } }),
                    key,
                ),
                { supported: true },
            );
        });
    }

    test('catalogs contain exactly the inventoried 29 keys', () => {
        assert.deepStrictEqual(Object.keys(defaultEnvironmentCapabilities), Object.keys(environmentDefaults));
        assert.deepStrictEqual(Object.keys(defaultPackageCapabilities), Object.keys(packageDefaults));
        assert.strictEqual(Object.keys(environmentDefaults).length + Object.keys(packageDefaults).length, 29);
        assert.ok(Object.isFrozen(defaultEnvironmentCapabilities));
        assert.ok(Object.isFrozen(defaultPackageCapabilities));
    });

    test('optional capabilities follow raw hooks without invoking operations or subscribing to events', async () => {
        const env = environmentManager({
            create: async () => unexpectedOperation(),
            quickCreateConfig: unexpectedOperation,
            remove: async () => unexpectedOperation(),
            clearCache: async () => unexpectedOperation(),
            onDidChangeEnvironments: unexpectedOperation,
            onDidChangeEnvironment: unexpectedOperation,
        });
        const pkg = packageManager({
            getDirectPackageNames: async () => unexpectedOperation(),
            getVersion: async () => unexpectedOperation(),
            getPackageAvailableVersions: async () => unexpectedOperation(),
            clearCache: async () => unexpectedOperation(),
            getPackageWatchTargets: unexpectedOperation,
            onDidChangePackages: unexpectedOperation,
        });
        const wrapped = new InternalEnvironmentManager('test:environment', env);
        for (const key of Object.keys(environmentDefaults) as EnvironmentManagerCapability[]) {
            assert.strictEqual((await resolveEnvironmentManagerCapability(env, key)).supported, true, key);
            assert.strictEqual((await wrapped.getCapability(key)).supported, true, key);
        }
        for (const key of Object.keys(packageDefaults) as PackageManagerCapability[]) {
            assert.strictEqual((await resolvePackageManagerCapability(pkg, key)).supported, true, key);
        }
    });

    for (const [key, hook] of [
        ['environments.clearCache', 'clearCache'],
        ['environments.events.changed', 'onDidChangeEnvironments'],
        ['environments.events.selectionChanged', 'onDidChangeEnvironment'],
    ] as const) {
        test(`${key} follows only its own raw hook and preserves overrides`, async () => {
            const manager = environmentManager({ [hook]: unexpectedOperation });
            assert.deepStrictEqual(await resolveEnvironmentManagerCapability(manager, key), { supported: true });
            assert.deepStrictEqual(
                await resolveEnvironmentManagerCapability(
                    environmentManager({ ...manager, capabilities: { [key]: async () => unsupported } }),
                    key,
                ),
                unsupported,
            );
            const failure = new Error('Capability probe failed');
            await assert.rejects(
                resolveEnvironmentManagerCapability(
                    environmentManager({ ...manager, capabilities: { [key]: async () => { throw failure; } } }),
                    key,
                ),
                (error) => error === failure,
            );
            delete manager[hook];
            assert.strictEqual((await resolveEnvironmentManagerCapability(manager, key)).supported, false);
        });
    }

    for (const [key, hook] of [
        ['packages.direct', 'getDirectPackageNames'],
        ['packages.version', 'getVersion'],
        ['packages.availableVersions', 'getPackageAvailableVersions'],
        ['packages.clearCache', 'clearCache'],
        ['packages.watchTargets', 'getPackageWatchTargets'],
        ['packages.events.changed', 'onDidChangePackages'],
    ] as const) {
        test(`${key} follows only its own raw hook and preserves overrides`, async () => {
            const manager = packageManager({ [hook]: unexpectedOperation });
            assert.deepStrictEqual(await resolvePackageManagerCapability(manager, key), { supported: true });
            assert.deepStrictEqual(
                await resolvePackageManagerCapability(
                    packageManager({ ...manager, capabilities: { [key]: async () => unsupported } }),
                    key,
                ),
                unsupported,
            );
            const failure = new Error('Capability probe failed');
            await assert.rejects(
                resolvePackageManagerCapability(
                    packageManager({ ...manager, capabilities: { [key]: async () => { throw failure; } } }),
                    key,
                ),
                (error) => error === failure,
            );
            delete manager[hook];
            assert.strictEqual((await resolvePackageManagerCapability(manager, key)).supported, false);
        });
    }

    test('creation and removal defaults independently follow current raw method availability', async () => {
        const manager = environmentManager({ create: async () => unexpectedOperation(), capabilities: {} });
        assert.strictEqual((await resolveEnvironmentManagerCapability(manager, 'environments.create')).supported, true);
        assert.strictEqual((await resolveEnvironmentManagerCapability(manager, 'environments.remove')).supported, false);
        delete manager.create;
        manager.remove = async () => unexpectedOperation();
        assert.strictEqual((await resolveEnvironmentManagerCapability(manager, 'environments.create')).supported, false);
        assert.strictEqual((await resolveEnvironmentManagerCapability(manager, 'environments.remove')).supported, true);
    });

    test('default child checks preserve explicit parent opt-outs', async () => {
        const env = environmentManager({
            create: async () => unexpectedOperation(),
            quickCreateConfig: unexpectedOperation,
            remove: async () => unexpectedOperation(),
            capabilities: {
                'environments.create': async () => unsupported,
                'environments.remove': async () => unsupported,
            },
        });
        for (const key of [
            'environments.create',
            'environments.create.quick',
            'environments.create.additionalPackages',
            'environments.remove',
            'environments.remove.headless',
        ] as const) {
            assert.strictEqual(await resolveEnvironmentManagerCapability(env, key), unsupported);
        }
        const pkg = packageManager({
            capabilities: {
                'packages.list': async () => unsupported,
                'packages.manage': async () => unsupported,
            },
        });
        for (const key of [
            'packages.list.skipCache',
            'packages.manage.install',
            'packages.manage.uninstall',
            'packages.manage.upgrade',
            'packages.manage.headless',
            'packages.manage.showSkipOption',
        ] as const) {
            assert.strictEqual(await resolvePackageManagerCapability(pkg, key), unsupported);
        }
    });

    test('optional parent opt-ins enable inherited options including the legacy quick path', async () => {
        const manager = environmentManager({
            create: async () => unexpectedOperation(),
            quickCreateConfig: unexpectedOperation,
            remove: async () => unexpectedOperation(),
            capabilities: {
                'environments.create': async () => ({ supported: true }),
                'environments.remove': async () => ({ supported: true }),
            },
        });
        for (const key of [
            'environments.create.quick',
            'environments.create.additionalPackages',
            'environments.remove.headless',
        ] as const) {
            assert.deepStrictEqual(await resolveEnvironmentManagerCapability(manager, key), { supported: true });
        }
    });

    test('quick creation requires both raw hooks unless explicitly advertised', async () => {
        for (const hooks of [
            {},
            { create: unexpectedOperation },
            { quickCreateConfig: unexpectedOperation },
        ]) {
            const manager = environmentManager({
                ...hooks,
                capabilities: { 'environments.create': async () => ({ supported: true }) },
            });
            assert.deepStrictEqual(await resolveEnvironmentManagerCapability(manager, 'environments.create.quick'), {
                supported: false,
                reason: 'Capability not implemented',
            });
        }
        const hooks = { create: unexpectedOperation, quickCreateConfig: unexpectedOperation };
        assert.deepStrictEqual(
            await resolveEnvironmentManagerCapability(
                environmentManager({
                    ...hooks,
                    capabilities: { 'environments.create.quick': async () => unsupported },
                }),
                'environments.create.quick',
            ),
            unsupported,
        );
        const failure = new Error('Create support probe failed');
        await assert.rejects(
            resolveEnvironmentManagerCapability(
                environmentManager({
                    ...hooks,
                    capabilities: { 'environments.create': async () => { throw failure; } },
                }),
                'environments.create.quick',
            ),
            (error) => error === failure,
        );
        assert.deepStrictEqual(
            await resolveEnvironmentManagerCapability(
                environmentManager({
                    create: unexpectedOperation,
                    capabilities: { 'environments.create.quick': async () => ({ supported: true }) },
                }),
                'environments.create.quick',
            ),
            { supported: true },
        );
    });

    test('explicit child advertisements decide their own prerequisites', async () => {
        const manager = packageManager({
            capabilities: {
                'packages.manage': async () => unsupported,
                'packages.manage.install': async () => ({ supported: true }),
            },
        });
        assert.deepStrictEqual(await resolvePackageManagerCapability(manager, 'packages.manage.upgrade'), {
            supported: true,
        });
    });

    test('unknown runtime keys and prototype properties are unsupported', async () => {
        for (const key of ['future.capability', 'toString', 'constructor', '__proto__']) {
            assert.deepStrictEqual(
                await Reflect.apply(resolvePackageManagerCapability, undefined, [packageManager(), key]),
                { supported: false, reason: 'Capability not implemented' },
            );
            assert.deepStrictEqual(
                await Reflect.apply(resolveEnvironmentManagerCapability, undefined, [environmentManager(), key]),
                { supported: false, reason: 'Capability not implemented' },
            );
        }
    });

    test('unexpected sync and async checker failures propagate without fallback', async () => {
        const error = new Error('Version probe failed');
        const manager = packageManager({
            capabilities: {
                'packages.list': () => {
                    throw error;
                },
                'packages.manage': async () => {
                    throw error;
                },
            },
        });
        await assert.rejects(() => resolvePackageManagerCapability(manager, 'packages.list'), (e) => e === error);
        await assert.rejects(() => resolvePackageManagerCapability(manager, 'packages.manage'), (e) => e === error);
    });

    test('supports frozen input context and preserves its values through prerequisites', async () => {
        const project: PythonProject = { name: 'project', uri: Uri.file('.') };
        const context: CapabilityContext = Object.freeze({ project, scope: 'global' });
        const manager = packageManager({
            capabilities: {
                'packages.manage': async (received) => {
                    assert.strictEqual(received.project, project);
                    assert.strictEqual(received.scope, context.scope);
                    return { supported: true };
                },
            },
        });
        assert.deepStrictEqual(await resolvePackageManagerCapability(manager, 'packages.manage.upgrade', context), {
            supported: true,
        });
        assert.deepStrictEqual(Reflect.ownKeys(context), ['project', 'scope']);
    });

    test('detects self and indirect cycles with a useful chain', async () => {
        const manager = packageManager();
        const capabilities: Capabilities<PackageManagerCapability> = {
            'packages.list': (context) => resolvePackageManagerCapability(manager, 'packages.list', context),
            'packages.manage': (context) => resolvePackageManagerCapability(manager, 'packages.manage.upgrade', context),
        };
        const cyclic = Object.assign(manager, { capabilities });
        await assert.rejects(
            () => resolvePackageManagerCapability(cyclic, 'packages.list'),
            /packages.list -> packages.list/,
        );
        await assert.rejects(
            () => resolvePackageManagerCapability(cyclic, 'packages.manage'),
            /packages.manage -> packages.manage.upgrade -> packages.manage.install -> packages.manage/,
        );
    });

    test('parallel sibling prerequisites and concurrent queries are not cycles', async () => {
        const manager = packageManager({
            capabilities: {
                'packages.manage': async (context) => {
                    const results = await Promise.all([
                        resolvePackageManagerCapability(manager, 'packages.list', context),
                        resolvePackageManagerCapability(manager, 'packages.list', context),
                    ]);
                    return results[0];
                },
                'packages.list': async () => {
                    await Promise.resolve();
                    return { supported: true };
                },
            },
        });
        const context = {};
        assert.deepStrictEqual(
            await Promise.all([
                resolvePackageManagerCapability(manager, 'packages.manage', context),
                resolvePackageManagerCapability(manager, 'packages.manage', context),
            ]),
            [{ supported: true }, { supported: true }],
        );
    });

    test('same key on a different manager does not constitute a cycle', async () => {
        const other = packageManager();
        const manager = packageManager({
            capabilities: {
                'packages.list': (context) => resolvePackageManagerCapability(other, 'packages.list', context),
            },
        });
        assert.deepStrictEqual(await resolvePackageManagerCapability(manager, 'packages.list'), { supported: true });
    });

    test('arrow advertisements retain their instance when extracted and are not cached', async () => {
        class Advertiser {
            enabled = false;
            readonly capabilities: Capabilities<PackageManagerCapability> = {
                'packages.list': async () => (this.enabled ? { supported: true } : unsupported),
            };
        }
        const advertiser = new Advertiser();
        const check = advertiser.capabilities['packages.list']!;
        assert.strictEqual(await check({}), unsupported);
        const manager = packageManager({ capabilities: advertiser.capabilities });
        assert.strictEqual(await resolvePackageManagerCapability(manager, 'packages.list'), unsupported);
        advertiser.enabled = true;
        assert.deepStrictEqual(await check({}), { supported: true });
        assert.deepStrictEqual(await resolvePackageManagerCapability(manager, 'packages.list'), { supported: true });
    });

    test('wrapper fallbacks do not enable optional capabilities', async () => {
        const env = new InternalEnvironmentManager('test:environment', environmentManager());
        const pkg = new InternalPackageManager('test:packages', packageManager());
        for (const key of Object.keys(environmentDefaults) as EnvironmentManagerCapability[]) {
            assert.strictEqual((await env.getCapability(key)).supported, environmentDefaults[key]);
        }
        for (const key of Object.keys(packageDefaults) as PackageManagerCapability[]) {
            assert.strictEqual((await pkg.getCapability(key)).supported, packageDefaults[key]);
        }
        pkg.dispose();
    });

    test('package wrapper queries infer raw hooks without invoking operations or subscribing to events', async () => {
        const manager = packageManager({
            getDirectPackageNames: unexpectedOperation,
            getVersion: unexpectedOperation,
            getPackageAvailableVersions: unexpectedOperation,
            clearCache: unexpectedOperation,
            getPackageWatchTargets: unexpectedOperation,
            onDidChangePackages: unexpectedOperation,
        });
        const wrapped = new InternalPackageManager('test:packages', manager);
        try {
            for (const key of Object.keys(packageDefaults) as PackageManagerCapability[]) {
                assert.deepStrictEqual(await wrapped.getCapability(key), { supported: true }, key);
            }
        } finally {
            wrapped.dispose();
        }
    });

    test('package wrapper queries retain project-bound closures and reject disposal', async () => {
        let disposed = 0;
        const makeScoped = (project?: PythonProject): PackageManager =>
            packageManager({
                createForProject: makeScoped,
                capabilities: {
                    'packages.direct': async (context) => ({
                        supported: context.project === project && project !== undefined,
                        reason: 'Project context required',
                    }),
                },
                dispose: () => {
                    disposed++;
                },
                onDidChangePackages: () => new Disposable(() => {}),
            });
        const root = new InternalPackageManager('test:packages', makeScoped());
        const a: PythonProject = { name: 'A', uri: Uri.file('A') };
        const b: PythonProject = { name: 'B', uri: Uri.file('B') };
        const scopedA = root.createForProject!(a);
        const scopedB = root.createForProject!(b);
        assert.strictEqual((await root.getCapability('packages.direct')).supported, false);
        assert.strictEqual((await scopedA.getCapability('packages.direct')).supported, true);
        assert.strictEqual((await scopedB.getCapability('packages.direct')).supported, true);
        assert.strictEqual((await scopedA.getCapability('packages.direct', { project: b })).supported, true);
        scopedA.dispose();
        assert.throws(() => scopedA.getCapability('packages.direct'), /disposed/);
        assert.strictEqual(disposed, 1);
        assert.strictEqual((await scopedB.getCapability('packages.direct')).supported, true);
        root.dispose();
        scopedB.dispose();
    });
});
