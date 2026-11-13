import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import { EnvironmentManager, PythonEnvironment, PythonProject } from '../../api';
import { INLINE_SCRIPT_MANAGER_ID } from '../../common/constants';
import * as projectPickers from '../../common/pickers/projects';
import { setEnvironmentCommand } from '../../features/envCommands';
import type { EnvironmentManagers } from '../../features/envManagers';
import type { PythonProjectManager } from '../../features/projectManager';
import { EnvManagerTreeItem, PythonEnvTreeItem } from '../../features/views/treeViewItems';
import { InternalEnvironmentManager } from '../../managers/common/registeredManagers';
import { createMockPythonEnvironment } from '../mocks/pythonEnvironment';

suite('Set environment for projects command', () => {
    const managerId = 'ms-python.python:venv';
    const projects: PythonProject[] = ['one', 'two', 'three', 'four'].map((name) => ({
        name,
        uri: Uri.file(path.join(process.cwd(), name)),
    }));
    let target: PythonEnvironment;
    let currentEnvironments: Map<string, PythonEnvironment | undefined>;
    let getEnvironment: sinon.SinonStub;
    let setEnvironments: sinon.SinonStub;
    let managers: EnvironmentManagers;
    let projectManager: PythonProjectManager;

    setup(() => {
        target = createMockPythonEnvironment({
            envPath: path.join(process.cwd(), 'shared-env'),
            id: 'shared-env',
            managerId,
        });
        currentEnvironments = new Map();
        getEnvironment = sinon
            .stub()
            .callsFake(async (uri: Uri) => currentEnvironments.get(uri.fsPath));
        setEnvironments = sinon.stub().callsFake(async (uris: Uri[], environment?: PythonEnvironment) => {
            uris.forEach((uri) => currentEnvironments.set(uri.fsPath, environment));
        });
        managers = {
            getEnvironment,
            setEnvironments,
        } as unknown as EnvironmentManagers;
        projectManager = {
            getProjects: () => projects,
        } as unknown as PythonProjectManager;
    });

    teardown(() => sinon.restore());

    function setCurrentEnvironment(project: PythonProject, environment: PythonEnvironment | undefined): void {
        currentEnvironments.set(project.uri.fsPath, environment);
    }

    function createEnvironmentItem(environment = target): PythonEnvTreeItem {
        const provider: EnvironmentManager = {
            name: 'test',
            preferredPackageManagerId: 'ms-python.python:pip',
            get: async () => environment,
            set: async () => undefined,
            getEnvironments: async () => [environment],
            refresh: async () => undefined,
            resolve: async () => environment,
        };
        const parent = new EnvManagerTreeItem(new InternalEnvironmentManager(environment.envId.managerId, provider));
        return new PythonEnvTreeItem(environment, parent);
    }

    test('preselects only exact current environment matches', async () => {
        setCurrentEnvironment(
            projects[0],
            createMockPythonEnvironment({
                envPath: path.join(process.cwd(), 'equivalent-env'),
                id: target.envId.id,
                managerId,
            }),
        );
        setCurrentEnvironment(
            projects[1],
            createMockPythonEnvironment({
                envPath: path.join(process.cwd(), 'same-id-other-manager'),
                id: target.envId.id,
                managerId: 'ms-python.python:conda',
            }),
        );
        setCurrentEnvironment(
            projects[2],
            createMockPythonEnvironment({
                envPath: path.join(process.cwd(), 'other-env'),
                id: 'other-env',
                managerId,
            }),
        );
        setCurrentEnvironment(
            projects[3],
            createMockPythonEnvironment({
                envPath: target.environmentPath.fsPath,
                id: 'same-path-different-id',
                managerId,
            }),
        );
        const pickProjects = sinon.stub(projectPickers, 'pickProjectMany').resolves(undefined);

        await setEnvironmentCommand(createEnvironmentItem(), managers, projectManager);

        const options = pickProjects.firstCall.args[1];
        assert.ok(options && typeof options !== 'boolean');
        assert.strictEqual(options.showPickerForSingleProject, true);
        assert.deepStrictEqual(options.selectedProjects, [projects[0], projects[3]]);
        sinon.assert.notCalled(setEnvironments);
    });

    test('uses the inline environment path and version for exact matches', async () => {
        target = createMockPythonEnvironment({
            envPath: path.join(process.cwd(), 'inline-env'),
            id: 'inline-target',
            managerId: INLINE_SCRIPT_MANAGER_ID,
            version: '3.12.0',
        });
        setCurrentEnvironment(
            projects[0],
            createMockPythonEnvironment({
                envPath: target.environmentPath.fsPath,
                id: 'different-id',
                managerId: INLINE_SCRIPT_MANAGER_ID,
                version: target.version,
            }),
        );
        setCurrentEnvironment(
            projects[1],
            createMockPythonEnvironment({
                envPath: target.environmentPath.fsPath,
                id: target.envId.id,
                managerId: INLINE_SCRIPT_MANAGER_ID,
                version: '3.13.0',
            }),
        );
        setCurrentEnvironment(
            projects[2],
            createMockPythonEnvironment({
                envPath: path.join(process.cwd(), 'other-inline-env'),
                id: target.envId.id,
                managerId: INLINE_SCRIPT_MANAGER_ID,
                version: target.version,
            }),
        );
        const pickProjects = sinon.stub(projectPickers, 'pickProjectMany').resolves(undefined);

        await setEnvironmentCommand(createEnvironmentItem(), managers, projectManager);

        const options = pickProjects.firstCall.args[1];
        assert.ok(options && typeof options !== 'boolean');
        assert.deepStrictEqual(options.selectedProjects, [projects[0]]);
        sinon.assert.notCalled(setEnvironments);
    });

    test('sets newly checked projects and resets only unchecked matches', async () => {
        setCurrentEnvironment(projects[0], target);
        setCurrentEnvironment(projects[1], target);
        setCurrentEnvironment(
            projects[2],
            createMockPythonEnvironment({
                envPath: path.join(process.cwd(), 'other-env'),
                id: 'other-env',
                managerId,
            }),
        );
        sinon.stub(projectPickers, 'pickProjectMany').resolves([projects[1], projects[2]]);

        await setEnvironmentCommand(createEnvironmentItem(), managers, projectManager);

        assert.strictEqual(setEnvironments.callCount, 2);
        assert.deepStrictEqual(setEnvironments.firstCall.args, [[projects[2].uri], target]);
        assert.deepStrictEqual(setEnvironments.secondCall.args, [[projects[0].uri], undefined]);
    });

    test('resets all matching projects when an empty selection is accepted', async () => {
        setCurrentEnvironment(projects[0], target);
        setCurrentEnvironment(projects[2], target);
        sinon.stub(projectPickers, 'pickProjectMany').resolves([]);

        await setEnvironmentCommand(createEnvironmentItem(), managers, projectManager);

        assert.deepStrictEqual(setEnvironments.firstCall.args, [
            [projects[0].uri, projects[2].uri],
            undefined,
        ]);
        sinon.assert.calledOnce(setEnvironments);
    });

    test('does not change projects when the picker is cancelled', async () => {
        setCurrentEnvironment(projects[0], target);
        sinon.stub(projectPickers, 'pickProjectMany').resolves(undefined);

        await setEnvironmentCommand(createEnvironmentItem(), managers, projectManager);

        sinon.assert.notCalled(setEnvironments);
    });

    test('does not change projects when the preselected state is accepted unchanged', async () => {
        setCurrentEnvironment(projects[0], target);
        setCurrentEnvironment(projects[2], target);
        sinon.stub(projectPickers, 'pickProjectMany').resolves([projects[0], projects[2]]);

        await setEnvironmentCommand(createEnvironmentItem(), managers, projectManager);

        sinon.assert.notCalled(setEnvironments);
    });

    test('shows a preselected single project and resets it when unchecked', async () => {
        const singleProjectManager = {
            getProjects: () => [projects[0]],
        } as unknown as PythonProjectManager;
        setCurrentEnvironment(projects[0], target);
        const pickProjects = sinon.stub(projectPickers, 'pickProjectMany').resolves([]);

        await setEnvironmentCommand(createEnvironmentItem(), managers, singleProjectManager);

        const options = pickProjects.firstCall.args[1];
        assert.ok(options && typeof options !== 'boolean');
        assert.strictEqual(options.showPickerForSingleProject, true);
        assert.deepStrictEqual(options.selectedProjects, [projects[0]]);
        assert.deepStrictEqual(setEnvironments.firstCall.args, [[projects[0].uri], undefined]);
    });

    test('rechecks current environments before applying the accepted selection', async () => {
        const otherEnvironment = createMockPythonEnvironment({
            envPath: path.join(process.cwd(), 'other-env'),
            id: 'other-env',
            managerId,
        });
        setCurrentEnvironment(projects[0], target);
        setCurrentEnvironment(projects[1], otherEnvironment);
        sinon.stub(projectPickers, 'pickProjectMany').callsFake(async () => {
            setCurrentEnvironment(projects[0], otherEnvironment);
            setCurrentEnvironment(projects[1], target);
            return [projects[0]];
        });

        await setEnvironmentCommand(createEnvironmentItem(), managers, projectManager);

        sinon.assert.calledOnceWithExactly(setEnvironments, [projects[0].uri], target);
    });

    test('does not reset existing projects when a new assignment fails', async () => {
        const failure = new Error('set failed');
        const otherEnvironment = createMockPythonEnvironment({
            envPath: path.join(process.cwd(), 'other-env'),
            id: 'other-env',
            managerId,
        });
        setCurrentEnvironment(projects[0], target);
        setCurrentEnvironment(projects[1], otherEnvironment);
        sinon.stub(projectPickers, 'pickProjectMany').resolves([projects[1]]);
        setEnvironments.onFirstCall().rejects(failure);

        await assert.rejects(
            setEnvironmentCommand(createEnvironmentItem(), managers, projectManager),
            (error: unknown) => error === failure,
        );

        sinon.assert.calledOnce(setEnvironments);
        assert.deepStrictEqual(setEnvironments.firstCall.args, [[projects[1].uri], target]);
        assert.strictEqual(currentEnvironments.get(projects[0].uri.fsPath), target);
        assert.strictEqual(currentEnvironments.get(projects[1].uri.fsPath), otherEnvironment);
    });

    test('keeps confirmed new assignments when a later reset fails', async () => {
        const failure = new Error('reset failed');
        const otherEnvironment = createMockPythonEnvironment({
            envPath: path.join(process.cwd(), 'other-env'),
            id: 'other-env',
            managerId,
        });
        setCurrentEnvironment(projects[0], target);
        setCurrentEnvironment(projects[1], otherEnvironment);
        sinon.stub(projectPickers, 'pickProjectMany').resolves([projects[1]]);
        setEnvironments.onSecondCall().rejects(failure);

        await assert.rejects(
            setEnvironmentCommand(createEnvironmentItem(), managers, projectManager),
            (error: unknown) => error === failure,
        );

        assert.strictEqual(setEnvironments.callCount, 2);
        assert.deepStrictEqual(setEnvironments.firstCall.args, [[projects[1].uri], target]);
        assert.deepStrictEqual(setEnvironments.secondCall.args, [[projects[0].uri], undefined]);
        assert.strictEqual(currentEnvironments.get(projects[0].uri.fsPath), target);
        assert.strictEqual(currentEnvironments.get(projects[1].uri.fsPath), target);
    });

    test('rechecks reset candidates after applying new assignments', async () => {
        const otherEnvironment = createMockPythonEnvironment({
            envPath: path.join(process.cwd(), 'other-env'),
            id: 'other-env',
            managerId,
        });
        setCurrentEnvironment(projects[0], target);
        setCurrentEnvironment(projects[1], otherEnvironment);
        sinon.stub(projectPickers, 'pickProjectMany').resolves([projects[1]]);
        setEnvironments.callsFake(async (uris: Uri[], environment?: PythonEnvironment) => {
            uris.forEach((uri) => currentEnvironments.set(uri.fsPath, environment));
            setCurrentEnvironment(projects[0], otherEnvironment);
        });

        await setEnvironmentCommand(createEnvironmentItem(), managers, projectManager);

        sinon.assert.calledOnceWithExactly(setEnvironments, [projects[1].uri], target);
        assert.strictEqual(currentEnvironments.get(projects[0].uri.fsPath), otherEnvironment);
    });

});
