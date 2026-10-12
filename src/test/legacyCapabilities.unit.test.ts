// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import { l10n } from 'vscode';
import {
    EnvironmentCapability,
    PackageCapability,
} from '../capabilities';
import type { EnvironmentManagerCapability, PackageManagerCapability } from '../capabilities';
import { getLegacyEnvironmentManagerCapability, getLegacyPackageManagerCapability } from '../legacyCapabilities';
import type { EnvironmentManager, PackageManager } from '../types';

function unexpectedOperation(): never {
    throw new Error('Legacy capability inference must not invoke operations');
}

const legacySupported = { supported: true, isLegacy: true };
const legacyUnsupported = { supported: false, reason: l10n.t('Capability not implemented'), isLegacy: true };

suite('Legacy manager capabilities', () => {
    test('package capabilities require their callable methods without executing them', async () => {
        const manager: PackageManager = {
            name: 'legacy',
            manage: unexpectedOperation,
            refresh: unexpectedOperation,
            getPackages: unexpectedOperation,
            getDirectPackageNames: unexpectedOperation,
            getPackageAvailableVersions: unexpectedOperation,
        };
        const methods: Record<PackageManagerCapability, (keyof PackageManager)[]> = {
            [PackageCapability.List]: ['getPackages', 'refresh'],
            [PackageCapability.Install]: ['manage'],
            [PackageCapability.Uninstall]: ['manage'],
            [PackageCapability.Upgrade]: ['manage'],
            [PackageCapability.ListDirect]: ['getDirectPackageNames'],
            [PackageCapability.ListAvailableVersions]: ['getPackageAvailableVersions'],
        };

        for (const capability of Object.values(PackageCapability)) {
            assert.deepStrictEqual(await getLegacyPackageManagerCapability(manager, capability), legacySupported);
            for (const method of methods[capability]) {
                for (const value of [undefined, false]) {
                    Reflect.set(manager, method, value);
                    assert.deepStrictEqual(await getLegacyPackageManagerCapability(manager, capability), legacyUnsupported);
                }
                Reflect.set(manager, method, unexpectedOperation);
            }
        }
        assert.deepStrictEqual(await Reflect.apply(getLegacyPackageManagerCapability, undefined, [manager, 'unknown']), legacyUnsupported);
    });

    test('environment capabilities require their callable methods without executing them', async () => {
        const manager: EnvironmentManager = {
            name: 'legacy',
            preferredPackageManagerId: 'legacy:packages',
            refresh: unexpectedOperation,
            getEnvironments: unexpectedOperation,
            resolve: unexpectedOperation,
            get: unexpectedOperation,
            set: unexpectedOperation,
            create: unexpectedOperation,
            remove: unexpectedOperation,
        };
        const methods: Record<EnvironmentManagerCapability, (keyof EnvironmentManager)[]> = {
            [EnvironmentCapability.List]: ['getEnvironments', 'refresh'],
            [EnvironmentCapability.Resolve]: ['resolve'],
            [EnvironmentCapability.GetSelected]: ['get'],
            [EnvironmentCapability.SetSelected]: ['set'],
            [EnvironmentCapability.Create]: ['create'],
            [EnvironmentCapability.Remove]: ['remove'],
        };

        for (const capability of Object.values(EnvironmentCapability)) {
            assert.deepStrictEqual(await getLegacyEnvironmentManagerCapability(manager, capability), legacySupported);
            for (const method of methods[capability]) {
                for (const value of [undefined, false]) {
                    Reflect.set(manager, method, value);
                    assert.deepStrictEqual(await getLegacyEnvironmentManagerCapability(manager, capability), legacyUnsupported);
                }
                Reflect.set(manager, method, unexpectedOperation);
            }
        }
        assert.deepStrictEqual(await Reflect.apply(getLegacyEnvironmentManagerCapability, undefined, [manager, 'unknown']), legacyUnsupported);
    });
});
