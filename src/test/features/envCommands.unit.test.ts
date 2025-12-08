import * as assert from 'assert';
import * as typeMoq from 'typemoq';
import * as sinon from 'sinon';
import { EnvironmentManagers, InternalEnvironmentManager, PythonProjectManager } from '../../internal.api';
import * as projectApi from '../../common/pickers/projects';
import * as managerApi from '../../common/pickers/managers';
import { PythonEnvironment, PythonEnvironmentApi, PythonProject } from '../../api';
import { createAnyEnvironmentCommand, createTerminalCommand } from '../../features/envCommands';
import { Terminal, Uri } from 'vscode';
import { TerminalManager } from '../../features/terminal/terminalManager';
import * as fs from 'fs-extra';

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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        env.setup((e: any) => e.then).returns(() => undefined);

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

suite('Create Terminal Command Tests', () => {
    let api: typeMoq.IMock<PythonEnvironmentApi>;
    let tm: typeMoq.IMock<TerminalManager>;
    let env: typeMoq.IMock<PythonEnvironment>;
    let terminal: typeMoq.IMock<Terminal>;
    let pickProjectStub: sinon.SinonStub;
    let fsStatStub: sinon.SinonStub;
    let project1: PythonProject = {
        uri: Uri.file('/workspace/folder1'),
        name: 'folder1',
    };
    let project2: PythonProject = {
        uri: Uri.file('/workspace/folder2'),
        name: 'folder2',
    };

    setup(() => {
        env = typeMoq.Mock.ofType<PythonEnvironment>();
        env.setup((e) => e.envId).returns(() => ({ id: 'env1', managerId: 'test' }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        env.setup((e: any) => e.then).returns(() => undefined);

        terminal = typeMoq.Mock.ofType<Terminal>();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        terminal.setup((t: any) => t.then).returns(() => undefined);

        api = typeMoq.Mock.ofType<PythonEnvironmentApi>();
        tm = typeMoq.Mock.ofType<TerminalManager>();

        pickProjectStub = sinon.stub(projectApi, 'pickProject');
        // Stub fs.stat to return a directory stats object to avoid file system access
        fsStatStub = sinon.stub(fs, 'stat');
        fsStatStub.resolves({ isFile: () => false, isDirectory: () => true } as any);
    });

    teardown(() => {
        sinon.restore();
    });

    test('Single project: should create terminal without prompting', async () => {
        // Setup: single project
        api.setup((a) => a.getPythonProjects()).returns(() => [project1]);
        api.setup((a) => a.getEnvironment(project1.uri)).returns(() => Promise.resolve(env.object));
        tm.setup((t) => t.create(env.object, typeMoq.It.isAny())).returns(() => Promise.resolve(terminal.object));

        // pickProject should return the single project without prompting
        pickProjectStub.resolves(project1);

        const result = await createTerminalCommand(undefined, api.object, tm.object);

        assert.strictEqual(result, terminal.object, 'Expected terminal to be created');
        assert.strictEqual(pickProjectStub.callCount, 1, 'pickProject should be called once');
    });

    test('Multiple projects: should prompt user to select project', async () => {
        // Setup: multiple projects
        api.setup((a) => a.getPythonProjects()).returns(() => [project1, project2]);
        api.setup((a) => a.getEnvironment(project2.uri)).returns(() => Promise.resolve(env.object));
        tm.setup((t) => t.create(env.object, typeMoq.It.isAny())).returns(() => Promise.resolve(terminal.object));

        // User selects project2
        pickProjectStub.resolves(project2);

        const result = await createTerminalCommand(undefined, api.object, tm.object);

        assert.strictEqual(result, terminal.object, 'Expected terminal to be created');
        assert.strictEqual(pickProjectStub.callCount, 1, 'pickProject should be called once');
        // Verify pickProject was called with both projects
        assert.deepStrictEqual(
            pickProjectStub.firstCall.args[0],
            [project1, project2],
            'pickProject should be called with all projects',
        );
    });

    test('Uri context with single project: should create terminal without prompting', async () => {
        // Setup: single project
        api.setup((a) => a.getPythonProjects()).returns(() => [project1]);
        api.setup((a) => a.getEnvironment(project1.uri)).returns(() => Promise.resolve(env.object));
        tm.setup((t) => t.create(env.object, typeMoq.It.isAny())).returns(() => Promise.resolve(terminal.object));

        // pickProject should return the single project without prompting
        pickProjectStub.resolves(project1);

        const result = await createTerminalCommand(project1.uri, api.object, tm.object);

        assert.strictEqual(result, terminal.object, 'Expected terminal to be created');
        assert.strictEqual(pickProjectStub.callCount, 1, 'pickProject should be called once');
    });

    test('Uri context with multiple projects: should prompt user to select project', async () => {
        // Setup: multiple projects, context is project1.uri but user should still be prompted
        api.setup((a) => a.getPythonProjects()).returns(() => [project1, project2]);
        api.setup((a) => a.getEnvironment(project2.uri)).returns(() => Promise.resolve(env.object));
        tm.setup((t) => t.create(env.object, typeMoq.It.isAny())).returns(() => Promise.resolve(terminal.object));

        // User selects project2 (different from context)
        pickProjectStub.resolves(project2);

        const result = await createTerminalCommand(project1.uri, api.object, tm.object);

        assert.strictEqual(result, terminal.object, 'Expected terminal to be created');
        assert.strictEqual(pickProjectStub.callCount, 1, 'pickProject should be called once');
        // Verify pickProject was called with all projects, not just the context
        assert.deepStrictEqual(
            pickProjectStub.firstCall.args[0],
            [project1, project2],
            'pickProject should be called with all projects',
        );
    });

    test('User cancels project selection: should not create terminal', async () => {
        // Setup: multiple projects
        api.setup((a) => a.getPythonProjects()).returns(() => [project1, project2]);

        // User cancels selection
        pickProjectStub.resolves(undefined);

        const result = await createTerminalCommand(undefined, api.object, tm.object);

        assert.strictEqual(result, undefined, 'Expected no terminal to be created when user cancels');
        assert.strictEqual(pickProjectStub.callCount, 1, 'pickProject should be called once');
    });
});
