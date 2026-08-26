// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import { isPackageVersionLookupNotSupportedError, PackageManager, PythonEnvironment } from '../api';
import { InternalPackageManager } from '../internal.api';

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
