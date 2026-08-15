import assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { CancellationToken, Uri } from 'vscode';
import {
    DidChangeEnvironmentEventArgs,
    DidChangeEnvironmentsEventArgs,
    EnvironmentChangeKind,
    PythonEnvironment,
    PythonEnvironmentApi,
    PythonProject,
} from '../../../api';
import { normalizePath } from '../../../common/utils/pathUtils';
import * as windowApis from '../../../common/window.apis';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import * as poetryCommands from '../../../managers/poetry/commands/runPoetry';
import { PoetryManager } from '../../../managers/poetry/poetryManager';
import * as poetryUtils from '../../../managers/poetry/poetryUtils';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

function makeEnvironment(name: string, envPath: string, managerId: string): PythonEnvironment {
    return createMockPythonEnvironment({
        name,
        envPath,
        managerId,
    });
}

function createManager(apiOverrides: Partial<PythonEnvironmentApi> = {}): PoetryManager {
    const api = {
        getPythonProject: sinon.stub().returns(undefined),
        getPythonProjects: sinon.stub().returns([]),
        getEnvironments: sinon.stub().resolves([]),
        ...apiOverrides,
    } as unknown as PythonEnvironmentApi;
    const manager = new PoetryManager(
        {} as NativePythonFinder,
        api,
        { info: sinon.stub(), append: sinon.stub(), error: sinon.stub() } as never,
    );
    (manager as unknown as { _initialized: { completed: boolean; promise: Promise<void> } })._initialized = {
        completed: true,
        promise: Promise.resolve(),
    };
    return manager;
}

