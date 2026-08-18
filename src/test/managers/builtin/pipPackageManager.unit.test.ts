// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { LogOutputChannel, Uri } from 'vscode';
import { Package, PythonEnvironment, PythonEnvironmentApi } from '../../../api';
import * as helpers from '../../../managers/builtin/helpers';
import { PipPackageManager } from '../../../managers/builtin/pipPackageManager';
import { PipListCommand } from '../../../managers/builtin/commands/list';
import { VenvManager } from '../../../managers/builtin/venvManager';
import * as windowApis from '../../../common/window.apis';

suite('PipPackageManager', () => {
    teardown(() => {
        sinon.restore();
    });

    test('preserves cached packages when a forced refresh fails', async () => {
        const environment = {
            envId: { id: 'test-environment', managerId: 'test-manager' },
            environmentPath: Uri.file('.'),
            execInfo: { run: { executable: 'python' } },
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
        sinon.stub(helpers, 'shouldUseUv').resolves(false);
        sinon.stub(windowApis, 'showErrorMessage').resolves(undefined);
        const execute = sinon.stub(PipListCommand.prototype, 'execute');
        execute
            .onFirstCall()
            .resolves([{ name: 'pip', version: '25.0', displayName: 'pip', description: '25.0' }]);
        execute.onSecondCall().rejects(new Error('pip list failed'));

        const initial = await manager.getPackages(environment);
        const afterFailedRefresh = await manager.getPackages(environment, { skipCache: true });

        assert.deepStrictEqual(initial, [cachedPackage]);
        assert.deepStrictEqual(afterFailedRefresh, [cachedPackage]);
    });

    test('preserves undefined when an uncached refresh fails', async () => {
        const environment = {
            envId: { id: 'test-environment', managerId: 'test-manager' },
            environmentPath: Uri.file('.'),
            execInfo: { run: { executable: 'python' } },
        } as PythonEnvironment;
        const manager = new PipPackageManager(
            { createPackageItem: sinon.stub() } as unknown as PythonEnvironmentApi,
            { error: sinon.stub(), info: sinon.stub() } as unknown as LogOutputChannel,
            {} as VenvManager,
        );
        sinon.stub(helpers, 'shouldUseUv').resolves(false);
        sinon.stub(windowApis, 'showErrorMessage').resolves(undefined);
        const execute = sinon.stub(PipListCommand.prototype, 'execute').rejects(new Error('pip list failed'));

        const firstResult = await manager.getPackages(environment);
        const secondResult = await manager.getPackages(environment);

        assert.strictEqual(firstResult, undefined);
        assert.strictEqual(secondResult, undefined);
        assert.strictEqual(execute.callCount, 2, 'A failed refresh should not populate the package cache');
    });
});
