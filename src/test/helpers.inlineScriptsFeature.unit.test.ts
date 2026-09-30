// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as sinon from 'sinon';
import { WorkspaceConfiguration } from 'vscode';
import * as workspaceApis from '../common/workspace.apis';
import { isInlineScriptsFeatureEnabled } from '../helpers';

suite('isInlineScriptsFeatureEnabled', () => {
    let getConfigurationStub: sinon.SinonStub;
    let configGet: sinon.SinonStub;

    setup(() => {
        configGet = sinon.stub();
        const fakeConfig = {
            get: configGet,
            has: sinon.stub(),
            inspect: sinon.stub(),
            update: sinon.stub(),
        } as unknown as WorkspaceConfiguration;
        getConfigurationStub = sinon.stub(workspaceApis, 'getConfiguration').returns(fakeConfig);
    });

    teardown(() => {
        sinon.restore();
    });

    test('returns false by default (no setting written)', () => {
        configGet.withArgs('inlineScripts.enabled', false).returns(false);
        assert.strictEqual(isInlineScriptsFeatureEnabled(), false);
    });

    test('returns true when the user explicitly enables the setting', () => {
        configGet.withArgs('inlineScripts.enabled', false).returns(true);
        assert.strictEqual(isInlineScriptsFeatureEnabled(), true);
    });

    test('reads from the python-envs section', () => {
        configGet.withArgs('inlineScripts.enabled', false).returns(false);
        isInlineScriptsFeatureEnabled();
        assert.ok(
            getConfigurationStub.calledWith('python-envs'),
            'expected getConfiguration("python-envs") to be called',
        );
    });
});
