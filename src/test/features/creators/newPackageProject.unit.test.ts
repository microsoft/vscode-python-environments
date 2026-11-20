import assert from 'node:assert';
import fsExtra from 'fs-extra';
import * as path from 'path';
import * as sinon from 'sinon';
import { QuickInputButtons, QuickPickItem, Uri, WorkspaceFolder } from 'vscode';
import { PythonEnvironment, PythonProject } from '../../../api';
import { NEW_PROJECT_TEMPLATES_FOLDER } from '../../../common/constants';
import { Interpreter } from '../../../common/localize';
import * as environmentPickers from '../../../common/pickers/environments';
import * as windowApis from '../../../common/window.apis';
import * as workspaceApis from '../../../common/workspace.apis';
import * as creationHelpers from '../../../features/creators/creationHelpers';
import { NewPackageProject } from '../../../features/creators/newPackageProject';
import type { EnvironmentManagers } from '../../../features/envManagers';
import type { PythonProjectManager } from '../../../features/projectManager';
import * as settingHelpers from '../../../features/settings/settingHelpers';
import type { InternalEnvironmentManager } from '../../../managers/common/registeredManagers';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

suite('NewPackageProject', () => {
    const packageName = 'sample_package';
    const workspaceRoot = path.join(process.cwd(), 'package-project-workspace');
    const rootUri = Uri.file(workspaceRoot);
    const projectDestination = path.join(rootUri.fsPath, `${packageName}_project`);
    const templateFolder = path.resolve(path.join(NEW_PROJECT_TEMPLATES_FOLDER, 'newPackageTemplate'));
    const workspaceFolder: WorkspaceFolder = {
        index: 0,
        name: 'workspace',
        uri: rootUri,
    };

    let existingEnvironment: PythonEnvironment;
    let createdEnvironment: PythonEnvironment;
    let manager: InternalEnvironmentManager;
    let envManagers: EnvironmentManagers;
    let projectManager: PythonProjectManager;
    let managerCreate: sinon.SinonStub;
    let managerGetEnvironments: sinon.SinonStub;
    let managerSet: sinon.SinonStub;
    let getEnvironmentManager: sinon.SinonStub;
    let getProjectEnvManagers: sinon.SinonStub;
    let getEnvironment: sinon.SinonStub;
    let setEnvironment: sinon.SinonStub;
    let addProject: sinon.SinonStub;
    let getProject: sinon.SinonStub;
    let removeProject: sinon.SinonStub;
    let claimProjectFolder: sinon.SinonStub;
    let copyTemplate: sinon.SinonStub;
    let removeFolder: sinon.SinonStub;
    let removeProjectSetting: sinon.SinonStub;
    let manageLaunchJsonFile: sinon.SinonStub;
    let showErrorMessage: sinon.SinonStub;
    let showInputBox: sinon.SinonStub;
    let registeredProject: PythonProject | undefined;

    setup(() => {
        existingEnvironment = createMockPythonEnvironment({
            name: 'existing',
            envPath: path.join(process.cwd(), 'existing-venv', 'python'),
            managerId: 'test:venv',
        });
        createdEnvironment = createMockPythonEnvironment({
            name: 'created',
            envPath: path.join(projectDestination, '.venv', 'python'),
            managerId: 'test:venv',
        });
        managerCreate = sinon.stub().resolves(createdEnvironment);
        managerGetEnvironments = sinon.stub().resolves([]);
        managerSet = sinon.stub().resolves();
        manager = {
            id: 'test:venv',
            displayName: 'Test environments',
            supportsCreate: true,
            supportsQuickCreate: true,
            create: managerCreate,
            getEnvironments: managerGetEnvironments,
            set: managerSet,
        } as unknown as InternalEnvironmentManager;
        getEnvironmentManager = sinon.stub().returns(manager);
        getProjectEnvManagers = sinon.stub().returns([manager]);
        getEnvironment = sinon.stub().resolves(undefined);
        setEnvironment = sinon.stub().resolves();
        envManagers = {
            managers: [manager],
            getEnvironmentManager,
            getProjectEnvManagers,
            getEnvironment,
            setEnvironment,
        } as unknown as EnvironmentManagers;
        registeredProject = undefined;
        addProject = sinon.stub().callsFake(async (project: PythonProject) => {
            registeredProject = project;
        });
        getProject = sinon.stub().callsFake(() => registeredProject);
        removeProject = sinon.stub().callsFake((project: PythonProject) => {
            if (registeredProject === project) {
                registeredProject = undefined;
            }
        });
        projectManager = {
            add: addProject,
            get: getProject,
            remove: removeProject,
        } as unknown as PythonProjectManager;

        showInputBox = sinon.stub(windowApis, 'showInputBoxWithButtons').resolves(packageName);
        showErrorMessage = sinon.stub(windowApis, 'showErrorMessage');
        sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([workspaceFolder]);
        sinon.stub(creationHelpers, 'isCopilotInstalled').returns(false);
        sinon.stub(creationHelpers, 'replaceInFilesAndNames').resolves();
        sinon.stub(creationHelpers, 'manageCopilotInstructionsFile').resolves();
        manageLaunchJsonFile = sinon.stub(creationHelpers, 'manageLaunchJsonFile').resolves();
        sinon.stub(fsExtra, 'pathExists').callsFake(async (checkedPath) => {
            return path.resolve(String(checkedPath)) === templateFolder;
        });
        claimProjectFolder = sinon.stub(fsExtra, 'mkdir').resolves();
        copyTemplate = sinon.stub(fsExtra, 'copy').resolves();
        removeFolder = sinon.stub(fsExtra, 'remove').resolves();
        removeProjectSetting = sinon.stub(settingHelpers, 'removePythonProjectSetting').resolves();
    });

    teardown(() => {
        sinon.restore();
    });

    function assertProject(project: PythonProject | Uri | undefined): asserts project is PythonProject {
        assert.ok(project);
        assert.ok(!(project instanceof Uri));
        assert.strictEqual(project.name, packageName);
        assert.strictEqual(project.uri.fsPath, Uri.file(projectDestination).fsPath);
    }

    test('creates and assigns a new environment when requested', async () => {
        const promptForVenv = sinon.stub(creationHelpers, 'promptForVenv').resolves(true);
        const pickEnvironment = sinon.stub(environmentPickers, 'pickEnvironment');
        const creator = new NewPackageProject(envManagers, projectManager);

        const result = await creator.create();

        assertProject(result);
        sinon.assert.calledOnce(promptForVenv);
        sinon.assert.notCalled(pickEnvironment);
        sinon.assert.calledOnce(managerCreate);
        const [creationScope, creationOptions] = managerCreate.firstCall.args;
        assert.strictEqual((creationScope as Uri).fsPath, result.uri.fsPath);
        assert.deepStrictEqual(creationOptions, { quickCreate: true });
        sinon.assert.calledOnceWithExactly(setEnvironment, result.uri, createdEnvironment);
        sinon.assert.calledOnceWithExactly(claimProjectFolder, projectDestination);
        sinon.assert.callOrder(claimProjectFolder, copyTemplate, addProject, managerCreate, setEnvironment);
    });

    test('keeps quick-create mode noninteractive', async () => {
        const promptForVenv = sinon.stub(creationHelpers, 'promptForVenv');
        const pickEnvironment = sinon.stub(environmentPickers, 'pickEnvironment');
        const creator = new NewPackageProject(envManagers, projectManager);

        const result = await creator.create({
            name: packageName,
            rootUri,
            quickCreate: true,
        });

        assertProject(result);
        sinon.assert.notCalled(showInputBox);
        sinon.assert.notCalled(promptForVenv);
        sinon.assert.notCalled(pickEnvironment);
        sinon.assert.calledOnceWithExactly(claimProjectFolder, projectDestination);
        sinon.assert.calledOnce(copyTemplate);
        sinon.assert.calledOnceWithExactly(addProject, result);
        sinon.assert.calledOnce(managerCreate);
        sinon.assert.calledOnceWithExactly(setEnvironment, result.uri, createdEnvironment);
        sinon.assert.calledOnce(manageLaunchJsonFile);
    });

    test('uses a file URI when resolving an environment created without a returned descriptor', async () => {
        sinon.stub(creationHelpers, 'promptForVenv').resolves(true);
        managerCreate.resolves(undefined);
        getEnvironment.resolves(createdEnvironment);
        const creator = new NewPackageProject(envManagers, projectManager);

        const result = await creator.create();

        assertProject(result);
        sinon.assert.calledOnce(getEnvironment);
        const scope = getEnvironment.firstCall.args[0];
        assert.ok(scope instanceof Uri);
        assert.strictEqual(scope.fsPath, result.uri.fsPath);
        sinon.assert.calledOnceWithExactly(setEnvironment, result.uri, createdEnvironment);
    });

    test('does not replace a stale exact project registration', async () => {
        sinon.stub(creationHelpers, 'promptForVenv').resolves(false);
        const pickEnvironment = sinon.stub(environmentPickers, 'pickEnvironment');
        registeredProject = {
            name: 'stale',
            uri: Uri.file(projectDestination),
        };
        const creator = new NewPackageProject(envManagers, projectManager);

        const result = await creator.create();

        assert.strictEqual(result, undefined);
        sinon.assert.calledOnce(showErrorMessage);
        sinon.assert.notCalled(pickEnvironment);
        sinon.assert.notCalled(claimProjectFolder);
        sinon.assert.notCalled(copyTemplate);
        sinon.assert.notCalled(addProject);
        sinon.assert.notCalled(removeProjectSetting);
        sinon.assert.notCalled(removeProject);
        assert.strictEqual(registeredProject.name, 'stale');
    });

    test('selects and assigns an existing environment before completing project creation', async () => {
        sinon.stub(creationHelpers, 'promptForVenv').resolves(false);
        const pickEnvironment = sinon.stub(environmentPickers, 'pickEnvironment').resolves(existingEnvironment);
        const creator = new NewPackageProject(envManagers, projectManager);

        const result = await creator.create();

        assertProject(result);
        sinon.assert.calledOnce(pickEnvironment);
        const [availableManagers, projectManagers, options] = pickEnvironment.firstCall.args;
        assert.strictEqual(availableManagers, envManagers.managers);
        assert.deepStrictEqual(projectManagers, [manager]);
        assert.strictEqual(options.showBackButton, true);
        assert.strictEqual(options.showCreateEnvironment, false);
        assert.strictEqual(options.projects.length, 1);
        assert.strictEqual(options.projects[0].uri.fsPath, result.uri.fsPath);
        sinon.assert.calledOnceWithExactly(setEnvironment, result.uri, existingEnvironment);
        sinon.assert.notCalled(managerCreate);
        sinon.assert.calledOnceWithExactly(claimProjectFolder, projectDestination);
        sinon.assert.callOrder(
            pickEnvironment,
            claimProjectFolder,
            copyTemplate,
            addProject,
            setEnvironment,
            manageLaunchJsonFile,
        );
    });

    test('cancels without copying or registering a project when no environment is selected', async () => {
        sinon.stub(creationHelpers, 'promptForVenv').resolves(false);
        sinon.stub(environmentPickers, 'pickEnvironment').resolves(undefined);
        const creator = new NewPackageProject(envManagers, projectManager);

        const result = await creator.create();

        assert.strictEqual(result, undefined);
        sinon.assert.notCalled(copyTemplate);
        sinon.assert.notCalled(addProject);
        sinon.assert.notCalled(setEnvironment);
        sinon.assert.notCalled(claimProjectFolder);
        sinon.assert.notCalled(removeProjectSetting);
        sinon.assert.notCalled(removeProject);
        sinon.assert.notCalled(removeFolder);
    });

    test('returns to the virtual environment choice when the environment picker goes back', async () => {
        const promptForVenv = sinon.stub(creationHelpers, 'promptForVenv');
        promptForVenv.onFirstCall().resolves(false);
        promptForVenv.onSecondCall().resolves(true);
        const pickEnvironment = sinon
            .stub(environmentPickers, 'pickEnvironment')
            .rejects(QuickInputButtons.Back);
        const creator = new NewPackageProject(envManagers, projectManager);

        const result = await creator.create();

        assertProject(result);
        sinon.assert.calledTwice(promptForVenv);
        sinon.assert.calledOnce(pickEnvironment);
        sinon.assert.calledOnce(managerCreate);
        sinon.assert.calledOnceWithExactly(setEnvironment, result.uri, createdEnvironment);
    });

    test('leaves the workspace unchanged when no environments are discovered and the picker is cancelled', async () => {
        sinon.stub(creationHelpers, 'promptForVenv').resolves(false);
        managerGetEnvironments.resolves([]);
        const showPicker = sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async (items) => {
            const pickerItems = items as readonly (QuickPickItem & { result?: PythonEnvironment })[];
            assert.ok(!pickerItems.some((item) => item.result), 'No discovered environment should be offered');
            assert.ok(
                !pickerItems.some((item) => item.label === Interpreter.createVirtualEnvironment),
                'Creation should stay hidden after the user declined it',
            );
            return undefined;
        });
        const creator = new NewPackageProject(envManagers, projectManager);

        const result = await creator.create();

        assert.strictEqual(result, undefined);
        sinon.assert.calledOnce(showPicker);
        sinon.assert.calledOnce(managerGetEnvironments);
        sinon.assert.notCalled(copyTemplate);
        sinon.assert.notCalled(addProject);
        sinon.assert.notCalled(setEnvironment);
        sinon.assert.notCalled(claimProjectFolder);
    });

    test('propagates environment discovery failures before changing the workspace', async () => {
        sinon.stub(creationHelpers, 'promptForVenv').resolves(false);
        const discoveryError = new Error('environment discovery failed');
        sinon.stub(environmentPickers, 'pickEnvironment').rejects(discoveryError);
        const creator = new NewPackageProject(envManagers, projectManager);

        await assert.rejects(creator.create(), discoveryError);

        sinon.assert.notCalled(copyTemplate);
        sinon.assert.notCalled(addProject);
        sinon.assert.notCalled(setEnvironment);
        sinon.assert.notCalled(claimProjectFolder);
        sinon.assert.notCalled(removeFolder);
    });

    test('does not overwrite a destination created while the environment picker is open', async () => {
        sinon.stub(creationHelpers, 'promptForVenv').resolves(false);
        sinon.stub(environmentPickers, 'pickEnvironment').resolves(existingEnvironment);
        claimProjectFolder.rejects(Object.assign(new Error('already exists'), { code: 'EEXIST' }));
        const creator = new NewPackageProject(envManagers, projectManager);

        const result = await creator.create();

        assert.strictEqual(result, undefined);
        sinon.assert.calledOnceWithExactly(claimProjectFolder, projectDestination);
        sinon.assert.calledOnce(showErrorMessage);
        sinon.assert.notCalled(copyTemplate);
        sinon.assert.notCalled(addProject);
        sinon.assert.notCalled(setEnvironment);
        sinon.assert.notCalled(removeFolder);
    });

    test('removes only the claimed folder when project registration fails before mutation', async () => {
        sinon.stub(creationHelpers, 'promptForVenv').resolves(false);
        sinon.stub(environmentPickers, 'pickEnvironment').resolves(existingEnvironment);
        addProject.rejects(new Error('registration failed'));
        const creator = new NewPackageProject(envManagers, projectManager);

        await assert.rejects(creator.create(), /registration failed/);

        sinon.assert.calledOnceWithExactly(claimProjectFolder, projectDestination);
        sinon.assert.notCalled(removeProjectSetting);
        sinon.assert.notCalled(removeProject);
        sinon.assert.calledOnceWithExactly(removeFolder, projectDestination);
    });

    test('stops when project registration does not retain the created project', async () => {
        sinon.stub(creationHelpers, 'promptForVenv').resolves(false);
        sinon.stub(environmentPickers, 'pickEnvironment').resolves(existingEnvironment);
        const concurrentProject: PythonProject = {
            name: 'concurrent',
            uri: Uri.file(projectDestination),
        };
        addProject.callsFake(async () => {
            registeredProject = concurrentProject;
        });
        const creator = new NewPackageProject(envManagers, projectManager);

        await assert.rejects(creator.create(), /could not be registered/);

        sinon.assert.notCalled(removeProjectSetting);
        sinon.assert.notCalled(removeProject);
        sinon.assert.calledOnceWithExactly(removeFolder, projectDestination);
        sinon.assert.notCalled(setEnvironment);
        assert.strictEqual(registeredProject, concurrentProject);
    });

    test('rolls back the project and files when assigning the selected environment fails', async () => {
        sinon.stub(creationHelpers, 'promptForVenv').resolves(false);
        sinon.stub(environmentPickers, 'pickEnvironment').resolves(existingEnvironment);
        const assignmentError = new Error('environment assignment failed');
        const defaultManager = {
            id: 'test:default',
            set: sinon.stub().resolves(),
        } as unknown as InternalEnvironmentManager;
        getEnvironmentManager.callsFake((scope) => (scope instanceof Uri ? defaultManager : manager));
        setEnvironment.onFirstCall().rejects(assignmentError);
        setEnvironment.onSecondCall().resolves();
        const creator = new NewPackageProject(envManagers, projectManager);

        await assert.rejects(creator.create(), assignmentError);

        sinon.assert.calledTwice(setEnvironment);
        const [assignmentUri, assignedEnvironment] = setEnvironment.firstCall.args;
        assert.strictEqual((assignmentUri as Uri).fsPath, Uri.file(projectDestination).fsPath);
        assert.strictEqual(assignedEnvironment, existingEnvironment);
        const [clearUri, clearedEnvironment, shouldPersist] = setEnvironment.secondCall.args;
        assert.strictEqual((clearUri as Uri).fsPath, Uri.file(projectDestination).fsPath);
        assert.strictEqual(clearedEnvironment, undefined);
        assert.strictEqual(shouldPersist, false);
        sinon.assert.calledOnceWithExactly(managerSet, sinon.match.instanceOf(Uri), undefined);
        const selectedManagerScope = managerSet.firstCall.args[0] as Uri;
        assert.strictEqual(selectedManagerScope.fsPath, Uri.file(projectDestination).fsPath);
        sinon.assert.notCalled(managerGetEnvironments);
        sinon.assert.notCalled(defaultManager.set as sinon.SinonStub);
        sinon.assert.calledOnce(removeProjectSetting);
        const removedSettingProject = removeProjectSetting.firstCall.args[0][0].project as PythonProject;
        assert.strictEqual(removedSettingProject.uri.fsPath, Uri.file(projectDestination).fsPath);
        sinon.assert.calledOnce(removeProject);
        const removedProject = removeProject.firstCall.args[0] as PythonProject;
        assert.strictEqual(removedProject.uri.fsPath, Uri.file(projectDestination).fsPath);
        sinon.assert.calledOnceWithExactly(removeFolder, projectDestination);
        sinon.assert.notCalled(manageLaunchJsonFile);
    });

    test('does not clear the selected manager twice when central rollback owns its scope', async () => {
        sinon.stub(creationHelpers, 'promptForVenv').resolves(false);
        sinon.stub(environmentPickers, 'pickEnvironment').resolves(existingEnvironment);
        setEnvironment.onFirstCall().rejects(new Error('environment assignment failed'));
        setEnvironment.onSecondCall().resolves();
        const creator = new NewPackageProject(envManagers, projectManager);

        await assert.rejects(creator.create(), /environment assignment failed/);

        sinon.assert.calledTwice(setEnvironment);
        const [clearUri, clearedEnvironment, shouldPersist] = setEnvironment.secondCall.args;
        assert.ok(clearUri instanceof Uri);
        assert.strictEqual(clearUri.fsPath, Uri.file(projectDestination).fsPath);
        assert.strictEqual(clearedEnvironment, undefined);
        assert.strictEqual(shouldPersist, false);
        sinon.assert.notCalled(managerSet);
        sinon.assert.calledOnce(removeProjectSetting);
        sinon.assert.calledOnce(removeProject);
        sinon.assert.calledOnceWithExactly(removeFolder, projectDestination);
    });
});
