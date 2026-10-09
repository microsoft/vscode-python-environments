import * as assert from 'assert';
import * as sinon from 'sinon';
import { l10n } from 'vscode';
import type { PythonEnvironment } from '../../api';
import * as environmentPickers from '../../common/pickers/environments';
import * as windowApis from '../../common/window.apis';
import * as workspaceApis from '../../common/workspace.apis';
import * as managerReady from '../../features/common/managerReady';
import type { EnvironmentManagers } from '../../features/envManagers';
import { selectPackageManagementEnvironment } from '../../features/nonGlobalPackageInstallationEnvironment';

suite('Non-global Package Installation Environment Tests', () => {
    const environment = {
        envId: { id: 'global-environment', managerId: 'test-manager' },
    } as PythonEnvironment;
    const virtualEnvironment = {
        envId: { id: 'virtual-environment', managerId: 'test-manager' },
    } as PythonEnvironment;
    const createdEnvironment = {
        envId: { id: 'created-environment', managerId: 'test-manager' },
    } as PythonEnvironment;

    let getSetting: sinon.SinonStub;
    let showQuickPick: sinon.SinonStub;
    let pickEnvironment: sinon.SinonStub;
    let createEnvironment: sinon.SinonStub;
    let envManagers: EnvironmentManagers;

    setup(() => {
        getSetting = sinon.stub().returns('ask');
        sinon.stub(workspaceApis, 'getConfiguration').returns({ get: getSetting } as never);
        sinon.stub(managerReady, 'waitForAllEnvManagers').resolves();
        sinon.stub(managerReady, 'waitForEnvManagerId').resolves();
        showQuickPick = sinon.stub(windowApis, 'showQuickPick');
        pickEnvironment = sinon.stub(environmentPickers, 'pickEnvironmentFrom');
        createEnvironment = sinon.stub().resolves(createdEnvironment);

        const getEnvironments = sinon.stub();
        getEnvironments.withArgs('global').resolves([environment]);
        getEnvironments.withArgs('all').resolves([environment, virtualEnvironment]);

        envManagers = {
            managers: [{ getEnvironments }],
            getEnvironmentManager: sinon.stub().returns({ supportsCreate: true, create: createEnvironment }),
        } as unknown as EnvironmentManagers;
    });

    teardown(() => {
        sinon.restore();
    });

    test('asks where to install packages by default', async () => {
        showQuickPick.resolves({ label: l10n.t('Continue Globally'), action: 'continueGlobally' });

        const result = await selectPackageManagementEnvironment(envManagers, environment, { install: ['example'] });

        assert.strictEqual(result, environment);
        sinon.assert.calledOnce(showQuickPick);
    });

    test('continues globally without prompting when configured', async () => {
        getSetting.returns('continueGlobally');

        const result = await selectPackageManagementEnvironment(envManagers, environment, { install: ['example'] });

        assert.strictEqual(result, environment);
        sinon.assert.notCalled(showQuickPick);
    });

    test('asks for an existing virtual environment when configured', async () => {
        getSetting.returns('useExisting');
        pickEnvironment.resolves(virtualEnvironment);

        const result = await selectPackageManagementEnvironment(envManagers, environment, { install: ['example'] });

        assert.strictEqual(result, virtualEnvironment);
        sinon.assert.notCalled(showQuickPick);
        sinon.assert.calledOnceWithExactly(pickEnvironment, [virtualEnvironment]);
    });

    test('creates a virtual environment when configured', async () => {
        getSetting.returns('createNew');

        const result = await selectPackageManagementEnvironment(envManagers, environment, { install: ['example'] });

        assert.strictEqual(result, createdEnvironment);
        sinon.assert.notCalled(showQuickPick);
        sinon.assert.calledOnceWithExactly(createEnvironment, 'global', { quickCreate: true });
    });
});
