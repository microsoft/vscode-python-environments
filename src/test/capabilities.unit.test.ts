// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import { l10n, Uri } from 'vscode';
import {
    CapabilityContext,
    defaultEnvironmentCapabilities,
    defaultPackageCapabilities,
    EnvironmentManagerCapability,
    PackageManagerCapability,
    resolveEnvironmentManagerCapability as environmentCapability,
    resolvePackageManagerCapability as packageCapability,
    Support,
} from '../capabilities';
import { InternalEnvironmentManager, InternalPackageManager } from '../managers/common/registeredManagers';
import type { EnvironmentManager, PackageManager } from '../types';

function unexpectedOperation(): never {
    throw new Error('A capability query must not invoke a manager operation');
}

function environmentManager(overrides: Partial<EnvironmentManager> = {}): EnvironmentManager {
    return {
        name: 'environment',
        preferredPackageManagerId: 'test:packages',
        refresh: unexpectedOperation,
        getEnvironments: unexpectedOperation,
        get: unexpectedOperation,
        set: unexpectedOperation,
        resolve: unexpectedOperation,
        ...overrides,
    };
}

function packageManager(overrides: Partial<PackageManager> = {}): PackageManager {
    return {
        name: 'packages',
        manage: unexpectedOperation,
        refresh: unexpectedOperation,
        getPackages: unexpectedOperation,
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
    const supported: Support = { supported: true };
    const notImplemented: Support = { supported: false, reason: l10n.t('Capability not implemented') };
    const denied: Support = { supported: false, reason: 'Disabled by provider' };

    suite('Defaults', () => {
        for (const key of Object.keys(environmentDefaults) as EnvironmentManagerCapability[]) {
            test(`environment default: ${key}`, async () => {
                for (const capabilities of [undefined, {}]) {
                    const manager = environmentManager({ capabilities });
                    assert.deepStrictEqual(
                        await environmentCapability(manager, key),
                        environmentDefaults[key] ? supported : notImplemented,
                    );
                    assert.strictEqual(manager.capabilities, capabilities);
                }
            });
        }

        for (const key of Object.keys(packageDefaults) as PackageManagerCapability[]) {
            test(`package default: ${key}`, async () => {
                for (const capabilities of [undefined, {}]) {
                    const manager = packageManager({ capabilities });
                    assert.deepStrictEqual(
                        await packageCapability(manager, key),
                        packageDefaults[key] ? supported : notImplemented,
                    );
                    assert.strictEqual(manager.capabilities, capabilities);
                }
            });
        }

        test('expectation tables cover the read-only catalogs', () => {
            assert.deepStrictEqual(new Set(Object.keys(defaultEnvironmentCapabilities)), new Set(Object.keys(environmentDefaults)));
            assert.deepStrictEqual(new Set(Object.keys(defaultPackageCapabilities)), new Set(Object.keys(packageDefaults)));
            assert.ok(Object.isFrozen(defaultEnvironmentCapabilities));
            assert.ok(Object.isFrozen(defaultPackageCapabilities));
        });

        for (const [key, hook] of [
            ['environments.create', 'create'],
            ['environments.remove', 'remove'],
            ['environments.clearCache', 'clearCache'],
            ['environments.events.changed', 'onDidChangeEnvironments'],
            ['environments.events.selectionChanged', 'onDidChangeEnvironment'],
        ] as const) {
            test(`${key} detects its raw hook without calling it`, async () => {
                const manager = environmentManager({ [hook]: unexpectedOperation });
                assert.deepStrictEqual(await environmentCapability(manager, key), supported);
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
            test(`${key} detects its raw hook without calling it`, async () => {
                const manager = packageManager({ [hook]: unexpectedOperation });
                assert.deepStrictEqual(await packageCapability(manager, key), supported);
            });
        }

        test('unknown runtime keys cannot resolve inherited object properties', async () => {
            for (const key of ['future.capability', 'toString', 'constructor', '__proto__']) {
                assert.deepStrictEqual(await Reflect.apply(environmentCapability, undefined, [environmentManager(), key]), notImplemented);
                assert.deepStrictEqual(await Reflect.apply(packageCapability, undefined, [packageManager(), key]), notImplemented);
            }
        });

        test('wrapper fallback methods do not imply raw provider support', async () => {
            const env = new InternalEnvironmentManager('test:environment', environmentManager());
            const pkg = new InternalPackageManager('test:packages', packageManager());
            try {
                assert.deepStrictEqual(await env.getCapability('environments.create'), notImplemented);
                assert.deepStrictEqual(await pkg.getCapability('packages.direct'), notImplemented);
            } finally {
                pkg.dispose();
            }
        });
    });

    suite('Advertisements and prerequisites', () => {
        test('undefined advertisements retain defaults', async () => {
            const env = environmentManager({ capabilities: { 'environments.list': undefined } });
            const pkg = packageManager({ capabilities: { 'packages.list': undefined } });
            assert.deepStrictEqual(await environmentCapability(env, 'environments.list'), supported);
            assert.deepStrictEqual(await packageCapability(pkg, 'packages.list'), supported);
        });

        test('malformed advertisements reject instead of silently using defaults', async () => {
            for (const value of [null, false, { supported: true }]) {
                const env = environmentManager();
                const pkg = packageManager();
                Reflect.set(env, 'capabilities', { 'environments.list': value });
                Reflect.set(pkg, 'capabilities', { 'packages.list': value });
                await assert.rejects(
                    environmentCapability(env, 'environments.list'),
                    (error) => error instanceof TypeError && error.message.includes('environments.list'),
                );
                await assert.rejects(
                    packageCapability(pkg, 'packages.list'),
                    (error) => error instanceof TypeError && error.message.includes('packages.list'),
                );
            }
        });

        test('malformed capability maps reject instead of silently using defaults', async () => {
            for (const value of [null, true, [], () => {}]) {
                const env = environmentManager();
                const pkg = packageManager();
                Reflect.set(env, 'capabilities', value);
                Reflect.set(pkg, 'capabilities', value);
                await assert.rejects(
                    environmentCapability(env, 'environments.list'),
                    (error) => error instanceof TypeError && error.message.includes('capabilities'),
                );
                await assert.rejects(
                    packageCapability(pkg, 'packages.list'),
                    (error) => error instanceof TypeError && error.message.includes('capabilities'),
                );
            }
        });

        test('capability maps with a null prototype are supported', async () => {
            const capabilities = Object.create(null);
            capabilities['packages.list'] = async () => denied;
            const manager = packageManager();
            Reflect.set(manager, 'capabilities', capabilities);
            assert.strictEqual(await packageCapability(manager, 'packages.list'), denied);
        });

        test('environment overrides win in either direction; omitted entries keep defaults', async () => {
            const manager = environmentManager({
                capabilities: {
                    'environments.list': async () => denied,
                    'environments.create': async () => supported,
                },
            });
            assert.strictEqual(await environmentCapability(manager, 'environments.list'), denied);
            assert.strictEqual(await environmentCapability(manager, 'environments.create'), supported);
            assert.deepStrictEqual(await environmentCapability(manager, 'environments.refresh'), supported);
            assert.deepStrictEqual(await environmentCapability(manager, 'environments.remove'), notImplemented);
        });

        test('package overrides win in either direction; omitted entries keep defaults', async () => {
            const manager = packageManager({
                capabilities: {
                    'packages.manage': async () => denied,
                    'packages.direct': async () => supported,
                },
            });
            assert.strictEqual(await packageCapability(manager, 'packages.manage'), denied);
            assert.strictEqual(await packageCapability(manager, 'packages.direct'), supported);
            assert.deepStrictEqual(await packageCapability(manager, 'packages.refresh'), supported);
            assert.deepStrictEqual(await packageCapability(manager, 'packages.version'), notImplemented);
        });

        for (const [parent, children] of [
            ['environments.create', ['environments.create.quick', 'environments.create.additionalPackages']],
            ['environments.remove', ['environments.remove.headless']],
        ] as const) {
            test(`environment options inherit ${parent} support`, async () => {
                for (const result of [supported, denied]) {
                    const manager = environmentManager({
                        create: unexpectedOperation,
                        quickCreateConfig: unexpectedOperation,
                        remove: unexpectedOperation,
                        capabilities: { [parent]: async () => result },
                    });
                    for (const key of children) {
                        assert.strictEqual(await environmentCapability(manager, key), result, key);
                    }
                }
            });
        }

        for (const [parent, children] of [
            ['packages.list', ['packages.list.skipCache']],
            ['packages.manage', [
                'packages.manage.install', 'packages.manage.uninstall', 'packages.manage.upgrade',
                'packages.manage.headless', 'packages.manage.showSkipOption',
            ]],
        ] as const) {
            test(`package options inherit ${parent} opt-outs`, async () => {
                const manager = packageManager({ capabilities: { [parent]: async () => denied } });
                for (const key of children) {
                    assert.strictEqual(await packageCapability(manager, key), denied, key);
                }
            });
        }

        test('quick creation requires both legacy hooks without invoking either', async () => {
            for (const hooks of [{}, { create: unexpectedOperation }, { quickCreateConfig: unexpectedOperation }]) {
                assert.deepStrictEqual(await environmentCapability(environmentManager(hooks), 'environments.create.quick'), notImplemented);
            }
            const manager = environmentManager({ create: unexpectedOperation, quickCreateConfig: unexpectedOperation });
            assert.deepStrictEqual(await environmentCapability(manager, 'environments.create.quick'), supported);
        });

        test('an explicit child override owns its prerequisites', async () => {
            const env = environmentManager({
                capabilities: { 'environments.create.quick': async () => supported },
            });
            assert.strictEqual(await environmentCapability(env, 'environments.create.quick'), supported);
            const pkg = packageManager({
                capabilities: {
                    'packages.manage': async () => denied,
                    'packages.manage.install': async () => supported,
                },
            });
            assert.strictEqual(await packageCapability(pkg, 'packages.manage.upgrade'), supported);
        });

        test('dynamic checks receive context through prerequisites without mutating or caching it', async () => {
            const context: CapabilityContext = Object.freeze({ scope: 'global', project: { name: 'project', uri: Uri.file('.') } });
            let result: Support = denied;
            const manager = packageManager({
                capabilities: {
                    'packages.manage': async (received) => {
                        assert.strictEqual(received.scope, context.scope);
                        assert.strictEqual(received.project, context.project);
                        return result;
                    },
                },
            });
            assert.strictEqual(await packageCapability(manager, 'packages.manage.upgrade', context), denied);
            result = supported;
            assert.strictEqual(await packageCapability(manager, 'packages.manage.upgrade', context), supported);
        });

        test('sync and async checker failures propagate instead of falling back', async () => {
            const failure = new Error('Probe failed');
            const env = environmentManager({ capabilities: { 'environments.list': () => { throw failure; } } });
            const pkg = packageManager({ capabilities: { 'packages.manage': async () => { throw failure; } } });
            await assert.rejects(environmentCapability(env, 'environments.list'), (error) => error === failure);
            await assert.rejects(packageCapability(pkg, 'packages.manage.upgrade'), (error) => error === failure);
        });
    });

    suite('Dependency safety', () => {
        test('self and indirect cycles reject with the dependency chain', async () => {
            const manager = packageManager({
                capabilities: {
                    'packages.list': (context) => packageCapability(manager, 'packages.list', context),
                    'packages.manage': (context) => packageCapability(manager, 'packages.manage.upgrade', context),
                },
            });
            await assert.rejects(packageCapability(manager, 'packages.list'), /packages.list -> packages.list/);
            await assert.rejects(packageCapability(manager, 'packages.manage'), /packages.manage -> packages.manage.upgrade -> packages.manage.install -> packages.manage/);
        });

        test('parallel prerequisites and concurrent queries are not cycles', async () => {
            const manager = packageManager({
                capabilities: {
                    'packages.manage': async (context) => {
                        const results = await Promise.all([
                            packageCapability(manager, 'packages.list', context),
                            packageCapability(manager, 'packages.list', context),
                        ]);
                        return results[0];
                    },
                },
            });
            const context = {};
            assert.deepStrictEqual(await Promise.all([
                packageCapability(manager, 'packages.manage', context),
                packageCapability(manager, 'packages.manage', context),
            ]), [supported, supported]);
        });

        test('the same key on another manager is not a cycle', async () => {
            const other = packageManager();
            const manager = packageManager({
                capabilities: { 'packages.list': (context) => packageCapability(other, 'packages.list', context) },
            });
            assert.deepStrictEqual(await packageCapability(manager, 'packages.list'), supported);
        });

        test('package wrappers preserve dependency ancestry while adding project context', async () => {
            const project = { name: 'project', uri: Uri.file('.') };
            let wrapper: InternalPackageManager;
            const manager = packageManager({
                capabilities: {
                    'packages.manage': (context) => wrapper.getCapability('packages.manage.install', context),
                },
            });
            wrapper = new InternalPackageManager('test:packages', manager, project);
            try {
                await assert.rejects(
                    wrapper.getCapability('packages.manage'),
                    /packages.manage -> packages.manage.install -> packages.manage/,
                );
            } finally {
                wrapper.dispose();
            }
        });

        test('disposed package wrappers reject capability queries', () => {
            const manager = new InternalPackageManager('test:packages', packageManager());
            manager.dispose();
            assert.throws(() => manager.getCapability('packages.list'), /disposed/);
        });
    });
});
