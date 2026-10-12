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
    EnvironmentCapability,
    PackageCapability,
} from '../capabilities';
import { InternalEnvironmentManager, InternalPackageManager } from '../managers/common/registeredManagers';
import type { EnvironmentManager, PackageManager } from '../types';
import { allSupportedEnvironmentCapabilities, allSupportedPackageCapabilities } from './capabilityFixtures';

function unexpectedOperation(): never {
    throw new Error('A capability query must not invoke a manager operation');
}

const supported: Support = { supported: true };
const notImplemented: Support = { supported: false, reason: l10n.t('Capability not implemented') };
const denied: Support = { supported: false, reason: 'Disabled by provider' };

function environmentManager(capabilities: Partial<Capabilities<EnvironmentManagerCapability>> = {}): EnvironmentManager {
    return {
        name: 'environment',
        preferredPackageManagerId: 'test:packages',
        refresh: unexpectedOperation,
        getEnvironments: unexpectedOperation,
        get: unexpectedOperation,
        set: unexpectedOperation,
        resolve: unexpectedOperation,
        capabilities: { ...allSupportedEnvironmentCapabilities, ...capabilities },
    };
}

function packageManager(capabilities: Partial<Capabilities<PackageManagerCapability>> = {}): PackageManager {
    return {
        name: 'packages',
        manage: unexpectedOperation,
        refresh: unexpectedOperation,
        getPackages: unexpectedOperation,
        capabilities: { ...allSupportedPackageCapabilities, ...capabilities },
    };
}

suite('Manager capabilities', () => {
    suite('Optional advertisements with legacy fallback', () => {
        test('advertised checks are honored in either direction', async () => {
            const env = environmentManager({ [EnvironmentCapability.List]: async () => denied, [EnvironmentCapability.Create]: async () => supported });
            assert.strictEqual(await environmentCapability(env, EnvironmentCapability.List), denied);
            assert.strictEqual(await environmentCapability(env, EnvironmentCapability.Create), supported);

            const pkg = packageManager({ [PackageCapability.Install]: async () => denied, [PackageCapability.ListDirect]: async () => supported });
            assert.strictEqual(await packageCapability(pkg, PackageCapability.Install), denied);
            assert.strictEqual(await packageCapability(pkg, PackageCapability.ListDirect), supported);
        });

        test('only omitted maps use legacy inference; supplied maps and missing keys remain unsupported', async () => {
            const env = environmentManager();
            const pkg = packageManager();
            for (const capabilities of [{}, undefined, null, false, 0, '']) {
                Reflect.set(env, 'capabilities', capabilities);
                Reflect.set(pkg, 'capabilities', capabilities);
                const expected: Support = capabilities === undefined ? { supported: true, isLegacy: true } : notImplemented;
                assert.deepStrictEqual(await environmentCapability(env, EnvironmentCapability.List), expected);
                assert.deepStrictEqual(await packageCapability(pkg, PackageCapability.List), expected);
                assert.deepStrictEqual(
                    await environmentCapability(env, EnvironmentCapability.Create),
                    capabilities === undefined ? { ...notImplemented, isLegacy: true } : notImplemented,
                );
            }
        });

        test('unknown runtime keys cannot resolve inherited object properties', async () => {
            for (const key of ['future.capability', 'toString', 'constructor', '__proto__']) {
                assert.deepStrictEqual(await Reflect.apply(environmentCapability, undefined, [environmentManager(), key]), notImplemented);
                assert.deepStrictEqual(await Reflect.apply(packageCapability, undefined, [packageManager(), key]), notImplemented);
            }
        });

        test('a capability value that is not a function resolves unsupported, not a crash', async () => {
            for (const value of [null, false, { supported: true }]) {
                const env = environmentManager({ [EnvironmentCapability.List]: value as never });
                const pkg = packageManager({ [PackageCapability.List]: value as never });
                assert.deepStrictEqual(await environmentCapability(env, EnvironmentCapability.List), notImplemented);
                assert.deepStrictEqual(await packageCapability(pkg, PackageCapability.List), notImplemented);
            }
        });

        test('dynamic checks forward context without mutating or caching it', async () => {
            const context: CapabilityContext = Object.freeze({ scope: 'global', project: { name: 'project', uri: Uri.file('.') } });
            let result: Support = denied;
            const manager = packageManager({
                [PackageCapability.Install]: async (received) => {
                    assert.strictEqual(received.scope, context.scope);
                    assert.strictEqual(received.project, context.project);
                    return result;
                },
            });
            assert.strictEqual(await packageCapability(manager, PackageCapability.Install, context), denied);
            result = supported;
            assert.strictEqual(await packageCapability(manager, PackageCapability.Install, context), supported);
        });

        test('sync and async checker failures propagate instead of resolving unsupported', async () => {
            const failure = new Error('Probe failed');
            const env = environmentManager({
                [EnvironmentCapability.List]: () => {
                    throw failure;
                },
            });
            const pkg = packageManager({ [PackageCapability.Install]: async () => Promise.reject(failure) });
            await assert.rejects(environmentCapability(env, EnvironmentCapability.List), (error) => error === failure);
            await assert.rejects(packageCapability(pkg, PackageCapability.Install), (error) => error === failure);
        });
    });

    suite('Wrappers forward raw advertisements', () => {
        test('InternalEnvironmentManager resolves through the raw manager without defaults', async () => {
            const manager = new InternalEnvironmentManager(
                'test:environment',
                environmentManager({ [EnvironmentCapability.Create]: async () => denied }),
            );
            assert.strictEqual(await manager.getCapability(EnvironmentCapability.Create), denied);
            assert.deepStrictEqual(await manager.getCapability(EnvironmentCapability.List), supported);
        });

        test('InternalPackageManager resolves through the raw manager without defaults', async () => {
            const manager = new InternalPackageManager('test:packages', packageManager({ [PackageCapability.ListDirect]: async () => denied }));
            try {
                assert.strictEqual(await manager.getCapability(PackageCapability.ListDirect), denied);
                assert.deepStrictEqual(await manager.getCapability(PackageCapability.List), supported);
            } finally {
                manager.dispose();
            }
        });

        test('disposed package wrappers reject capability queries', () => {
            const manager = new InternalPackageManager('test:packages', packageManager());
            manager.dispose();
            assert.throws(() => manager.getCapability(PackageCapability.List), /disposed/);
        });
    });
});
