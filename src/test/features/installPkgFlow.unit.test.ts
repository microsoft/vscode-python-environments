import * as sinon from 'sinon';
import * as TypeMoq from 'typemoq';
import * as frameUtils from '../../common/utils/frameUtils';
import * as workspaceApi from '../../common/workspace.apis';
import { EnvironmentManagers, PythonProjectManager, ProjectCreators } from '../../internal.api';
import { PythonEnvironment, PackageInstallOptions, PythonEnvironmentApi } from '../../api';
import { getPythonApi, setPythonApi, SettingsPackageTrust } from '../../features/pythonApi';
import { TerminalManager } from '../../features/terminal/terminalManager';
import { EnvVarManager } from '../../features/execution/envVariableManager';
import { MockWorkspaceConfiguration } from '../mocks/mockWorkspaceConfig';
import * as utils from '../../features/utils';

suite('installPackages Function', () => {
    let envManagersMock: TypeMoq.IMock<EnvironmentManagers>;
    let projectManagerMock: TypeMoq.IMock<PythonProjectManager>;
    let projectCreatorsMock: TypeMoq.IMock<ProjectCreators>;
    let terminalManagerMock: TypeMoq.IMock<TerminalManager>;
    let envVarManagerMock: TypeMoq.IMock<EnvVarManager>;
    let api: PythonEnvironmentApi;
    let WorkspaceConfigurationMock: MockWorkspaceConfiguration;

    setup(async () => {
        envManagersMock = TypeMoq.Mock.ofType<EnvironmentManagers>();
        projectManagerMock = TypeMoq.Mock.ofType<PythonProjectManager>();
        projectCreatorsMock = TypeMoq.Mock.ofType<ProjectCreators>();
        terminalManagerMock = TypeMoq.Mock.ofType<TerminalManager>();
        envVarManagerMock = TypeMoq.Mock.ofType<EnvVarManager>();

        setPythonApi(
            envManagersMock.object,
            projectManagerMock.object,
            projectCreatorsMock.object,
            terminalManagerMock.object,
            envVarManagerMock.object,
        );
        api = await getPythonApi();
    });

    teardown(() => {
        sinon.restore();
    });

    test('should install packages successfully', async () => {
        sinon.stub(frameUtils, 'getCallingExtension').returns('publisher.testExtension');
        sinon.stub(utils, 'promptForAlwaysAsk').returns(Promise.resolve('Yes, Install'));

        WorkspaceConfigurationMock = new MockWorkspaceConfiguration({
            extensionPackageTrust: {
                'publisher.testExtension': 'alwaysAsk',
                'publisher.testExtension2': 'alwaysAsk',
            } as SettingsPackageTrust,
        });

        sinon.stub(workspaceApi, 'getConfiguration').returns(WorkspaceConfigurationMock);
        const context = TypeMoq.Mock.ofType<PythonEnvironment>().object;
        const packages = ['package1', 'package2'];
        const options = TypeMoq.Mock.ofType<PackageInstallOptions>().object;

        const installStub = sinon.stub().returns({
            install: sinon.stub().resolves(),
        });
        envManagersMock.setup((m) => m.getPackageManager(TypeMoq.It.isAny())).returns(installStub as any);

        await api.installPackages(context, packages, options);
        sinon.assert.calledOnce(installStub);
        try {
            sinon.assert.calledWith(installStub().install, context, packages, options);
        } catch (error) {
            console.error('Expected installStub to be called with:', context, packages, options);
            console.error('But it was called with:', installStub.getCall(0).args);
            throw error;
        }
    });
});
