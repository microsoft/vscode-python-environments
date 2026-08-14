// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { LogOutputChannel, Uri } from 'vscode';
import { Package, PythonEnvironment, PythonEnvironmentApi } from '../../../api';
import { PipPackageManager } from '../../../managers/builtin/pipPackageManager';
import * as builtinUtils from '../../../managers/builtin/utils';
import { VenvManager } from '../../../managers/builtin/venvManager';

suite('PipPackageManager', () => {
    teardown(() => {
        sinon.restore();
    });

    test('preserves cached packages when a forced refresh fails', async () => {
        const environment = {
            envId: { id: 'test-environment', managerId: 'test-manager' },
            environmentPath: Uri.file('/path/to/environment'),
        } as PythonEnvironment;
        const cachedPackage = { name: 'pip', version: '25.0' } as Package;
        const api = {
            createPackageItem: sinon.stub().returns(cachedPackage),
        } as unknown as PythonEnvironmentApi;
        const log = {
            error: sinon.stub(),
            info: sinon.stub(),
        } as unknown as LogOutputChannel;
        const manager = new PipPackageManager(api, log, {} as VenvManager);
        const refreshPackages = sinon.stub(builtinUtils, 'refreshPipPackages');
        refreshPackages
            .onFirstCall()
            .resolves([{ name: 'pip', version: '25.0', displayName: 'pip', description: '25.0' }]);
        refreshPackages.onSecondCall().resolves(undefined);

        const initial = await manager.getPackages(environment);
        const afterFailedRefresh = await manager.getPackages(environment, { skipCache: true });

        assert.deepStrictEqual(initial, [cachedPackage]);
        assert.deepStrictEqual(afterFailedRefresh, [cachedPackage]);
    });
});
