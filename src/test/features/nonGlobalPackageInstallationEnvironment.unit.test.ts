import * as assert from 'assert';
import * as sinon from 'sinon';
import { l10n } from 'vscode';
import type { PythonEnvironment } from '../../api';
import type { PersistentState } from '../../common/persistentState';
import * as persistentState from '../../common/persistentState';
import * as environmentPickers from '../../common/pickers/environments';
import * as windowApis from '../../common/window.apis';
import * as managerReady from '../../features/common/managerReady';
import type { EnvironmentManagers } from '../../features/envManagers';
import {
    GLOBAL_PACKAGE_INSTALLATION_SELECTION_KEY,
    selectPackageManagementEnvironment,
} from '../../features/nonGlobalPackageInstallationEnvironment';

suite('Non-global Package Installation Environment Tests', () => {
    const environment = {
        envId: { id: 'global-environment', managerId: 'test-manager' },
    } as PythonEnvironment;
    const virtualEnvironment = {
        envId: { id: 'virtual-environment', managerId: 'test-manager' },
    } as PythonEnvironment;

    let state: PersistentState;
    let getState: sinon.SinonStub;
    let setState: sinon.SinonStub;
    let showQuickPickWithToggle: sinon.SinonStub;
    let pickEnvironment: sinon.SinonStub;
    let envManagers: EnvironmentManagers;

    setup(() => {
        getState = sinon.stub().resolves(false);
        setState = sinon.stub().resolves();
        state = {
            get: getState,
            set: setState,
            clear: sinon.stub().resolves(),
        };

        sinon.stub(persistentState, 'getGlobalPersistentState').resolves(state);
        sinon.stub(managerReady, 'waitForAllEnvManagers').resolves();
        showQuickPickWithToggle = sinon.stub(windowApis, 'showQuickPickWithToggle');
        pickEnvironment = sinon.stub(environmentPickers, 'pickEnvironmentFrom');

        const getEnvironments = sinon.stub();
        getEnvironments.withArgs('global').resolves([environment]);
        getEnvironments.withArgs('all').resolves([environment, virtualEnvironment]);

        envManagers = {
            managers: [{ getEnvironments }],
        } as unknown as EnvironmentManagers;
    });

    teardown(() => {
        sinon.restore();
    });

    test('remembers continuing globally when the toggle is enabled', async () => {
        showQuickPickWithToggle.resolves({
            item: { label: l10n.t('Continue Globally') },
            toggled: true,
        });

        const result = await selectPackageManagementEnvironment(envManagers, environment, { install: ['example'] });

        assert.strictEqual(result, environment);
        assert.deepStrictEqual(showQuickPickWithToggle.firstCall.args[2], {
            off: { label: `$(circle-large-outline) ${l10n.t('Remember my selection')}`, alwaysShow: true },
            on: { label: `$(check) ${l10n.t('Remember my selection')}`, alwaysShow: true },
        });
        sinon.assert.calledOnceWithExactly(setState, GLOBAL_PACKAGE_INSTALLATION_SELECTION_KEY, { kind: 'global' });
    });

    test('does not prompt when continuing globally was remembered', async () => {
        getState.resolves({ kind: 'global' });

        const result = await selectPackageManagementEnvironment(envManagers, environment, { install: ['example'] });

        assert.strictEqual(result, environment);
        sinon.assert.notCalled(showQuickPickWithToggle);
        sinon.assert.notCalled(setState);
    });

    test('remembers the selected existing virtual environment', async () => {
        showQuickPickWithToggle.resolves({
            item: { label: l10n.t('Use Existing Virtual Environment') },
            toggled: true,
        });
        pickEnvironment.resolves(virtualEnvironment);

        const result = await selectPackageManagementEnvironment(envManagers, environment, { install: ['example'] });

        assert.strictEqual(result, virtualEnvironment);
        sinon.assert.calledOnceWithExactly(setState, GLOBAL_PACKAGE_INSTALLATION_SELECTION_KEY, {
            kind: 'environment',
            managerId: 'test-manager',
            environmentId: 'virtual-environment',
        });
    });

    test('uses a remembered virtual environment without prompting', async () => {
        getState.resolves({
            kind: 'environment',
            managerId: 'test-manager',
            environmentId: 'virtual-environment',
        });

        const result = await selectPackageManagementEnvironment(envManagers, environment, { install: ['example'] });

        assert.strictEqual(result, virtualEnvironment);
        sinon.assert.notCalled(showQuickPickWithToggle);
        sinon.assert.notCalled(pickEnvironment);
    });
});