suite('PoetryManager environment lifecycle', () => {
    let runPoetryStub: sinon.SinonStub;
    let resolvePoetryPathStub: sinon.SinonStub;
    let setPoetryForGlobalStub: sinon.SinonStub;
    let setPoetryForWorkspaceStub: sinon.SinonStub;

    setup(() => {
        runPoetryStub = sinon.stub(poetryCommands, 'runPoetry');
        resolvePoetryPathStub = sinon.stub(poetryUtils, 'resolvePoetryPath');
        setPoetryForWorkspaceStub = sinon.stub(poetryUtils, 'setPoetryForWorkspace').resolves();
        setPoetryForGlobalStub = sinon.stub(poetryUtils, 'setPoetryForGlobal').resolves();
        sinon.stub(windowApis, 'withProgress').callsFake(async (_options, task) =>
            task({ report: sinon.stub() }, { onCancellationRequested: sinon.stub() } as unknown as CancellationToken),
        );
    });

    teardown(() => {
        sinon.restore();
    });

    test('creates, configures, and selects a Poetry environment for a project', async () => {
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'poetry-manager-'));
        try {
            const projectUri = Uri.file(path.join(tempRoot, 'project'));
            const environmentPath = Uri.file(path.join(tempRoot, 'poetry-cache', 'project-py3.12')).fsPath;
            await fs.outputFile(path.join(projectUri.fsPath, 'pyproject.toml'), '[tool.poetry]\nname = "project"\n');
            const project = { name: 'project', uri: projectUri } as PythonProject;
            const baseEnvironment = makeEnvironment('python', path.join(tempRoot, 'python'), 'ms-python.python:system');
            const poetryEnvironment = makeEnvironment(
                'project',
                environmentPath,
                'ms-python.python:poetry',
            );
            const manager = createManager({
                getPythonProject: sinon.stub().returns(project),
                getEnvironments: sinon.stub().resolves([baseEnvironment]),
            });
            runPoetryStub.onFirstCall().resolves('');
            runPoetryStub.onSecondCall().resolves(`Poetry diagnostic output${os.EOL}${environmentPath}${os.EOL}`);
            runPoetryStub.onThirdCall().resolves('');
            resolvePoetryPathStub.resolves(poetryEnvironment);
            const collectionEvents: DidChangeEnvironmentsEventArgs[] = [];
            const selectionEvents: DidChangeEnvironmentEventArgs[] = [];
            manager.onDidChangeEnvironments((event) => collectionEvents.push(event));
            manager.onDidChangeEnvironment((event) => selectionEvents.push(event));

            const result = await manager.create(projectUri, { additionalPackages: ['pytest', 'ruff'] });

            assert.strictEqual(result, poetryEnvironment);
            assert.deepStrictEqual(runPoetryStub.firstCall.args.slice(0, 2), [
                ['--no-ansi', 'env', 'use', 'python'],
                projectUri.fsPath,
            ]);
            assert.deepStrictEqual(runPoetryStub.secondCall.args.slice(0, 2), [
                ['--no-ansi', 'env', 'info', '--path'],
                projectUri.fsPath,
            ]);
            assert.deepStrictEqual(runPoetryStub.thirdCall.args.slice(0, 2), [
                ['--no-ansi', 'add', 'pytest', 'ruff'],
                projectUri.fsPath,
            ]);
            assert.ok(
                setPoetryForWorkspaceStub.calledOnceWithExactly(projectUri.fsPath, poetryEnvironment.environmentPath.fsPath),
            );
            assert.strictEqual(collectionEvents.length, 1);
            assert.strictEqual(collectionEvents[0][0].kind, EnvironmentChangeKind.add);
            assert.strictEqual(collectionEvents[0][0].environment, poetryEnvironment);
            assert.deepStrictEqual(selectionEvents[0], {
                uri: projectUri,
                old: undefined,
                new: poetryEnvironment,
            });
        } finally {
            await fs.remove(tempRoot);
        }
    });

    test('requires an existing pyproject.toml', async () => {
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'poetry-manager-'));
        try {
            const projectUri = Uri.file(path.join(tempRoot, 'project'));
            await fs.mkdirp(projectUri.fsPath);
            const project = { name: 'project', uri: projectUri } as PythonProject;
            const manager = createManager({ getPythonProject: sinon.stub().returns(project) });

            await assert.rejects(manager.create(projectUri), /pyproject\.toml/i);

            assert.ok(runPoetryStub.notCalled);
        } finally {
            await fs.remove(tempRoot);
        }
    });

    test('requires a usable global Python 3 environment', async () => {
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'poetry-manager-'));
        try {
            const projectUri = Uri.file(path.join(tempRoot, 'project'));
            await fs.outputFile(path.join(projectUri.fsPath, 'pyproject.toml'), '[tool.poetry]\nname = "project"\n');
            const project = { name: 'project', uri: projectUri } as PythonProject;
            const python2 = createMockPythonEnvironment({
                name: 'python2',
                envPath: path.join(tempRoot, 'python2'),
                version: '2.7.18',
                managerId: 'ms-python.python:system',
            });
            const manager = createManager({
                getPythonProject: sinon.stub().returns(project),
                getEnvironments: sinon.stub().resolves([python2]),
            });

            await assert.rejects(manager.create(projectUri), /Python 3/i);

            assert.ok(runPoetryStub.notCalled);
        } finally {
            await fs.remove(tempRoot);
        }
    });

    test('does not mutate state when Poetry creation fails', async () => {
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'poetry-manager-'));
        try {
            const projectUri = Uri.file(path.join(tempRoot, 'project'));
            await fs.outputFile(path.join(projectUri.fsPath, 'pyproject.toml'), '[tool.poetry]\nname = "project"\n');
            const project = { name: 'project', uri: projectUri } as PythonProject;
            const baseEnvironment = makeEnvironment('python', path.join(tempRoot, 'python'), 'ms-python.python:system');
            const manager = createManager({
                getPythonProject: sinon.stub().returns(project),
                getEnvironments: sinon.stub().resolves([baseEnvironment]),
            });

            runPoetryStub.rejects(new Error('creation failed'));
            const events: DidChangeEnvironmentsEventArgs[] = [];
            manager.onDidChangeEnvironments((event) => events.push(event));

            await assert.rejects(manager.create(projectUri), /creation failed/);

            assert.deepStrictEqual((manager as unknown as { collection: PythonEnvironment[] }).collection, []);
            assert.strictEqual(events.length, 0);
            assert.ok(setPoetryForWorkspaceStub.notCalled);
        } finally {
            await fs.remove(tempRoot);
        }
    });

    test('keeps a created environment tracked when package installation fails', async () => {
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'poetry-manager-'));
        try {
            const projectUri = Uri.file(path.join(tempRoot, 'project'));
            const environmentPath = Uri.file(path.join(tempRoot, 'poetry-cache', 'project-py3.12')).fsPath;
            await fs.outputFile(path.join(projectUri.fsPath, 'pyproject.toml'), '[tool.poetry]\nname = "project"\n');
            const project = { name: 'project', uri: projectUri } as PythonProject;
            const baseEnvironment = makeEnvironment('python', path.join(tempRoot, 'python'), 'ms-python.python:system');
            const poetryEnvironment = makeEnvironment(
                'project',
                environmentPath,
                'ms-python.python:poetry',
            );
            const manager = createManager({
                getPythonProject: sinon.stub().returns(project),
                getEnvironments: sinon.stub().resolves([baseEnvironment]),
            });
            runPoetryStub.onFirstCall().resolves('');
            runPoetryStub.onSecondCall().resolves(environmentPath);
            runPoetryStub.onThirdCall().rejects(new Error('package installation failed'));
            resolvePoetryPathStub.resolves(poetryEnvironment);
            const events: DidChangeEnvironmentsEventArgs[] = [];
            manager.onDidChangeEnvironments((event) => events.push(event));

            await assert.rejects(
                manager.create(projectUri, { additionalPackages: ['pytest'] }),
                /package installation failed/,
            );

            assert.deepStrictEqual(
                (manager as unknown as { collection: PythonEnvironment[] }).collection,
                [poetryEnvironment],
            );
            assert.ok(
                setPoetryForWorkspaceStub.calledOnceWithExactly(projectUri.fsPath, poetryEnvironment.environmentPath.fsPath),
            );
            assert.strictEqual(events[0][0].environment, poetryEnvironment);
        } finally {
            await fs.remove(tempRoot);
        }
    });

    test('reuses the canonical cached environment when Poetry returns an existing path', async () => {
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'poetry-manager-'));
        try {
            const projectUri = Uri.file(path.join(tempRoot, 'project'));
            const environmentPath = Uri.file(path.join(tempRoot, 'poetry-cache', 'project-py3.12')).fsPath;
            await fs.outputFile(path.join(projectUri.fsPath, 'pyproject.toml'), '[tool.poetry]\nname = "project"\n');
            const project = { name: 'project', uri: projectUri } as PythonProject;
            const baseEnvironment = makeEnvironment('python', path.join(tempRoot, 'python'), 'ms-python.python:system');
            const cachedEnvironment = makeEnvironment(
                'cached-project',
                environmentPath,
                'ms-python.python:poetry',
            );
            const newlyResolvedEnvironment = createMockPythonEnvironment({
                name: 'resolved-project',
                envPath: environmentPath,
                managerId: 'ms-python.python:poetry',
                id: 'different-id',
            });
            const manager = createManager({
                getPythonProject: sinon.stub().returns(project),
                getEnvironments: sinon.stub().resolves([baseEnvironment]),
            });
            (manager as unknown as { collection: PythonEnvironment[] }).collection = [cachedEnvironment];
            runPoetryStub.onFirstCall().resolves('');
            runPoetryStub.onSecondCall().resolves(environmentPath);
            resolvePoetryPathStub.resolves(newlyResolvedEnvironment);
            const events: DidChangeEnvironmentsEventArgs[] = [];
            manager.onDidChangeEnvironments((event) => events.push(event));

            const result = await manager.create(projectUri);

            assert.strictEqual(result, cachedEnvironment);
            assert.deepStrictEqual(
                (manager as unknown as { collection: PythonEnvironment[] }).collection,
                [cachedEnvironment],
            );
            assert.strictEqual(events.length, 0);
        } finally {
            await fs.remove(tempRoot);
        }
    });

    test('removes an associated Poetry environment after the command succeeds', async () => {
        const projectUri = Uri.file(path.join(os.tmpdir(), 'poetry-manager-project'));
        const environment = makeEnvironment(
            'project',
            path.join(os.tmpdir(), 'poetry-cache', 'project-py3.12'),
            'ms-python.python:poetry',
        );
        const project = { name: 'project', uri: projectUri } as PythonProject;
        const manager = createManager({ getPythonProjects: sinon.stub().returns([project]) });
        const state = manager as unknown as {
            collection: PythonEnvironment[];
            fsPathToEnv: Map<string, PythonEnvironment>;
        };
        state.collection = [environment];
        state.fsPathToEnv = new Map([[normalizePath(projectUri.fsPath), environment]]);
        runPoetryStub.onFirstCall().resolves(environment.environmentPath.fsPath);
        runPoetryStub.onSecondCall().resolves('');
        const collectionEvents: DidChangeEnvironmentsEventArgs[] = [];
        const selectionEvents: DidChangeEnvironmentEventArgs[] = [];
        manager.onDidChangeEnvironments((event) => collectionEvents.push(event));
        manager.onDidChangeEnvironment((event) => selectionEvents.push(event));

        await manager.remove(environment);

        assert.deepStrictEqual(runPoetryStub.secondCall.args.slice(0, 2), [
            ['--no-ansi', 'env', 'remove', 'python'],
            projectUri.fsPath,
        ]);
        assert.deepStrictEqual(state.collection, []);
        assert.strictEqual(state.fsPathToEnv.size, 0);
        assert.ok(setPoetryForWorkspaceStub.calledOnceWithExactly(projectUri.fsPath, undefined));
        assert.strictEqual(collectionEvents[0][0].kind, EnvironmentChangeKind.remove);
        assert.deepStrictEqual(selectionEvents[0], {
            uri: projectUri,
            old: environment,
            new: undefined,
        });
    });

    test('does not mutate state when Poetry removal fails', async () => {
        const projectUri = Uri.file(path.join(os.tmpdir(), 'poetry-manager-project'));
        const environment = makeEnvironment(
            'project',
            path.join(os.tmpdir(), 'poetry-cache', 'project-py3.12'),
            'ms-python.python:poetry',
        );
        const project = { name: 'project', uri: projectUri } as PythonProject;
        const manager = createManager({ getPythonProjects: sinon.stub().returns([project]) });
        const state = manager as unknown as {
            collection: PythonEnvironment[];
            fsPathToEnv: Map<string, PythonEnvironment>;
        };
        state.collection = [environment];
        state.fsPathToEnv = new Map([[normalizePath(projectUri.fsPath), environment]]);
        runPoetryStub.onFirstCall().resolves(environment.environmentPath.fsPath);
        runPoetryStub.onSecondCall().rejects(new Error('removal failed'));

        await assert.rejects(manager.remove(environment), /removal failed/);

        assert.deepStrictEqual(state.collection, [environment]);
        assert.strictEqual(state.fsPathToEnv.size, 1);
        assert.ok(setPoetryForWorkspaceStub.notCalled);
    });

    test('clears every project mapped to the removed environment', async () => {
        const firstProject = Uri.file(path.join(os.tmpdir(), 'poetry-manager-project-one'));
        const secondProject = Uri.file(path.join(os.tmpdir(), 'poetry-manager-project-two'));
        const environment = makeEnvironment(
            'project',
            path.join(os.tmpdir(), 'poetry-cache', 'project-py3.12'),
            'ms-python.python:poetry',
        );
        const projects = [
            { name: 'project-one', uri: firstProject },
            { name: 'project-two', uri: secondProject },
        ] as PythonProject[];
        const manager = createManager({
            getPythonProject: sinon.stub().returns(projects[1]),
            getPythonProjects: sinon.stub().returns(projects),
        });
        const state = manager as unknown as {
            collection: PythonEnvironment[];
            fsPathToEnv: Map<string, PythonEnvironment>;
        };
        state.collection = [environment];
        state.fsPathToEnv = new Map([
            [normalizePath(firstProject.fsPath), environment],
            [normalizePath(secondProject.fsPath), environment],
        ]);
        runPoetryStub.onFirstCall().resolves(path.join(os.tmpdir(), 'poetry-cache', 'different-environment'));
        runPoetryStub.onSecondCall().resolves(environment.environmentPath.fsPath);
        runPoetryStub.onThirdCall().resolves('');
        const selectionEvents: DidChangeEnvironmentEventArgs[] = [];
        manager.onDidChangeEnvironment((event) => selectionEvents.push(event));

        await manager.remove(environment);

        assert.strictEqual(runPoetryStub.thirdCall.args[1], secondProject.fsPath);
        assert.strictEqual(state.fsPathToEnv.size, 0);
        assert.ok(setPoetryForWorkspaceStub.calledWithExactly(firstProject.fsPath, undefined));
        assert.ok(setPoetryForWorkspaceStub.calledWithExactly(secondProject.fsPath, undefined));
        assert.deepStrictEqual(
            selectionEvents.map((event) => event.uri),
            [firstProject, secondProject],
        );
    });

    test('rejects removal when the owning Poetry project is unknown', async () => {
        const environment = makeEnvironment(
            'project',
            path.join(os.tmpdir(), 'poetry-cache', 'project-py3.12'),
            'ms-python.python:poetry',
        );
        const manager = createManager();

        await assert.rejects(manager.remove(environment), /associated/i);

        assert.ok(runPoetryStub.notCalled);
    });

    test('clears a global selection when its Poetry environment is removed', async () => {
        const projectUri = Uri.file(path.join(os.tmpdir(), 'poetry-manager-project'));
        const environment = makeEnvironment(
            'project',
            path.join(os.tmpdir(), 'poetry-cache', 'project-py3.12'),
            'ms-python.python:poetry',
        );
        const project = { name: 'project', uri: projectUri } as PythonProject;
        const manager = createManager({
            getPythonProject: sinon.stub().returns(project),
            getPythonProjects: sinon.stub().returns([project]),
        });
        runPoetryStub.onFirstCall().resolves(environment.environmentPath.fsPath);
        runPoetryStub.onSecondCall().resolves('');
        await manager.set(undefined, environment);

        await manager.remove(environment);

        assert.strictEqual(await manager.get(undefined), undefined);
        assert.ok(setPoetryForGlobalStub.calledWithExactly(environment.environmentPath.fsPath));
        assert.ok(setPoetryForGlobalStub.calledWithExactly(undefined));
    });
});
