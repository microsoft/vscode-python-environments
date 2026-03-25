import * as assert from 'assert';
import * as sinon from 'sinon';
import * as typeMoq from 'typemoq';
import { Uri } from 'vscode';
import { PythonEnvironment, PythonProject } from '../../api';
import * as commandApi from '../../common/command.api';
import * as envPickerApi from '../../common/pickers/environments';
import * as managerApi from '../../common/pickers/managers';
import * as projectApi from '../../common/pickers/projects';
import * as windowApis from '../../common/window.apis';
import { createAnyEnvironmentCommand, revealEnvInManagerView, setEnvironmentCommand } from '../../features/envCommands';
import { EnvManagerView } from '../../features/views/envManagersView';
import { ProjectEnvironment, ProjectItem } from '../../features/views/treeViewItems';
import { EnvironmentManagers, InternalEnvironmentManager, PythonProjectManager } from '../../internal.api';
import { setupNonThenable } from '../mocks/helper';

suite('Create Any Environment Command Tests', () => {
    let em: typeMoq.IMock<EnvironmentManagers>;
    let pm: typeMoq.IMock<PythonProjectManager>;
    let manager: typeMoq.IMock<InternalEnvironmentManager>;
    let env: typeMoq.IMock<PythonEnvironment>;
    let pickProjectManyStub: sinon.SinonStub;
    let pickEnvironmentManagerStub: sinon.SinonStub;
    let project: PythonProject = {
        uri: Uri.file('/some/test/workspace/folder'),
        name: 'test-folder',
    };
    let project2: PythonProject = {
        uri: Uri.file('/some/test/workspace/folder2'),
        name: 'test-folder2',
    };
    let project3: PythonProject = {
        uri: Uri.file('/some/test/workspace/folder3'),
        name: 'test-folder3',
    };

    setup(() => {
        manager = typeMoq.Mock.ofType<InternalEnvironmentManager>();
        manager.setup((m) => m.id).returns(() => 'test');
        manager.setup((m) => m.displayName).returns(() => 'Test Manager');
        manager.setup((m) => m.description).returns(() => 'Test Manager Description');
        manager.setup((m) => m.supportsCreate).returns(() => true);

        env = typeMoq.Mock.ofType<PythonEnvironment>();
        env.setup((e) => e.envId).returns(() => ({ id: 'env1', managerId: 'test' }));
        setupNonThenable(env);

        em = typeMoq.Mock.ofType<EnvironmentManagers>();
        em.setup((e) => e.managers).returns(() => [manager.object]);
        em.setup((e) => e.getEnvironmentManager(typeMoq.It.isAnyString())).returns(() => manager.object);

        pm = typeMoq.Mock.ofType<PythonProjectManager>();

        pickEnvironmentManagerStub = sinon.stub(managerApi, 'pickEnvironmentManager');
        pickProjectManyStub = sinon.stub(projectApi, 'pickProjectMany');
    });

    teardown(() => {
        sinon.restore();
    });

    test('Create global venv (no-workspace): no-select', async () => {
        pm.setup((p) => p.getProjects(typeMoq.It.isAny())).returns(() => []);
        manager
            .setup((m) => m.create('global', typeMoq.It.isAny()))
            .returns(() => Promise.resolve(env.object))
            .verifiable(typeMoq.Times.once());

        manager.setup((m) => m.set(typeMoq.It.isAny(), typeMoq.It.isAny())).verifiable(typeMoq.Times.never());

        pickEnvironmentManagerStub.resolves(manager.object.id);
        pickProjectManyStub.resolves([]);

        const result = await createAnyEnvironmentCommand(em.object, pm.object, { selectEnvironment: false });
        // Add assertions to verify the result
        assert.strictEqual(result, env.object, 'Expected the created environment to match the mocked environment.');
        manager.verifyAll();
    });

    test('Create global venv (no-workspace): select', async () => {
        pm.setup((p) => p.getProjects(typeMoq.It.isAny())).returns(() => []);
        manager
            .setup((m) => m.create('global', typeMoq.It.isAny()))
            .returns(() => Promise.resolve(env.object))
            .verifiable(typeMoq.Times.once());

        manager.setup((m) => m.set(undefined, env.object)).verifiable(typeMoq.Times.once());

        pickEnvironmentManagerStub.resolves(manager.object.id);
        pickProjectManyStub.resolves([]);

        const result = await createAnyEnvironmentCommand(em.object, pm.object, { selectEnvironment: true });
        // Add assertions to verify the result
        assert.strictEqual(result, env.object, 'Expected the created environment to match the mocked environment.');
        manager.verifyAll();
    });

    test('Create workspace venv: no-select', async () => {
        pm.setup((p) => p.getProjects(typeMoq.It.isAny())).returns(() => [project]);
        manager
            .setup((m) => m.create([project.uri], typeMoq.It.isAny()))
            .returns(() => Promise.resolve(env.object))
            .verifiable(typeMoq.Times.once());

        manager.setup((m) => m.set(typeMoq.It.isAny(), typeMoq.It.isAny())).verifiable(typeMoq.Times.never());
        em.setup((e) => e.setEnvironments(typeMoq.It.isAny(), typeMoq.It.isAny())).verifiable(typeMoq.Times.never());

        pickEnvironmentManagerStub.resolves(manager.object.id);
        pickProjectManyStub.resolves([project]);

        const result = await createAnyEnvironmentCommand(em.object, pm.object, { selectEnvironment: false });

        assert.strictEqual(result, env.object, 'Expected the created environment to match the mocked environment.');
        manager.verifyAll();
        em.verifyAll();
    });

    test('Create workspace venv: select', async () => {
        pm.setup((p) => p.getProjects(typeMoq.It.isAny())).returns(() => [project]);
        manager
            .setup((m) => m.create([project.uri], typeMoq.It.isAny()))
            .returns(() => Promise.resolve(env.object))
            .verifiable(typeMoq.Times.once());

        // This is a case where env managers handler does this in batch to avoid writing to files for each case
        manager.setup((m) => m.set(typeMoq.It.isAny(), typeMoq.It.isAny())).verifiable(typeMoq.Times.never());
        em.setup((e) => e.setEnvironments([project.uri], env.object)).verifiable(typeMoq.Times.once());

        pickEnvironmentManagerStub.resolves(manager.object.id);
        pickProjectManyStub.resolves([project]);

        const result = await createAnyEnvironmentCommand(em.object, pm.object, { selectEnvironment: true });

        assert.strictEqual(result, env.object, 'Expected the created environment to match the mocked environment.');
        manager.verifyAll();
        em.verifyAll();
    });

    test('Create multi-workspace venv: select all', async () => {
        pm.setup((p) => p.getProjects(typeMoq.It.isAny())).returns(() => [project, project2, project3]);
        manager
            .setup((m) => m.create([project.uri, project2.uri, project3.uri], typeMoq.It.isAny()))
            .returns(() => Promise.resolve(env.object))
            .verifiable(typeMoq.Times.once());

        // This is a case where env managers handler does this in batch to avoid writing to files for each case
        manager.setup((m) => m.set(typeMoq.It.isAny(), typeMoq.It.isAny())).verifiable(typeMoq.Times.never());
        em.setup((e) => e.setEnvironments([project.uri, project2.uri, project3.uri], env.object)).verifiable(
            typeMoq.Times.once(),
        );

        pickEnvironmentManagerStub.resolves(manager.object.id);
        pickProjectManyStub.resolves([project, project2, project3]);

        const result = await createAnyEnvironmentCommand(em.object, pm.object, { selectEnvironment: true });

        assert.strictEqual(result, env.object, 'Expected the created environment to match the mocked environment.');
        manager.verifyAll();
        em.verifyAll();
    });

    test('Create multi-workspace venv: select some', async () => {
        pm.setup((p) => p.getProjects(typeMoq.It.isAny())).returns(() => [project, project2, project3]);
        manager
            .setup((m) => m.create([project.uri, project3.uri], typeMoq.It.isAny()))
            .returns(() => Promise.resolve(env.object))
            .verifiable(typeMoq.Times.once());

        // This is a case where env managers handler does this in batch to avoid writing to files for each case
        manager.setup((m) => m.set(typeMoq.It.isAny(), typeMoq.It.isAny())).verifiable(typeMoq.Times.never());
        em.setup((e) => e.setEnvironments([project.uri, project3.uri], env.object)).verifiable(typeMoq.Times.once());

        pickEnvironmentManagerStub.resolves(manager.object.id);
        pickProjectManyStub.resolves([project, project3]);

        const result = await createAnyEnvironmentCommand(em.object, pm.object, { selectEnvironment: true });

        assert.strictEqual(result, env.object, 'Expected the created environment to match the mocked environment.');
        manager.verifyAll();
        em.verifyAll();
    });
});

