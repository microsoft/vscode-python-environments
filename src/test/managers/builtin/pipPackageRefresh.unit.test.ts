// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { LogOutputChannel, Uri } from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi } from '../../../api';
import * as windowApis from '../../../common/window.apis';
import { PipInstallCommand } from '../../../managers/builtin/commands/install';
import { PipListCommand } from '../../../managers/builtin/commands/list';
import { PipListDirectNamesCommand } from '../../../managers/builtin/commands/listDirectNames';
import * as helpers from '../../../managers/builtin/helpers';
import { PipPackageManager } from '../../../managers/builtin/pipPackageManager';
import { VenvManager } from '../../../managers/builtin/venvManager';

suite('Pip package refresh', () => {
    let environment: PythonEnvironment;
    let log: LogOutputChannel;
    let manager: PipPackageManager;
    let showErrorMessageStub: sinon.SinonStub;

    setup(() => {
        environment = {
            envId: { id: 'test-environment', managerId: 'test-manager' },
            environmentPath: Uri.file('.'),
            version: '3.13.0',
            execInfo: {
                run: {
                    executable: 'python',
                },
            },
        } as PythonEnvironment;
        log = {
            error: sinon.stub(),
            info: sinon.stub(),
        } as unknown as LogOutputChannel;
        manager = new PipPackageManager(
            { createPackageItem: sinon.stub() } as unknown as PythonEnvironmentApi,
            log,
            {} as VenvManager,
        );

        sinon.stub(helpers, 'shouldUseUv').resolves(false);
        showErrorMessageStub = sinon.stub(windowApis, 'showErrorMessage').resolves(undefined);
    });

    teardown(() => {
        sinon.restore();
    });

    test('shows an error when an interactive refresh fails', async () => {
        sinon.stub(PipListCommand.prototype, 'execute').rejects(new Error('pip list failed'));

        const result = await manager.getPackages(environment, { skipCache: true });
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(result, undefined);
        assert.ok(showErrorMessageStub.calledOnce);
    });

    test('does not show an error when a headless refresh fails', async () => {
        sinon.stub(windowApis, 'withProgress').callsFake(async (_options, task) => task({} as never, {} as never));
        sinon.stub(PipInstallCommand.prototype, 'execute').resolves();
        sinon.stub(PipListCommand.prototype, 'execute').rejects(new Error('pip list failed'));
        sinon.stub(PipListDirectNamesCommand.prototype, 'execute').resolves(undefined);

        await manager.manage(environment, { install: ['requests'], runHeadless: true });
        await new Promise((resolve) => setImmediate(resolve));

        assert.ok(showErrorMessageStub.notCalled);
    });
});
