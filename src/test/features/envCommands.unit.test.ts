import * as assert from 'assert';
import * as sinon from 'sinon';
import * as typeMoq from 'typemoq';
import { Uri } from 'vscode';
import { PythonEnvironment, PythonProject } from '../../api';
import * as commandApi from '../../common/command.api';
import * as managerApi from '../../common/pickers/managers';
import * as projectApi from '../../common/pickers/projects';
import { createAnyEnvironmentCommand, revealEnvInManagerView } from '../../features/envCommands';
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
