// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import { l10n, Uri } from 'vscode';
import {
    Capabilities,
    CapabilityContext,
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

const supported: Support = { supported: true };
const notImplemented: Support = { supported: false, reason: l10n.t('Capability not implemented') };
const denied: Support = { supported: false, reason: 'Disabled by provider' };

/** A complete, fully-supported capability map. Every manager must advertise every key. */
const fullEnvironmentCapabilities: Capabilities<EnvironmentManagerCapability> = {
    'environments.list': async () => supported,
    'environments.resolve': async () => supported,
    'environments.getSelected': async () => supported,
    'environments.setSelected': async () => supported,
    'environments.create': async () => supported,
    'environments.remove': async () => supported,
};

const fullPackageCapabilities: Capabilities<PackageManagerCapability> = {
    'packages.list': async () => supported,
    'packages.refresh': async () => supported,
    'packages.manage': async () => supported,
    'packages.manage.install': async () => supported,
    'packages.manage.uninstall': async () => supported,
    'packages.manage.upgrade': async () => supported,
    'packages.direct': async () => supported,
    'packages.availableVersions': async () => supported,
};

function environmentManager(capabilities: Partial<Capabilities<EnvironmentManagerCapability>> = {}): EnvironmentManager {
    return {
        name: 'environment',
        preferredPackageManagerId: 'test:packages',
        refresh: unexpectedOperation,
        getEnvironments: unexpectedOperation,
        get: unexpectedOperation,
        set: unexpectedOperation,
        resolve: unexpectedOperation,
        capabilities: { ...fullEnvironmentCapabilities, ...capabilities },
    };
}

function packageManager(capabilities: Partial<Capabilities<PackageManagerCapability>> = {}): PackageManager {
    return {
        name: 'packages',
        manage: unexpectedOperation,
        refresh: unexpectedOperation,
        getPackages: unexpectedOperation,
        capabilities: { ...fullPackageCapabilities, ...capabilities },
    };
}

suite('Manager capabilities', () => {
    suite('Required advertisements, no defaults', () => {
        test('advertised checks are honored in either direction', async () => {
            const env = environmentManager({ 'environments.list': async () => denied, 'environments.create': async () => supported });
            assert.strictEqual(await environmentCapability(env, 'environments.list'), denied);
            assert.strictEqual(await environmentCapability(env, 'environments.create'), supported);

            const pkg = packageManager({ 'packages.manage': async () => denied, 'packages.direct': async () => supported });
            assert.strictEqual(await packageCapability(pkg, 'packages.manage'), denied);
            assert.strictEqual(await packageCapability(pkg, 'packages.direct'), supported);
        });

        test('a key missing from the capability map resolves unsupported, not a crash', async () => {
            // Simulates a non-TypeScript provider whose capability map omits a required key.
            const env = environmentManager();
            Reflect.set(env, 'capabilities', {});
            const pkg = packageManager();
            Reflect.set(pkg, 'capabilities', {});
            assert.deepStrictEqual(await environmentCapability(env, 'environments.list'), notImplemented);
            assert.deepStrictEqual(await packageCapability(pkg, 'packages.list'), notImplemented);
        });

        test('unknown runtime keys cannot resolve inherited object properties', async () => {
            for (const key of ['future.capability', 'toString', 'constructor', '__proto__']) {
                assert.deepStrictEqual(await Reflect.apply(environmentCapability, undefined, [environmentManager(), key]), notImplemented);
                assert.deepStrictEqual(await Reflect.apply(packageCapability, undefined, [packageManager(), key]), notImplemented);
            }
        });

        test('a capability value that is not a function resolves unsupported, not a crash', async () => {
            for (const value of [null, false, { supported: true }]) {
                const env = environmentManager({ 'environments.list': value as never });
                const pkg = packageManager({ 'packages.list': value as never });
                assert.deepStrictEqual(await environmentCapability(env, 'environments.list'), notImplemented);
                assert.deepStrictEqual(await packageCapability(pkg, 'packages.list'), notImplemented);
            }
        });

        test('a non-object capabilities map resolves unsupported, not a crash', async () => {
            for (const value of [true, [], () => {}]) {
                const env = environmentManager();
                const pkg = packageManager();
                Reflect.set(env, 'capabilities', value);
                Reflect.set(pkg, 'capabilities', value);
                assert.deepStrictEqual(await environmentCapability(env, 'environments.list'), notImplemented);
                assert.deepStrictEqual(await packageCapability(pkg, 'packages.list'), notImplemented);
            }
        });

        test('capability maps with a null prototype are supported', async () => {
            const capabilities = Object.create(null);
            capabilities['packages.list'] = async () => denied;
            const manager = packageManager();
            Reflect.set(manager, 'capabilities', capabilities);
            assert.strictEqual(await packageCapability(manager, 'packages.list'), denied);
        });

        test('dynamic checks receive context through prerequisites without mutating or caching it', async () => {
            const context: CapabilityContext = Object.freeze({ scope: 'global', project: { name: 'project', uri: Uri.file('.') } });
            let result: Support = denied;
            const manager = packageManager({
                'packages.manage': async (received) => {
                    assert.strictEqual(received.scope, context.scope);
                    assert.strictEqual(received.project, context.project);
                    return result;
                },
            });
            assert.strictEqual(await packageCapability(manager, 'packages.manage', context), denied);
            result = supported;
            assert.strictEqual(await packageCapability(manager, 'packages.manage', context), supported);
        });

        test('sync and async checker failures propagate instead of resolving unsupported', async () => {
            const failure = new Error('Probe failed');
            const env = environmentManager({
                'environments.list': () => {
                    throw failure;
                },
            });
            const pkg = packageManager({ 'packages.manage': async () => Promise.reject(failure) });
            await assert.rejects(environmentCapability(env, 'environments.list'), (error) => error === failure);
            await assert.rejects(packageCapability(pkg, 'packages.manage'), (error) => error === failure);
        });
    });

    suite('Wrappers forward raw advertisements', () => {
        test('InternalEnvironmentManager resolves through the raw manager without defaults', async () => {
            const manager = new InternalEnvironmentManager(
                'test:environment',
                environmentManager({ 'environments.create': async () => denied }),
            );
            assert.strictEqual(await manager.getCapability('environments.create'), denied);
            assert.deepStrictEqual(await manager.getCapability('environments.list'), supported);
        });

        test('InternalPackageManager resolves through the raw manager without defaults', async () => {
            const manager = new InternalPackageManager('test:packages', packageManager({ 'packages.direct': async () => denied }));
            try {
                assert.strictEqual(await manager.getCapability('packages.direct'), denied);
                assert.deepStrictEqual(await manager.getCapability('packages.list'), supported);
            } finally {
                manager.dispose();
            }
        });

        test('disposed package wrappers reject capability queries', () => {
            const manager = new InternalPackageManager('test:packages', packageManager());
            manager.dispose();
            assert.throws(() => manager.getCapability('packages.list'), /disposed/);
        });
    });
});
