// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { LogOutputChannel, Uri } from 'vscode';
import { PythonEnvironment } from '../../../api';
import * as errorUtils from '../../../common/errors/utils';
import * as helpers from '../../../managers/builtin/helpers';
import { refreshPipPackages } from '../../../managers/builtin/utils';

suite('Pip package refresh', () => {
    let environment: PythonEnvironment;
    let log: LogOutputChannel;
    let showErrorMessageWithLogsStub: sinon.SinonStub;

    setup(() => {
        environment = {
            environmentPath: Uri.file('.'),
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

        sinon.stub(helpers, 'shouldUseUv').resolves(false);
        sinon.stub(helpers, 'runPython').rejects(new Error('pip list failed'));
        showErrorMessageWithLogsStub = sinon.stub(errorUtils, 'showErrorMessageWithLogs').resolves();
    });

    teardown(() => {
        sinon.restore();
    });

    test('shows an error when an interactive refresh fails', async () => {
        const result = await refreshPipPackages(environment, log);

        assert.strictEqual(result, undefined);
        assert.ok(showErrorMessageWithLogsStub.calledOnce);
    });

    test('does not show an error when a headless refresh fails', async () => {
        const result = await refreshPipPackages(environment, log, { showErrors: false });

        assert.strictEqual(result, undefined);
        assert.ok(showErrorMessageWithLogsStub.notCalled);
    });

    test('disables the pip version check when listing packages', async () => {
        const runPythonStub = helpers.runPython as sinon.SinonStub;
        runPythonStub.resolves('[]');

        await refreshPipPackages(environment, log);

        assert.deepStrictEqual(runPythonStub.firstCall.args[1], [
            '-m',
            'pip',
            'list',
            '--format=json',
            '--disable-pip-version-check',
        ]);
    });
});