suite('Reveal Env In Manager View Command Tests', () => {
    let managerView: typeMoq.IMock<EnvManagerView>;
    let executeCommandStub: sinon.SinonStub;

    setup(() => {
        managerView = typeMoq.Mock.ofType<EnvManagerView>();
        setupNonThenable(managerView);
        executeCommandStub = sinon.stub(commandApi, 'executeCommand');
    });

    teardown(() => {
        sinon.restore();
    });

    test('Focuses env-managers view and reveals environment when given a ProjectEnvironment', async () => {
        // Mock
        const project: PythonProject = {
            uri: Uri.file('/test/project'),
            name: 'test-project',
        };
        const projectItem = new ProjectItem(project);

        const environment: PythonEnvironment = {
            envId: { id: 'test-env-id', managerId: 'test-manager' },
            name: 'test-env',
            displayName: 'Test Environment',
            displayPath: '/path/to/env',
            version: '3.10.0',
            environmentPath: Uri.file('/path/to/env'),
            execInfo: { run: { executable: '/path/to/python' }, activatedRun: { executable: '/path/to/python' } },
            sysPrefix: '/path/to/env',
        };
        const projectEnv = new ProjectEnvironment(projectItem, environment);

        executeCommandStub.resolves();
        managerView.setup((m) => m.reveal(environment)).returns(() => Promise.resolve());

        // Run
        await revealEnvInManagerView(projectEnv, managerView.object);

        // Assert
        assert.ok(executeCommandStub.calledOnceWith('env-managers.focus'), 'Should focus the env-managers view');
        managerView.verify((m) => m.reveal(environment), typeMoq.Times.once());
    });
});

