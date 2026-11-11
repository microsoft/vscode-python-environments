// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import { explain as parsePep440Version } from '@renovatebot/pep440';
import * as sinon from 'sinon';
import { isPackageVersionLookupNotSupportedError } from '../../../publicErrors';
import type { EnvironmentManager, PackageManager, PythonEnvironment } from '../../../types';
import {
    InternalEnvironmentManager,
    InternalPackageManager,
} from '../../../managers/common/registeredManagers';

suite('Internal manager getVersion', () => {
    const version = parsePep440Version('1.2.3');

    test('caches an environment manager version', async () => {
        const getVersion = sinon.stub().resolves(version);
        const manager = new InternalEnvironmentManager('test:manager', {
            getVersion,
        } as unknown as EnvironmentManager);

        assert.deepStrictEqual(await manager.getVersion(), version);
        assert.deepStrictEqual(await manager.getVersion(), version);
        assert.strictEqual(getVersion.callCount, 1);
    });

    test('caches a package manager version', async () => {
        const environment = { envId: { id: 'env', managerId: 'mgr' } } as PythonEnvironment;
        const otherEnvironment = { envId: { id: 'other-env', managerId: 'mgr' } } as PythonEnvironment;
        const otherVersion = parsePep440Version('2.0.0');
        const getVersion = sinon.stub();
        getVersion.withArgs(environment).resolves(version);
        getVersion.withArgs(otherEnvironment).resolves(otherVersion);
        const manager = new InternalPackageManager('test:manager', {
            getVersion,
        } as unknown as PackageManager);

        assert.deepStrictEqual(await manager.getVersion(environment), version);
        assert.deepStrictEqual(await manager.getVersion(environment), version);
        assert.deepStrictEqual(await manager.getVersion(otherEnvironment), otherVersion);
        assert.deepStrictEqual(await manager.getVersion(otherEnvironment), otherVersion);
        assert.strictEqual(getVersion.callCount, 2);
    });
});

suite('InternalPackageManager.getPackageAvailableVersions', () => {
    const environment = { envId: { id: 'env', managerId: 'mgr' } } as PythonEnvironment;

    test('resolves undefined when errorMode is omitted', async () => {
        const manager = new InternalPackageManager('test:manager', {} as unknown as PackageManager);
        assert.strictEqual(await manager.getPackageAvailableVersions(environment, 'requests'), undefined);
    });

    test('rejects when errorMode is throw', async () => {
        const manager = new InternalPackageManager('test:manager', {} as unknown as PackageManager);
        await assert.rejects(
            () => manager.getPackageAvailableVersions(environment, 'requests', { errorMode: 'throw' }),
            (error: unknown) => isPackageVersionLookupNotSupportedError(error),
        );
    });
});
