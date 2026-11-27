import assert from 'node:assert';
import * as sinon from 'sinon';
import * as typemoq from 'typemoq';
import { ProgressLocation, Uri } from 'vscode';
import { PythonProjectCreator } from '../../api';
import { ProjectCreatorString } from '../../common/localize';
import * as windowApis from '../../common/window.apis';
import * as workspaceApis from '../../common/workspace.apis';
import { AutoFindProjects } from '../../features/creators/autoFindProjects';
import { addPythonProjectCommand } from '../../features/envCommands';
import type { EnvironmentManagers } from '../../features/envManagers';
import type { ProjectCreators } from '../../features/creators/projectCreators';
import type { PythonProjectManager } from '../../features/projectManager';

suite('Add Python project quick pick', () => {
    let findFilesStub: sinon.SinonStub;
    let showErrorMessageStub: sinon.SinonStub;
    let withProgressStub: sinon.SinonStub;

    setup(() => {
        findFilesStub = sinon.stub(workspaceApis, 'findFiles');
        sinon.stub(workspaceApis, 'getWorkspaceFolders').returns(undefined);
        showErrorMessageStub = sinon.stub(windowApis, 'showErrorMessage');
        sinon.stub(windowApis, 'showWarningMessage');
        withProgressStub = sinon
            .stub(windowApis, 'withProgress')
            .callsFake((_options, task) => task({ report: () => undefined }, {} as never));
    });

    teardown(() => sinon.restore());

    function creators(projectManager: PythonProjectManager, envManagers: EnvironmentManagers): PythonProjectCreator[] {
        return [
            new AutoFindProjects(projectManager, envManagers),
            {
                name: 'existingProjects',
                description: 'Select existing Python projects',
                create: async () => undefined,
            },
            {
                name: 'newPackage',
                displayName: 'Package',
                create: async () => undefined,
            },
        ];
    }

    test('adds a discovered project from the first quick pick without an error', async () => {
        findFilesStub.resolves([Uri.file('/workspace/root/pkg/pyproject.toml')]);
        const projectManager = typemoq.Mock.ofType<PythonProjectManager>();
        projectManager.setup((pm) => pm.get(typemoq.It.isAny())).returns(() => undefined);
        projectManager
            .setup((pm) => pm.getProjects())
            .returns(() => [{ name: 'root', uri: Uri.file('/workspace/root') }]);
        projectManager.setup((pm) => pm.add(typemoq.It.isAny())).returns(() => Promise.resolve());
        const refresh = sinon.stub().resolves();
        const envManagers = {
            getEnvironment: async () => undefined,
            managers: [{ refresh }],
        } as unknown as EnvironmentManagers;
        const picker = sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async (items) => {
            assert.ok(!items.some((item) => item.label === 'Auto Find'));
            return items.find((item) => item.label === 'pkg');
        });

        await addPythonProjectCommand(undefined, projectManager.object, envManagers, {
            getProjectCreators: () => creators(projectManager.object, envManagers),
        } as ProjectCreators);

        sinon.assert.calledOnce(picker);
        sinon.assert.calledOnce(withProgressStub);
        assert.deepStrictEqual(withProgressStub.firstCall.args[0], {
            location: ProgressLocation.Window,
            title: ProjectCreatorString.findingProjects,
        });
        projectManager.verify((pm) => pm.add(typemoq.It.isAny()), typemoq.Times.once());
        assert.ok(refresh.calledOnce);
        assert.ok(showErrorMessageStub.notCalled);
    });

    test('hides Auto Find and does not report no projects found when discovery is empty', async () => {
        findFilesStub.resolves([]);
        const projectManager = typemoq.Mock.ofType<PythonProjectManager>();
        projectManager
            .setup((pm) => pm.getProjects())
            .returns(() => [{ name: 'root', uri: Uri.file('/workspace/root') }]);
        const envManagers = {
            getEnvironment: async () => undefined,
            managers: [{ refresh: sinon.stub().resolves() }],
        } as unknown as EnvironmentManagers;
        const picker = sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async (items, options) => {
            assert.deepStrictEqual(
                items.filter((item) => item.label).map((item) => item.label),
                ['Select Existing', 'Create New'],
            );
            assert.strictEqual(options?.title, undefined);
            assert.ok(options?.placeHolder?.includes('project'));
            return undefined;
        });

        await addPythonProjectCommand(undefined, projectManager.object, envManagers, {
            getProjectCreators: () => creators(projectManager.object, envManagers),
        } as ProjectCreators);

        sinon.assert.calledOnce(picker);
        sinon.assert.calledOnce(withProgressStub);
        assert.ok(showErrorMessageStub.notCalled);
    });
});
