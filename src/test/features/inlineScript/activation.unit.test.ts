// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as sinon from 'sinon';
import { ConfigurationChangeEvent, Disposable } from 'vscode';
import * as workspaceApis from '../../../common/workspace.apis';
import { createInlineScriptFeatureActivation } from '../../../features/inlineScript/activation';
import * as helpers from '../../../helpers';

suite('InlineScriptFeatureActivation', () => {
    let getUserConfiguredSetting: sinon.SinonStub;
    let isInlineScriptsFeatureEnabled: sinon.SinonStub;
    let configurationListener: ((event: ConfigurationChangeEvent) => void) | undefined;
    let configurationSubscriptionDispose: sinon.SinonSpy;

    setup(() => {
        getUserConfiguredSetting = sinon.stub(helpers, 'getUserConfiguredSetting');
        isInlineScriptsFeatureEnabled = sinon.stub(helpers, 'isInlineScriptsFeatureEnabled');
        configurationSubscriptionDispose = sinon.spy();
        sinon.stub(workspaceApis, 'onDidChangeConfiguration').callsFake((listener) => {
            configurationListener = listener;
            return new Disposable(configurationSubscriptionDispose);
        });
    });

    teardown(() => {
        sinon.restore();
    });

    function configurationChange(affected: boolean): ConfigurationChangeEvent {
        return {
            affectsConfiguration: sinon.stub().returns(affected),
        };
    }

    test('an explicit true value requests activation immediately without watching defaults', () => {
        getUserConfiguredSetting.returns(true);

        const activation = createInlineScriptFeatureActivation();

        assert.strictEqual(activation.activationRequested, true);
        assert.strictEqual(configurationListener, undefined);
        assert.strictEqual(isInlineScriptsFeatureEnabled.callCount, 0);
        activation.dispose();
    });

    test('an explicit false value stays disabled without watching defaults', () => {
        getUserConfiguredSetting.returns(false);

        const activation = createInlineScriptFeatureActivation();

        assert.strictEqual(activation.activationRequested, false);
        assert.strictEqual(configurationListener, undefined);
        assert.strictEqual(isInlineScriptsFeatureEnabled.callCount, 0);
        activation.dispose();
    });

    test('an effective true default requests activation after subscribing', () => {
        getUserConfiguredSetting.returns(undefined);
        isInlineScriptsFeatureEnabled.returns(true);

        const activation = createInlineScriptFeatureActivation();

        assert.strictEqual(activation.activationRequested, true);
        assert.ok(configurationListener, 'the default listener should be registered before the effective read');
        sinon.assert.calledOnce(configurationSubscriptionDispose);
        activation.dispose();
    });

    test('a late experimental default requests activation exactly once', () => {
        getUserConfiguredSetting.returns(undefined);
        isInlineScriptsFeatureEnabled.onFirstCall().returns(false).onSecondCall().returns(true);
        const activation = createInlineScriptFeatureActivation();
        let requests = 0;
        const requestSubscription = activation.onDidRequestActivation(() => {
            requests += 1;
        });

        assert.strictEqual(activation.activationRequested, false);
        assert.ok(configurationListener);
        configurationListener!(configurationChange(true));
        configurationListener!(configurationChange(true));

        assert.strictEqual(activation.activationRequested, true);
        assert.strictEqual(requests, 1);
        sinon.assert.calledOnce(configurationSubscriptionDispose);
        requestSubscription.dispose();
        activation.dispose();
    });

    test('a user setting change remains reload-only and stops watching defaults', () => {
        getUserConfiguredSetting.onFirstCall().returns(undefined).onSecondCall().returns(undefined).onThirdCall().returns(true);
        isInlineScriptsFeatureEnabled.returns(false);
        const activation = createInlineScriptFeatureActivation();
        let requested = false;
        const requestSubscription = activation.onDidRequestActivation(() => {
            requested = true;
        });

        assert.ok(configurationListener);
        configurationListener!(configurationChange(true));

        assert.strictEqual(requested, false);
        assert.strictEqual(activation.activationRequested, false);
        assert.strictEqual(isInlineScriptsFeatureEnabled.callCount, 1);
        sinon.assert.calledOnce(configurationSubscriptionDispose);
        requestSubscription.dispose();
        activation.dispose();
    });

    test('unrelated configuration changes do not re-read the setting', () => {
        getUserConfiguredSetting.returns(undefined);
        isInlineScriptsFeatureEnabled.returns(false);
        const activation = createInlineScriptFeatureActivation();

        assert.ok(configurationListener);
        configurationListener!(configurationChange(false));

        assert.strictEqual(getUserConfiguredSetting.callCount, 2);
        assert.strictEqual(isInlineScriptsFeatureEnabled.callCount, 1);
        assert.strictEqual(activation.activationRequested, false);
        activation.dispose();
    });
});
