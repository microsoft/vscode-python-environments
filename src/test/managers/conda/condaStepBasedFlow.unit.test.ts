import assert from 'assert';
import * as sinon from 'sinon';
import { QuickPickItem, Uri } from 'vscode';
import { EnvironmentManager, PythonEnvironment, PythonEnvironmentApi } from '../../../api';
import { CondaStrings } from '../../../common/localize';
import * as windowApis from '../../../common/window.apis';
import { createStepBasedCondaFlow } from '../../../managers/conda/condaStepBasedFlow';
import * as condaUtils from '../../../managers/conda/condaUtils';
import { createMockLogOutputChannel } from '../../mocks/helper';

suite('Conda step-based create flow', () => {
    let originalCondaNamed: string;

    setup(() => {
        originalCondaNamed = CondaStrings.condaNamed;
        Object.defineProperty(CondaStrings, 'condaNamed', { value: '명명됨', configurable: true });
    });

    teardown(() => {
        sinon.restore();
        Object.defineProperty(CondaStrings, 'condaNamed', { value: originalCondaNamed, configurable: true });
    });

    test('routes a localized Named selection to named environment creation', async () => {
        const createdEnvironment = {} as PythonEnvironment;
        const showQuickPickStub = sinon.stub(windowApis, 'showQuickPickWithButtons');
        showQuickPickStub.onFirstCall().callsFake(async (items: readonly QuickPickItem[]) => items[0]);
        showQuickPickStub.onSecondCall().resolves({ label: 'Python', description: '3.12' } as QuickPickItem);
        const showInputBoxStub = sinon.stub(windowApis, 'showInputBoxWithButtons').resolves('localized-env');
        const createNamedStub = sinon.stub(condaUtils, 'createNamedCondaEnvironment').resolves(createdEnvironment);
        const createPrefixStub = sinon.stub(condaUtils, 'createPrefixCondaEnvironment');
        const api = {
            getEnvironments: sinon.stub().resolves([]),
            getPythonProject: sinon.stub().returns(undefined),
        } as unknown as PythonEnvironmentApi;

        const result = await createStepBasedCondaFlow(
            api,
            createMockLogOutputChannel(),
            {} as EnvironmentManager,
            Uri.file('workspace'),
        );

        assert.strictEqual(result, createdEnvironment);
        assert.strictEqual((showQuickPickStub.firstCall.args[0] as QuickPickItem[])[0].label, '명명됨');
        assert.ok(showInputBoxStub.calledOnce);
        assert.ok(createNamedStub.calledOnceWithExactly(api, sinon.match.any, sinon.match.any, 'localized-env', '3.12'));
        assert.ok(createPrefixStub.notCalled);
    });
});
