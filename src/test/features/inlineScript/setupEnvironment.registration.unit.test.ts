// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as sinon from 'sinon';
import { Disposable } from 'vscode';
import * as commandApis from '../../../common/command.api';
import { InlineScriptRoutingRegistry } from '../../../common/inlineScript/routingRegistry';
import { EnvironmentManagers } from '../../../features/envManagers';
import * as codeLensModule from '../../../features/inlineScript/codeLens';
import { registerInlineScriptUx } from '../../../features/inlineScript/setupEnvironment';
import * as setupCodeActionModule from '../../../features/inlineScript/setupCodeAction';

suite('registerInlineScriptUx', () => {
    teardown(() => {
        sinon.restore();
    });

    test('rolls back earlier registrations when a later command fails', () => {
        const codeLensDispose = sinon.spy();
        const codeActionDispose = sinon.spy();
        const firstCommandDispose = sinon.spy();
        sinon.stub(codeLensModule, 'registerInlineScriptCodeLens').returns({
            provider: {} as never,
            disposable: new Disposable(codeLensDispose),
        });
        sinon
            .stub(setupCodeActionModule, 'registerInlineScriptSetupCodeAction')
            .returns(new Disposable(codeActionDispose));
        sinon
            .stub(commandApis, 'registerCommand')
            .onFirstCall()
            .returns(new Disposable(firstCommandDispose))
            .onSecondCall()
            .throws(new Error('duplicate command'));

        assert.throws(
            () => registerInlineScriptUx({} as EnvironmentManagers, new InlineScriptRoutingRegistry()),
            /duplicate command/,
        );
        sinon.assert.calledOnce(codeLensDispose);
        sinon.assert.calledOnce(codeActionDispose);
        sinon.assert.calledOnce(firstCommandDispose);
    });
});
