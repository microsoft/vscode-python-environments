import * as assert from 'assert';
import * as typeMoq from 'typemoq';
import * as sinon from 'sinon';
import { EnvironmentManagers, InternalEnvironmentManager, PythonProjectManager } from '../../internal.api';
import * as projectApi from '../../common/pickers/projects';
import * as managerApi from '../../common/pickers/managers';
import * as venvUtils from '../../managers/builtin/venvUtils';
import { PythonEnvironment, PythonProject } from '../../api';
import { createAnyEnvironmentCommand } from '../../features/envCommands';
import { Uri } from 'vscode';

suite('Create Any Environment Command Tests', () => {
    let em: typeMoq.IMock<EnvironmentManagers>;
    let pm: typeMoq.IMock<PythonProjectManager>;
    let manager: typeMoq.IMock<InternalEnvironmentManager>;
    let env: typeMoq.IMock<PythonEnvironment>;
    let pickProjectManyStub: sinon.SinonStub;
    let pickEnvironmentManagerStub: sinon.SinonStub;
    let getGlobalVenvLocationStub: sinon.SinonStub;
    let executeCommandStub: sinon.SinonStub;
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
        getGlobalVenvLocationStub = sinon.stub(venvUtils, 'getGlobalVenvLocation');
        // Create a mock function and assign it to executeCommand
        executeCommandStub = sinon.stub();
        // We need to mock at the require level since vscode.commands might not be available
        const vscode = require('vscode');
        if (!vscode.commands) {
            vscode.commands = {};
        }
        vscode.commands.executeCommand = executeCommandStub;
    });

    teardown(() => {
        sinon.restore();
    });

    test('Create global venv (no-workspace): no-select', async () => {
        pm.setup((p) => p.getProjects(typeMoq.It.isAny())).returns(() => []);
        
        // With the new behavior, manager.create should not be called for global environments
        manager
            .setup((m) => m.create('global', typeMoq.It.isAny()))
            .returns(() => Promise.resolve(env.object))
            .verifiable(typeMoq.Times.never());

        manager.setup((m) => m.set(typeMoq.It.isAny(), typeMoq.It.isAny())).verifiable(typeMoq.Times.never());

        pickEnvironmentManagerStub.resolves(manager.object.id);
        pickProjectManyStub.resolves([]);
        
        // Mock the folder selection and command execution
        const testFolderUri = Uri.file('/test/folder');
        getGlobalVenvLocationStub.resolves(testFolderUri);
        executeCommandStub.resolves();

        const result = await createAnyEnvironmentCommand(em.object, pm.object, { selectEnvironment: false });
        
        // With the new behavior, the function should return undefined and open the folder
        assert.strictEqual(result, undefined, 'Expected undefined result as folder should be opened instead');
        
        // Verify that the folder was opened
        assert.strictEqual(executeCommandStub.calledWith('vscode.openFolder', testFolderUri), true, 'Expected vscode.openFolder to be called with the selected folder');
        
        manager.verifyAll();
    });

    test('Create global venv (no-workspace): select', async () => {
        pm.setup((p) => p.getProjects(typeMoq.It.isAny())).returns(() => []);
        
        // With the new behavior, manager.create should not be called for global environments
        manager
            .setup((m) => m.create('global', typeMoq.It.isAny()))
            .returns(() => Promise.resolve(env.object))
            .verifiable(typeMoq.Times.never());

        manager.setup((m) => m.set(undefined, env.object)).verifiable(typeMoq.Times.never());

        pickEnvironmentManagerStub.resolves(manager.object.id);
        pickProjectManyStub.resolves([]);
        
        // Mock the folder selection and command execution
        const testFolderUri = Uri.file('/test/folder');
        getGlobalVenvLocationStub.resolves(testFolderUri);
        executeCommandStub.resolves();

        const result = await createAnyEnvironmentCommand(em.object, pm.object, { selectEnvironment: true });
        
        // With the new behavior, the function should return undefined and open the folder
        assert.strictEqual(result, undefined, 'Expected undefined result as folder should be opened instead');
        
        // Verify that the folder was opened
        assert.strictEqual(executeCommandStub.calledWith('vscode.openFolder', testFolderUri), true, 'Expected vscode.openFolder to be called with the selected folder');
        
        manager.verifyAll();
    });

    test('Create global venv (no-workspace): user cancels folder selection', async () => {
        pm.setup((p) => p.getProjects(typeMoq.It.isAny())).returns(() => []);
        
        // Manager methods should not be called if user cancels
        manager
            .setup((m) => m.create('global', typeMoq.It.isAny()))
            .returns(() => Promise.resolve(env.object))
            .verifiable(typeMoq.Times.never());

        manager.setup((m) => m.set(typeMoq.It.isAny(), typeMoq.It.isAny())).verifiable(typeMoq.Times.never());

        pickEnvironmentManagerStub.resolves(manager.object.id);
        pickProjectManyStub.resolves([]);
        
        // Mock user cancelling folder selection
        getGlobalVenvLocationStub.resolves(undefined);
        executeCommandStub.resolves();

        const result = await createAnyEnvironmentCommand(em.object, pm.object, { selectEnvironment: false });
        
        // Should return undefined when user cancels
        assert.strictEqual(result, undefined, 'Expected undefined result when user cancels folder selection');
        
        // Verify that openFolder was not called
        assert.strictEqual(executeCommandStub.called, false, 'Expected vscode.openFolder to not be called when user cancels');
        
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
