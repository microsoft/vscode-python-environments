import * as sinon from 'sinon';
import * as frameUtils from '../../common/utils/frameUtils';
import * as workspaceApi from '../../common/workspace.apis';
import { MockWorkspaceConfiguration } from '../mocks/mockWorkspaceConfig';
import * as utils from '../../features/utils';
import { InstallPermissionEnum, packageManagementFlow, SimpleResponseEnum } from '../../features/packageManagement';

suite('packageManagementFlow Unit test', () => {
    let WorkspaceConfigurationMock: MockWorkspaceConfiguration;

    setup(async () => {});

    teardown(() => {
        sinon.restore();
    });

    test('should use permissions prompt user when no allowAutoPackageManagement config exists', async () => {
        sinon.stub(frameUtils, 'getCallingExtension').returns('publisher.testExtension');
        const installPermissionsPromptStub = sinon
            .stub(utils, 'promptForInstallPermissions')
            .returns(Promise.resolve(InstallPermissionEnum.AlwaysAsk));

        WorkspaceConfigurationMock = new MockWorkspaceConfiguration({});

        sinon.stub(workspaceApi, 'getConfiguration').returns(WorkspaceConfigurationMock);
        const packages = ['package1', 'package2'];

        await packageManagementFlow(packages);
        // assert that the permissions prompt was shown
        sinon.assert.calledOnce(installPermissionsPromptStub);
    });

    test('should use permissions prompt when no matching ext entry exists', async () => {
        sinon.stub(frameUtils, 'getCallingExtension').returns('publisher.testExtension');

        const installPermissionsPromptStub = sinon
            .stub(utils, 'promptForInstallPermissions')
            .returns(Promise.resolve(InstallPermissionEnum.AlwaysAsk));

        WorkspaceConfigurationMock = new MockWorkspaceConfiguration({
            allowAutoPackageManagement: { 'random.extension': 'alwaysAllow' } as utils.SettingsPackageTrust,
        });

        sinon.stub(workspaceApi, 'getConfiguration').returns(WorkspaceConfigurationMock);
        const packages = ['package1', 'package2'];

        await packageManagementFlow(packages);
        sinon.assert.calledOnce(installPermissionsPromptStub);
    });
    test('should use wildcard config when ext config is not found', async () => {
        sinon.stub(frameUtils, 'getCallingExtension').returns('publisher.testExtension');
        const promptAlwaysAskStub = sinon
            .stub(utils, 'promptForAlwaysAsk')
            .returns(Promise.resolve(SimpleResponseEnum.YesInstall));

        WorkspaceConfigurationMock = new MockWorkspaceConfiguration({
            allowAutoPackageManagement: {
                '*': 'alwaysAsk',
            } as utils.SettingsPackageTrust,
        });

        sinon.stub(workspaceApi, 'getConfiguration').returns(WorkspaceConfigurationMock);
        const packages = ['package1', 'package2'];

        await packageManagementFlow(packages);
        // assert alwaysAsk prompt was shown
        sinon.assert.notCalled(sinon.stub(utils, 'promptForInstallPermissions'));
        sinon.assert.calledOnce(promptAlwaysAskStub);

        sinon.assert.pass(true);
    });
    test('should ignore wildcard config when ext config is found', async () => {
        sinon.stub(frameUtils, 'getCallingExtension').returns('publisher.testExtension');
        const promptAlwaysAskStub = sinon
            .stub(utils, 'promptForAlwaysAsk')
            .returns(Promise.resolve(SimpleResponseEnum.YesInstall));
        WorkspaceConfigurationMock = new MockWorkspaceConfiguration({
            allowAutoPackageManagement: {
                'publisher.testExtension': 'alwaysAsk',
                '*': 'alwaysAllow',
            } as utils.SettingsPackageTrust,
        });

        sinon.stub(workspaceApi, 'getConfiguration').returns(WorkspaceConfigurationMock);
        const packages = ['package1', 'package2'];

        await packageManagementFlow(packages);

        sinon.assert.calledOnce(promptAlwaysAskStub);
    });

    test('should update config when user selects always ask or always allow', async () => {
        sinon.stub(frameUtils, 'getCallingExtension').returns('publisher.testExtension');
        const promptForInstallPermissionsStub = sinon
            .stub(utils, 'promptForInstallPermissions')
            .returns(Promise.resolve(InstallPermissionEnum.AlwaysAllow));

        WorkspaceConfigurationMock = new MockWorkspaceConfiguration({});

        const updateStub = sinon.stub(WorkspaceConfigurationMock, 'update');
        sinon.stub(workspaceApi, 'getConfiguration').returns(WorkspaceConfigurationMock);
        const packages = ['package1', 'package2'];

        await packageManagementFlow(packages);
        sinon.assert.calledOnce(updateStub);
        sinon.assert.calledOnce(promptForInstallPermissionsStub);
    });

    test('should not update config when user selects install no configure', async () => {
        sinon.stub(frameUtils, 'getCallingExtension').returns('publisher.testExtension');
        const promptForInstallPermissionsStub = sinon
            .stub(utils, 'promptForInstallPermissions')
            .returns(Promise.resolve(InstallPermissionEnum.InstallNoConfigure));

        WorkspaceConfigurationMock = new MockWorkspaceConfiguration({});

        const updateStub = sinon.stub(WorkspaceConfigurationMock, 'update');
        sinon.stub(workspaceApi, 'getConfiguration').returns(WorkspaceConfigurationMock);
        const packages = ['package1', 'package2'];

        await packageManagementFlow(packages);
        sinon.assert.notCalled(updateStub);
        sinon.assert.calledOnce(promptForInstallPermissionsStub);

        sinon.assert.pass(true);
    });

    test('should cancel installation when user cancels promptForInstallPermissions', async () => {
        sinon.stub(frameUtils, 'getCallingExtension').returns('publisher.testExtension');
        const promptForInstallPermissionsStub = sinon
            .stub(utils, 'promptForInstallPermissions')
            .returns(Promise.resolve(InstallPermissionEnum.Cancel));

        WorkspaceConfigurationMock = new MockWorkspaceConfiguration({});

        sinon.stub(workspaceApi, 'getConfiguration').returns(WorkspaceConfigurationMock);
        const packages = ['package1', 'package2'];

        try {
            await packageManagementFlow(packages);
        } catch (error) {
            sinon.assert.match(error, 'User cancelled the package installation.');
        }
        sinon.assert.calledOnce(promptForInstallPermissionsStub);
    });
    test('should cancel when user selects noInstall during promptForAlwaysAsk', async () => {
        sinon.stub(frameUtils, 'getCallingExtension').returns('publisher.testExtension');
        const promptAlwaysAskStub = sinon
            .stub(utils, 'promptForAlwaysAsk')
            .returns(Promise.resolve(SimpleResponseEnum.NoInstall));
        WorkspaceConfigurationMock = new MockWorkspaceConfiguration({
            allowAutoPackageManagement: {
                'publisher.testExtension': 'alwaysAsk',
            } as utils.SettingsPackageTrust,
        });
        sinon.stub(workspaceApi, 'getConfiguration').returns(WorkspaceConfigurationMock);
        const packages = ['package1', 'package2'];
        try {
            await packageManagementFlow(packages);
        } catch (error) {
            sinon.assert.match(error, 'User cancelled the package installation.');
        }
        sinon.assert.calledOnce(promptAlwaysAskStub);
    });

    test('should prompt user for when configured to alwaysAsk', async () => {
        sinon.stub(frameUtils, 'getCallingExtension').returns('publisher.testExtension');
        const promptAlwaysAskStub = sinon
            .stub(utils, 'promptForAlwaysAsk')
            .returns(Promise.resolve(SimpleResponseEnum.YesInstall));

        WorkspaceConfigurationMock = new MockWorkspaceConfiguration({
            allowAutoPackageManagement: {
                'publisher.testExtension': 'alwaysAsk',
            } as utils.SettingsPackageTrust,
        });

        sinon.stub(workspaceApi, 'getConfiguration').returns(WorkspaceConfigurationMock);
        const packages = ['package1', 'package2'];

        await packageManagementFlow(packages);
        sinon.assert.calledOnce(promptAlwaysAskStub);
        sinon.assert.notCalled(sinon.stub(utils, 'promptForInstallPermissions'));
    });

    test('should show no prompts when trust level is always allow', async () => {
        sinon.stub(frameUtils, 'getCallingExtension').returns('publisher.testExtension');

        WorkspaceConfigurationMock = new MockWorkspaceConfiguration({
            allowAutoPackageManagement: {
                'publisher.testExtension': 'alwaysAllow',
            } as utils.SettingsPackageTrust,
        });

        sinon.stub(workspaceApi, 'getConfiguration').returns(WorkspaceConfigurationMock);
        const packages = ['package1', 'package2'];

        await packageManagementFlow(packages);
        //  assert that the install prompt was not shown when always allow
        sinon.assert.notCalled(sinon.stub(utils, 'promptForInstallPermissions'));
        sinon.assert.notCalled(sinon.stub(utils, 'promptForAlwaysAsk'));
        sinon.assert.pass(true);
    });
});