suite('Set Environment Command - Current File Tests', () => {
    let em: typeMoq.IMock<EnvironmentManagers>;
    let wm: typeMoq.IMock<PythonProjectManager>;
    let manager: typeMoq.IMock<InternalEnvironmentManager>;
    let env: typeMoq.IMock<PythonEnvironment>;
    let activeTextEditorStub: sinon.SinonStub;
    let pickProjectWithCurrentFileStub: sinon.SinonStub;
    let pickProjectManyStub: sinon.SinonStub;
    let pickEnvironmentStub: sinon.SinonStub;
    let executeCommandStub: sinon.SinonStub;

    const project: PythonProject = {
        uri: Uri.file('/workspace/project1'),
        name: 'project1',
    };
    const activeFileUri = Uri.file('/workspace/project1/main.py');

    setup(() => {
        manager = typeMoq.Mock.ofType<InternalEnvironmentManager>();
        manager.setup((m) => m.id).returns(() => 'test');
        manager.setup((m) => m.displayName).returns(() => 'Test Manager');

        env = typeMoq.Mock.ofType<PythonEnvironment>();
        env.setup((e) => e.envId).returns(() => ({ id: 'env1', managerId: 'test' }));
        setupNonThenable(env);

        em = typeMoq.Mock.ofType<EnvironmentManagers>();
        em.setup((e) => e.managers).returns(() => [manager.object]);
        em.setup((e) => e.getProjectEnvManagers(typeMoq.It.isAny())).returns(() => [manager.object]);

        wm = typeMoq.Mock.ofType<PythonProjectManager>();

        activeTextEditorStub = sinon.stub(windowApis, 'activeTextEditor');
        pickProjectWithCurrentFileStub = sinon.stub(projectApi, 'pickProjectWithCurrentFile');
        pickProjectManyStub = sinon.stub(projectApi, 'pickProjectMany');
        pickEnvironmentStub = sinon.stub(envPickerApi, 'pickEnvironment');
        executeCommandStub = sinon.stub(commandApi, 'executeCommand');
    });

    teardown(() => {
        sinon.restore();
    });

    test('should use pickProjectWithCurrentFile when active editor has a Python file', async () => {
        // Mock active editor with a Python file
        activeTextEditorStub.returns({
            document: {
                languageId: 'python',
                uri: activeFileUri,
                isUntitled: false,
            },
        });
        wm.setup((w) => w.getProjects(typeMoq.It.isAny())).returns(() => [project]);
        pickProjectWithCurrentFileStub.resolves(undefined); // User cancels

        await setEnvironmentCommand(undefined, em.object, wm.object);

        assert.ok(
            pickProjectWithCurrentFileStub.calledOnce,
            'pickProjectWithCurrentFile should be called when Python file is active',
        );
        assert.ok(pickProjectManyStub.notCalled, 'pickProjectMany should not be called when Python file is active');
    });

    test('should use pickProjectMany when no active editor', async () => {
        activeTextEditorStub.returns(undefined);
        wm.setup((w) => w.getProjects(typeMoq.It.isAny())).returns(() => [project]);
        pickProjectManyStub.resolves(undefined);

        await setEnvironmentCommand(undefined, em.object, wm.object);

        assert.ok(pickProjectManyStub.calledOnce, 'pickProjectMany should be called when no active editor');
        assert.ok(
            pickProjectWithCurrentFileStub.notCalled,
            'pickProjectWithCurrentFile should not be called when no active editor',
        );
    });

    test('should use pickProjectMany when active editor has non-Python file', async () => {
        activeTextEditorStub.returns({
            document: {
                languageId: 'javascript',
                uri: Uri.file('/workspace/project1/index.js'),
                isUntitled: false,
            },
        });
        wm.setup((w) => w.getProjects(typeMoq.It.isAny())).returns(() => [project]);
        pickProjectManyStub.resolves(undefined);

        await setEnvironmentCommand(undefined, em.object, wm.object);

        assert.ok(
            pickProjectManyStub.calledOnce,
            'pickProjectMany should be called for non-Python files',
        );
        assert.ok(
            pickProjectWithCurrentFileStub.notCalled,
            'pickProjectWithCurrentFile should not be called for non-Python files',
        );
    });

    test('should handle "Set for current file" action by passing file URI', async () => {
        activeTextEditorStub.returns({
            document: {
                languageId: 'python',
                uri: activeFileUri,
                isUntitled: false,
            },
        });
        wm.setup((w) => w.getProjects(typeMoq.It.isAny())).returns(() => [project]);

        pickProjectWithCurrentFileStub.resolves({
            action: 'currentFile',
            fileUri: activeFileUri,
        });

        // The setEnvironmentCommand will be called recursively with [activeFileUri]
        // which triggers the Uri[] branch that calls pickEnvironment
        manager.setup((m) => m.get(typeMoq.It.isAny())).returns(() => Promise.resolve(undefined));
        pickEnvironmentStub.resolves(env.object);
        em.setup((e) => e.setEnvironments(typeMoq.It.isAny(), typeMoq.It.isAny())).returns(() => Promise.resolve());

        await setEnvironmentCommand(undefined, em.object, wm.object);

        assert.ok(pickEnvironmentStub.calledOnce, 'pickEnvironment should be called after selecting current file');
    });

    test('should handle "Add current file as project" action', async () => {
        activeTextEditorStub.returns({
            document: {
                languageId: 'python',
                uri: activeFileUri,
                isUntitled: false,
            },
        });
        wm.setup((w) => w.getProjects(typeMoq.It.isAny())).returns(() => [project]);

        pickProjectWithCurrentFileStub.resolves({
            action: 'addProject',
            fileUri: activeFileUri,
        });

        // Mock executeCommand for addPythonProjectGivenResource
        executeCommandStub.resolves();

        // Mock finding the new project after creation
        const newProject: PythonProject = {
            uri: Uri.file('/workspace/project1'),
            name: 'project1',
        };
        wm.setup((w) => w.get(typeMoq.It.isAny())).returns(() => newProject);

        // After project is created, the env picker will be shown
        manager.setup((m) => m.get(typeMoq.It.isAny())).returns(() => Promise.resolve(undefined));
        pickEnvironmentStub.resolves(env.object);
        em.setup((e) => e.setEnvironments(typeMoq.It.isAny(), typeMoq.It.isAny())).returns(() => Promise.resolve());

        await setEnvironmentCommand(undefined, em.object, wm.object);

        assert.ok(
            executeCommandStub.calledWith('python-envs.addPythonProjectGivenResource', sinon.match.any),
            'Should call addPythonProjectGivenResource command',
        );
        assert.ok(
            pickEnvironmentStub.calledOnce,
            'pickEnvironment should be called after creating the project',
        );
    });

    test('should handle project selection from enriched picker', async () => {
        activeTextEditorStub.returns({
            document: {
                languageId: 'python',
                uri: activeFileUri,
                isUntitled: false,
            },
        });
        wm.setup((w) => w.getProjects(typeMoq.It.isAny())).returns(() => [project]);

        pickProjectWithCurrentFileStub.resolves({
            action: 'projects',
            projects: [project],
        });

        // After project is selected, the env picker will be shown
        manager.setup((m) => m.get(typeMoq.It.isAny())).returns(() => Promise.resolve(undefined));
        pickEnvironmentStub.resolves(env.object);
        em.setup((e) => e.setEnvironments(typeMoq.It.isAny(), typeMoq.It.isAny())).returns(() => Promise.resolve());

        await setEnvironmentCommand(undefined, em.object, wm.object);

        assert.ok(
            pickEnvironmentStub.calledOnce,
            'pickEnvironment should be called after selecting a project',
        );
    });

    test('should not show current file options when file scheme is not file', async () => {
        activeTextEditorStub.returns({
            document: {
                languageId: 'python',
                uri: Uri.parse('untitled:Untitled-1'),
                scheme: 'untitled',
                isUntitled: true,
            },
        });
        wm.setup((w) => w.getProjects(typeMoq.It.isAny())).returns(() => [project]);
        pickProjectManyStub.resolves(undefined);

        await setEnvironmentCommand(undefined, em.object, wm.object);

        assert.ok(
            pickProjectManyStub.calledOnce,
            'pickProjectMany should be called for untitled files',
        );
        assert.ok(
            pickProjectWithCurrentFileStub.notCalled,
            'pickProjectWithCurrentFile should not be called for untitled files',
        );
    });
});
