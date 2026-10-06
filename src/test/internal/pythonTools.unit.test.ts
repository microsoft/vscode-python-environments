// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { CancellationError, CancellationTokenSource, EventEmitter, Uri, WorkspaceConfiguration } from 'vscode';
import { EnvironmentManager, Package, PythonEnvironment, PythonProject } from '../../api';
import {
    CONDA_MANAGER_ID,
    INLINE_SCRIPT_MANAGER_ID,
    PYENV_MANAGER_ID,
    PYTHON_EXTENSION_ID,
    SYSTEM_MANAGER_ID,
    VENV_MANAGER_ID,
} from '../../common/constants';
import { createDeferred } from '../../common/utils/deferred';
import * as frameUtils from '../../common/utils/frameUtils';
import { isSameOrParentPath, normalizePath } from '../../common/utils/pathUtils';
import { ProcessTerminationError } from '../../common/utils/processRunner';
import * as windowApis from '../../common/window.apis';
import * as workspaceApis from '../../common/workspace.apis';
import { PythonEnvironmentManagers } from '../../features/envManagers';
import { PythonProjectManager, PythonProjectSettings } from '../../features/projectManager';
import * as settings from '../../features/settings/settingHelpers';
import { PythonToolsApiImpl } from '../../internal/pythonTools';
import { PythonToolResult } from '../../internal/pythonToolsApi';
import {
    PythonToolError,
    pythonToolSupport,
    ToolEnvironmentManager,
    ToolPackageManager,
} from '../../internal/pythonToolSupport';

const POETRY_MANAGER_ID = `${PYTHON_EXTENSION_ID}:poetry`;
const PIPENV_MANAGER_ID = `${PYTHON_EXTENSION_ID}:pipenv`;

suite('Internal Python tools', () => {
    let temp: string;
    let root: Uri;
    let base: PythonEnvironment;
    let environments: Map<string, PythonEnvironment>;
    let projectList: PythonProject[];
    let projectSettings: PythonProjectSettings[];
    let explicitSettings: Map<string, unknown>;
    let projects: PythonProjectManager;
    let managers: PythonEnvironmentManagers;
    let api: PythonToolsApiImpl;
    let source: CancellationTokenSource;
    let venv: ToolEnvironmentManager;
    let system: ToolEnvironmentManager;
    let create: sinon.SinonStub;
    let manage: sinon.SinonStub;
    let listPackages: sinon.SinonStub;
    let folders: sinon.SinonStub;
    let progress: sinon.SinonStub;

    function environment(prefix: string, managerId = VENV_MANAGER_ID): PythonEnvironment {
        const executable = path.join(prefix, process.platform === 'win32' ? 'python.exe' : 'python');
        return {
            envId: { id: prefix, managerId },
            name: path.basename(prefix),
            displayName: prefix,
            displayPath: executable,
            environmentPath: Uri.file(executable),
            execInfo: { run: { executable } },
            sysPrefix: prefix,
            version: '3.12.4',
        };
    }

    async function addEnvironment(prefix: string, managerId = VENV_MANAGER_ID): Promise<PythonEnvironment> {
        const env = environment(prefix, managerId);
        await fs.outputFile(env.execInfo.run.executable, '');
        if ([VENV_MANAGER_ID, POETRY_MANAGER_ID, PIPENV_MANAGER_ID].includes(managerId)) {
            await fs.outputFile(path.join(prefix, 'pyvenv.cfg'), 'version = 3.12.4\n');
        }
        environments.set(normalizePath(prefix), env);
        environments.set(normalizePath(env.execInfo.run.executable), env);
        return env;
    }

    function makeManager(name: string, fallback?: PythonEnvironment): ToolEnvironmentManager {
        const selections = new Map<string, PythonEnvironment>();
        const manager: ToolEnvironmentManager = {
            name,
            preferredPackageManagerId: `${PYTHON_EXTENSION_ID}:pip`,
            get: sinon
                .stub()
                .callsFake(async (scope?: Uri) =>
                    scope ? selections.get(normalizePath(scope.fsPath)) ?? fallback : fallback,
                ),
            set: sinon.stub().callsFake(async (scope: Uri | Uri[] | undefined, env?: PythonEnvironment) => {
                for (const uri of Array.isArray(scope) ? scope : scope ? [scope] : []) {
                    if (env) {
                        selections.set(normalizePath(uri.fsPath), env);
                    } else {
                        selections.delete(normalizePath(uri.fsPath));
                    }
                }
            }),
            getEnvironments: sinon.stub().resolves(fallback ? [fallback] : []),
            resolve: sinon.stub().callsFake(async (uri: Uri) => environments.get(normalizePath(uri.fsPath))),
            refresh: sinon.stub().resolves(),
            create: sinon.stub().throws(new Error('Interactive create must not be called')),
            [pythonToolSupport]: {
                initialize: sinon.stub().resolves(),
                get: (scope) => manager.get(scope),
                getEnvironments: (scope) => manager.getEnvironments(scope),
                resolve: (scope) => manager.resolve(scope),
            },
        };
        return manager;
    }

    function registerAll(): void {
        managers.registerEnvironmentManager(venv, { extensionId: PYTHON_EXTENSION_ID });
        managers.registerEnvironmentManager(system, { extensionId: PYTHON_EXTENSION_ID });
        const pip: ToolPackageManager = {
            name: 'pip',
            manage: sinon.stub().throws(new Error('Public package route must not be called')),
            getPackages: sinon.stub().throws(new Error('Public package cache must not be called')),
            refresh: sinon.stub().resolves(),
            [pythonToolSupport]: { manage, getPackages: listPackages },
        };
        managers.registerPackageManager(pip, { extensionId: PYTHON_EXTENSION_ID });
    }

    setup(async () => {
        temp = await fs.mkdtemp(path.join(os.tmpdir(), 'python-tools-'));
        root = Uri.file(path.join(temp, 'workspace'));
        await fs.ensureDir(root.fsPath);
        environments = new Map();
        base = await addEnvironment(path.join(temp, 'base'), SYSTEM_MANAGER_ID);
        projectList = [{ name: 'workspace', uri: root }];
        projectSettings = [];
        explicitSettings = new Map();
        source = new CancellationTokenSource();
        projects = {
            initialize: () => {},
            dispose: () => {},
            create: (name, uri) => ({ name, uri }),
            add: async (items) => {
                projectList.push(...(Array.isArray(items) ? items : [items]));
            },
            remove: () => {},
            getProjects: () => projectList,
            get: (uri) =>
                [...projectList]
                    .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)
                    .find((project) => isSameOrParentPath(project.uri.fsPath, uri.fsPath)),
            onDidChangeProjects: new EventEmitter<PythonProject[] | undefined>().event,
        };
        sinon.stub(frameUtils, 'getCallingExtension').returns(PYTHON_EXTENSION_ID);
        sinon.stub(workspaceApis, 'isWorkspaceTrusted').returns(true);
        folders = sinon
            .stub(workspaceApis, 'getWorkspaceFolders')
            .returns([{ uri: root, name: 'workspace', index: 0 }]);
        sinon
            .stub(workspaceApis, 'getWorkspaceFolder')
            .callsFake((uri) =>
                folders().find((folder: { uri: Uri }) => isSameOrParentPath(folder.uri.fsPath, uri.fsPath)),
            );
        sinon.stub(workspaceApis, 'getConfiguration').callsFake(
            (section) =>
                ({
                    get: <T>(key: string, fallback?: T): T => {
                        const value = explicitSettings.get(`${section}.${key}`);
                        return (value ??
                            (key === 'defaultEnvManager'
                                ? VENV_MANAGER_ID
                                : key === 'pythonProjects'
                                ? projectSettings
                                : key === 'defaultPackageManager'
                                ? `${PYTHON_EXTENSION_ID}:pip`
                                : fallback)) as T;
                    },
                    inspect: (key: string) => ({ key, globalValue: explicitSettings.get(`${section}.${key}`) }),
                    has: () => true,
                    update: async () => {},
                } as WorkspaceConfiguration),
        );
        sinon.stub(settings, 'setAllManagerSettings').callsFake(async (edits) => {
            for (const edit of edits) {
                if (edit.project) {
                    const relative = path.relative(root.fsPath, edit.project.uri.fsPath);
                    projectSettings = projectSettings.filter((setting) => setting.path !== relative);
                    projectSettings.push({
                        path: relative,
                        envManager: edit.envManager,
                        packageManager: edit.packageManager,
                    });
                }
            }
        });
        progress = sinon.stub(windowApis, 'withProgress').throws(new Error('Tool requested UI'));
        sinon.stub(windowApis, 'showQuickPick').throws(new Error('Tool requested a picker'));
        sinon.stub(windowApis, 'showErrorMessage').throws(new Error('Tool requested a notification'));
        venv = makeManager('venv', base);
        system = makeManager('system', base);
        create = sinon.stub().callsFake(async (scope: Uri) => addEnvironment(path.join(scope.fsPath, '.venv')));
        venv[pythonToolSupport].create = create;
        manage = sinon.stub().resolves();
        listPackages = sinon.stub().resolves([]);
        managers = new PythonEnvironmentManagers(projects);
        registerAll();
        api = new PythonToolsApiImpl(managers, projects);
    });

    teardown(async () => {
        source.dispose();
        managers.dispose();
        sinon.restore();
        await fs.remove(temp);
    });

    function invoke(method: keyof Omit<PythonToolsApiImpl, 'version'>, request: unknown): Promise<PythonToolResult> {
        return Reflect.apply(api[method], api, [request, source.token]);
    }

    test('creates a local environment rather than using automatic global fallback, then reuses it', async () => {
        const result = await api.configureEnvironment({}, source.token);
        assert.strictEqual(result.status, 'success');
        assert.strictEqual(result.status === 'success' && result.created, true);
        assert.strictEqual(result.environment?.sysPrefix, path.join(root.fsPath, '.venv'));
        assert.strictEqual(result.resourcePath, root.fsPath);
        const second = await api.configureEnvironment({}, source.token);
        assert.strictEqual(second.status === 'success' && second.created, false);
        assert.strictEqual(second.environment, result.environment);
        assert.ok(create.calledOnce);
        assert.ok(progress.notCalled);
    });

    test('creates an isolated environment after a global startup selection and reload', async () => {
        await managers.setEnvironment(root, base, false);
        managers.dispose();
        managers = new PythonEnvironmentManagers(projects);
        registerAll();
        await managers.setEnvironment(root, base, false);
        api = new PythonToolsApiImpl(managers, projects);
        const result = await api.configureEnvironment({}, source.token);
        assert.strictEqual(result.status === 'success' && result.created, true);
        assert.strictEqual(create.firstCall.args[1].baseEnvironment, base);
    });

    test('isolates a pre-existing global selection without requiring selection history', async () => {
        await system.set(root, base);
        const result = await api.configureEnvironment({}, source.token);
        assert.strictEqual(result.status === 'success' && result.created, true);
        assert.strictEqual(result.environment?.sysPrefix, path.join(root.fsPath, '.venv'));
        assert.strictEqual(create.firstCall.args[1].baseEnvironment, base);
    });

    test('isolates a manually selected global interpreter and installs only into the new environment', async () => {
        await managers.setEnvironment(root, base);
        const blocked = await api.installPackages({ packages: ['requests'] }, source.token);
        assert.strictEqual(blocked.status === 'error' && blocked.code, 'ENVIRONMENT_NOT_ISOLATED');
        assert.strictEqual(blocked.environment, base);
        assert.ok(manage.notCalled);
        assert.strictEqual(managers.getLastKnownEnvironment(root), base);
        const result = await api.configureEnvironment({}, source.token);
        assert.strictEqual(result.status === 'success' && result.created, true);
        assert.strictEqual(create.firstCall.args[1].baseEnvironment, base);
        const install = await api.installPackages({ packages: ['requests'] }, source.token);
        assert.strictEqual(install.status, 'success');
        assert.strictEqual(manage.firstCall.args[0], result.environment);
        assert.ok(manage.calledOnce);
        assert.ok(create.calledOnce);
    });

    test('public global selection and read-only queries do not create or change environments', async () => {
        await managers.setEnvironment(root, base);
        const result = await api.getEnvironment({ includePackages: true }, source.token);
        assert.strictEqual(result.status, 'success');
        assert.strictEqual(result.environment, base);
        assert.strictEqual(managers.getLastKnownEnvironment(root), base);
        assert.ok(create.notCalled);
        assert.ok(manage.notCalled);
    });

    for (const [name, managerId] of [
        ['venv', VENV_MANAGER_ID],
        ['poetry', POETRY_MANAGER_ID],
        ['pipenv', PIPENV_MANAGER_ID],
        ['pyenv', PYENV_MANAGER_ID],
    ]) {
        test(`reuses an isolated ${name} environment outside the project without history`, async () => {
            const isolated = await addEnvironment(path.join(temp, `${name}-cache`), managerId);
            await fs.outputFile(path.join(isolated.sysPrefix, 'pyvenv.cfg'), 'version = 3.12.4\n');
            const manager = name === 'venv' ? venv : makeManager(name);
            if (name !== 'venv') {
                managers.registerEnvironmentManager(manager, { extensionId: PYTHON_EXTENSION_ID });
            }
            await managers.setEnvironment(root, isolated);
            const result = await api.configureEnvironment({}, source.token);
            assert.strictEqual(result.status === 'success' && result.created, false);
            assert.strictEqual(result.environment, isolated);
            const install = await api.installPackages({ packages: ['requests'] }, source.token);
            assert.strictEqual(install.status, 'success');
            assert.strictEqual(manage.firstCall.args[0], isolated);
            assert.ok(create.notCalled);
        });
    }

    test('uses a selected Pyenv base to create a project venv instead of invoking Pyenv creation', async () => {
        const selected = await addEnvironment(path.join(temp, 'pyenv-python'), PYENV_MANAGER_ID);
        const pyenv = makeManager('pyenv', selected);
        managers.registerEnvironmentManager(pyenv, { extensionId: PYTHON_EXTENSION_ID });
        await managers.setEnvironment(root, selected);
        const result = await api.configureEnvironment({}, source.token);
        assert.strictEqual(result.status === 'success' && result.created, true);
        assert.strictEqual(result.environment?.envId.managerId, VENV_MANAGER_ID);
        assert.strictEqual(create.firstCall.args[1].baseEnvironment, selected);
        assert.ok((pyenv.create as sinon.SinonStub).notCalled);
    });

    test('configuration selects a discovered cached project environment without changing read-only lookup', async () => {
        const cached = await addEnvironment(path.join(temp, 'poetry-cache'), POETRY_MANAGER_ID);
        const poetry = makeManager('poetry');
        const resolveProject = sinon.stub().resolves(cached);
        poetry[pythonToolSupport].resolveProject = resolveProject;
        managers.registerEnvironmentManager(poetry, { extensionId: PYTHON_EXTENSION_ID });
        explicitSettings.set('python-envs.defaultEnvManager', POETRY_MANAGER_ID);
        const query = await api.getEnvironment({}, source.token);
        assert.strictEqual(query.status === 'error' && query.code, 'ENVIRONMENT_NOT_FOUND');
        assert.ok(resolveProject.notCalled);
        const configured = await api.configureEnvironment({}, source.token);
        assert.strictEqual(configured.status === 'success' && configured.created, false);
        assert.strictEqual(configured.environment, cached);
        assert.strictEqual(resolveProject.firstCall.args[0].fsPath, root.fsPath);
        assert.strictEqual((await api.getEnvironment({}, source.token)).environment, cached);
        assert.ok(create.notCalled && (poetry.create as sinon.SinonStub).notCalled);
    });

    test('does not treat a global interpreter located inside the workspace as isolated', async () => {
        const portable = await addEnvironment(path.join(root.fsPath, 'portable-python'), SYSTEM_MANAGER_ID);
        await managers.setEnvironment(root, portable);
        const install = await api.installPackages({ packages: ['requests'] }, source.token);
        assert.strictEqual(install.status === 'error' && install.code, 'ENVIRONMENT_NOT_ISOLATED');
        const configured = await api.configureEnvironment({}, source.token);
        assert.strictEqual(configured.status === 'success' && configured.created, true);
        assert.strictEqual(create.firstCall.args[1].baseEnvironment, portable);
        assert.ok(manage.notCalled);
    });

    test('rejects creation that returns a global interpreter instead of an isolated environment', async () => {
        create.resolves(base);
        const result = await api.configureEnvironment({}, source.token);
        assert.strictEqual(result.status === 'error' && result.code, 'INVALID_ENVIRONMENT');
        assert.strictEqual(result.environment, base);
        assert.ok((system.set as sinon.SinonStub).notCalled);
    });

    test('reusing an existing environment directory uses only the private resolver', async () => {
        const local = await addEnvironment(path.join(root.fsPath, '.venv'));
        venv[pythonToolSupport].resolve = sinon.stub().resolves(local);
        (venv.resolve as sinon.SinonStub).rejects(new Error('Public resolver must not be called'));
        const result = await api.configureEnvironment({}, source.token);
        assert.strictEqual(result.status, 'success', JSON.stringify(result));
        assert.strictEqual(result.environment, local);
        assert.ok(create.notCalled);
    });

    test('honors an explicit interpreter file URI and keeps the public setter flat', async () => {
        const alternate = await addEnvironment(path.join(temp, 'alternate'), SYSTEM_MANAGER_ID);
        const result = await api.configureEnvironment(
            { resourcePath: root.toString(), pythonPath: alternate.environmentPath.toString() },
            source.token,
        );
        assert.strictEqual(result.environment, alternate);
        assert.strictEqual((await api.getEnvironment({}, source.token)).environment, alternate);
        assert.ok(create.notCalled);
    });

    test('explicit global pythonPath is exact selection, not permission for global package writes', async () => {
        const selected = await api.configureEnvironment({ pythonPath: base.execInfo.run.executable }, source.token);
        assert.strictEqual(selected.status === 'success' && selected.created, false);
        assert.strictEqual(selected.environment, base);
        assert.ok(create.notCalled);
        const install = await api.installPackages({ packages: ['requests'] }, source.token);
        assert.strictEqual(install.status === 'error' && install.code, 'ENVIRONMENT_NOT_ISOLATED');
        assert.ok(manage.notCalled);
        const configured = await api.configureEnvironment({}, source.token);
        assert.strictEqual(configured.status === 'success' && configured.created, true);
        assert.strictEqual(create.firstCall.args[1].baseEnvironment, base);
    });

    test('an explicit Python path can switch away from an unavailable old manager', async () => {
        explicitSettings.set('python-envs.defaultEnvManager', 'missing.extension:manager');
        const alternate = await addEnvironment(path.join(temp, 'alternate'), SYSTEM_MANAGER_ID);
        const result = await api.configureEnvironment({ pythonPath: alternate.execInfo.run.executable }, source.token);
        assert.strictEqual(result.status, 'success');
        assert.strictEqual(result.environment, alternate);
    });

    test('serializes project-root and file aliases by their effective scope and rechecks after creation', async () => {
        const script = Uri.file(path.join(root.fsPath, 'main.py'));
        await fs.outputFile(script.fsPath, '');
        const started = createDeferred<void>();
        const release = createDeferred<void>();
        create.callsFake(async (scope: Uri) => {
            started.resolve();
            await release.promise;
            return addEnvironment(path.join(scope.fsPath, '.venv'));
        });
        const first = api.configureEnvironment({ resourcePath: root.fsPath }, source.token);
        await started.promise;
        const second = api.configureEnvironment({ resourcePath: script.fsPath }, source.token);
        release.resolve();
        const results = await Promise.all([first, second]);
        assert.ok(results.every((result) => result.status === 'success'));
        assert.strictEqual(results[0].environment, results[1].environment);
        assert.ok(create.calledOnce);
        assert.strictEqual(results[1].status === 'success' && results[1].created, false);
    });

    test('queued operations wait beyond the discovery timeout and a cancelled waiter cannot release the next reader early', async () => {
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const started = createDeferred<void>();
        const release = createDeferred<void>();
        create.callsFake(async (scope: Uri) => {
            started.resolve();
            await release.promise;
            return addEnvironment(path.join(scope.fsPath, '.venv'));
        });
        const first = api.configureEnvironment({ resourcePath: root.fsPath }, source.token);
        await started.promise;
        const waiterSource = new CancellationTokenSource();
        try {
            const entered = createDeferred<void>();
            const initialize = venv[pythonToolSupport].initialize as sinon.SinonStub;
            initialize.onCall(initialize.callCount).callsFake(async () => entered.resolve());
            let completed = false;
            const queued = api.configureEnvironment({ resourcePath: root.fsPath }, waiterSource.token).then(
                (result) => {
                    completed = true;
                    return { result };
                },
                (error: unknown) => {
                    completed = true;
                    return { error };
                },
            );
            await entered.promise;
            await clock.tickAsync(31_000);
            assert.strictEqual(completed, false, 'An owned operation is not a discovery timeout');
            waiterSource.cancel();
            const cancelled = await queued;
            assert.ok('error' in cancelled && cancelled.error instanceof CancellationError);

            const readEntered = createDeferred<void>();
            initialize.onCall(initialize.callCount).callsFake(async () => readEntered.resolve());
            let readCompleted = false;
            const read = api.getEnvironment({ resourcePath: root.fsPath }, source.token).then((result) => {
                readCompleted = true;
                return result;
            });
            await readEntered.promise;
            await clock.tickAsync(0);
            assert.strictEqual(readCompleted, false);
            release.resolve();
            const configured = await first;
            const result = await read;
            assert.strictEqual(result.status, 'success');
            assert.strictEqual(result.environment, configured.environment);
            assert.ok(create.calledOnce);
        } finally {
            release.resolve();
            await first;
            waiterSource.dispose();
        }
    });

    test('package reads wait for the preceding install, without blocking another workspace', async () => {
        await api.configureEnvironment({ resourcePath: root.fsPath }, source.token);
        const other = Uri.file(path.join(temp, 'other-workspace'));
        await fs.ensureDir(other.fsPath);
        projectList.push({ name: 'other', uri: other });
        folders.returns([
            { uri: root, name: 'workspace', index: 0 },
            { uri: other, name: 'other', index: 1 },
        ]);
        const started = createDeferred<void>();
        const release = createDeferred<void>();
        manage.callsFake(async () => {
            started.resolve();
            await release.promise;
            listPackages.resolves([{ name: 'installed', version: '1.0' }]);
        });
        const install = api.installPackages({ resourcePath: root.fsPath, packages: ['installed'] }, source.token);
        await started.promise;
        const read = api.getEnvironment({ resourcePath: root.fsPath, includePackages: true }, source.token);
        try {
            const independent = await api.getEnvironment({ resourcePath: other.fsPath }, source.token);
            assert.strictEqual(independent.status, 'success');
            assert.ok(listPackages.notCalled);
            release.resolve();
            assert.strictEqual((await install).status, 'success');
            const result = await read;
            assert.deepStrictEqual(result.status === 'success' && result.packages, [
                { name: 'installed', version: '1.0' },
            ]);
        } finally {
            release.resolve();
            await Promise.all([install, read]);
        }
    });

    test('reports completed selection as success when cancellation arrives after persistence', async () => {
        const persist = managers.setEnvironmentForTools.bind(managers);
        sinon.stub(managers, 'setEnvironmentForTools').callsFake(async (scope, environment, token) => {
            await persist(scope, environment, token);
            source.cancel();
        });
        const result = await api.configureEnvironment({ resourcePath: root.fsPath }, source.token);
        assert.strictEqual(result.status, 'success');
        assert.strictEqual(managers.getLastKnownEnvironment(root), result.environment);
        assert.ok(projectSettings.length > 0, 'The completed settings write is not presented as cancelled');
    });

    test('reports a completed package operation as success when cancellation arrives on return', async () => {
        await api.configureEnvironment({ resourcePath: root.fsPath }, source.token);
        let installed = false;
        manage.callsFake(async () => {
            installed = true;
            source.cancel();
        });
        const result = await api.installPackages({ resourcePath: root.fsPath, packages: ['installed'] }, source.token);
        assert.ok(installed);
        assert.strictEqual(result.status, 'success');
    });

    test('explicit interpreter selection rechecks scope if inline routing changes during preflight', async () => {
        const script = Uri.file(path.join(root.fsPath, 'script.py'));
        await fs.outputFile(script.fsPath, '');
        const inline = makeManager('inline-script');
        managers.registerEnvironmentManager(inline, { extensionId: PYTHON_EXTENSION_ID });
        const persist = sinon.spy(managers, 'setEnvironmentForTools');
        system[pythonToolSupport].describe = async (environment) => {
            projectList.push({ uri: script, name: 'script' });
            projectSettings.push({ path: 'script.py', envManager: INLINE_SCRIPT_MANAGER_ID });
            return environment;
        };
        const result = await api.configureEnvironment(
            { resourcePath: script.fsPath, pythonPath: base.execInfo.run.executable },
            source.token,
        );
        assert.strictEqual(result.status === 'error' && result.code, 'RESOURCE_CHANGED');
        assert.ok(persist.notCalled);
        assert.ok(create.notCalled);
    });

    test('preserves a created environment when persisting its selection fails', async () => {
        sinon.stub(managers, 'setEnvironmentForTools').rejects(new Error('Settings write failed'));
        const result = await api.configureEnvironment({}, source.token);
        assert.strictEqual(result.status === 'error' && result.code, 'CONFIGURATION_FAILED');
        assert.strictEqual(result.environment?.sysPrefix, path.join(root.fsPath, '.venv'));
        assert.ok(result.environment && (await fs.pathExists(result.environment.execInfo.run.executable)));
    });

    test('uses the configured default interpreter as the creation base instead of a cached global', async () => {
        const alternate = await addEnvironment(path.join(temp, 'alternate'), SYSTEM_MANAGER_ID);
        explicitSettings.set('python.defaultInterpreterPath', alternate.execInfo.run.executable);
        const result = await api.configureEnvironment({}, source.token);
        assert.strictEqual(result.status === 'success' && result.created, true);
        assert.strictEqual(create.firstCall.args[1].baseEnvironment, alternate);
    });

    test('routes a registered nested Python file to its exact scope but creates in its directory', async () => {
        const script = Uri.file(path.join(root.fsPath, 'nested', 'script.py'));
        await fs.outputFile(script.fsPath, '');
        projectList.push({ uri: script, name: 'script' });
        const result = await api.configureEnvironment({ resourcePath: script.fsPath }, source.token);
        assert.strictEqual(result.status, 'success');
        assert.strictEqual(result.resourcePath, script.fsPath);
        assert.strictEqual(create.firstCall.args[0].fsPath, path.dirname(script.fsPath));
        assert.strictEqual((venv.set as sinon.SinonStub).firstCall.args[0].fsPath, script.fsPath);
    });

    test('keeps explicit nested directories separate from their containing project', async () => {
        const nested = Uri.file(path.join(root.fsPath, 'nested'));
        await fs.ensureDir(nested.fsPath);
        const result = await api.configureEnvironment({ resourcePath: nested.fsPath }, source.token);
        assert.strictEqual(result.resourcePath, nested.fsPath);
        assert.strictEqual(result.environment?.sysPrefix, path.join(nested.fsPath, '.venv'));
        assert.strictEqual(projectList.length, 2);
    });

    test('supports inline-script creation by explicit capability without quickCreateConfig', async () => {
        const script = Uri.file(path.join(root.fsPath, 'script.py'));
        await fs.outputFile(script.fsPath, '');
        projectList.push({ uri: script, name: 'script' });
        projectSettings.push({ path: 'script.py', envManager: INLINE_SCRIPT_MANAGER_ID });
        const inline = makeManager('inline-script');
        const created = await addEnvironment(path.join(temp, 'inline-cache'), INLINE_SCRIPT_MANAGER_ID);
        const createInline = sinon.stub().resolves(created);
        inline[pythonToolSupport].create = createInline;
        managers.registerEnvironmentManager(inline, { extensionId: PYTHON_EXTENSION_ID });
        sinon.stub(managers, 'setEnvironmentForTools').resolves();
        const result = await api.configureEnvironment({ resourcePath: script.fsPath }, source.token);
        assert.strictEqual(result.environment, created);
        assert.strictEqual(createInline.firstCall.args[0].fsPath, script.fsPath);
    });

    test('configuration can set up a fresh inline script without changing ordinary pre-setup routing', async () => {
        const script = Uri.file(path.join(root.fsPath, 'script.py'));
        await fs.outputFile(script.fsPath, '# /// script\n# dependencies = []\n# ///\n');
        const inline = makeManager('inline-script');
        const created = await addEnvironment(path.join(temp, 'inline-cache'), INLINE_SCRIPT_MANAGER_ID);
        const canConfigure = sinon.stub().resolves(true);
        const createInline = sinon.stub().resolves(created);
        inline[pythonToolSupport].canConfigure = canConfigure;
        inline[pythonToolSupport].create = createInline;
        managers.registerEnvironmentManager(inline, { extensionId: PYTHON_EXTENSION_ID });
        const persist = sinon.stub(managers, 'setEnvironmentForTools').resolves();
        assert.strictEqual(managers.getEnvironmentManager(script)?.id, VENV_MANAGER_ID);
        assert.strictEqual((await api.getEnvironment({ resourcePath: script.fsPath }, source.token)).environment, base);
        assert.ok(canConfigure.notCalled);
        const configured = await api.configureEnvironment({ resourcePath: script.fsPath }, source.token);
        assert.strictEqual(configured.status, 'success', JSON.stringify(configured));
        assert.strictEqual(configured.environment, created);
        assert.strictEqual(configured.resourcePath, script.fsPath);
        assert.strictEqual(persist.firstCall.args[0].fsPath, script.fsPath);
        assert.strictEqual(createInline.firstCall.args[0].fsPath, script.fsPath);
        assert.ok(create.notCalled);
        assert.strictEqual(projectList.length, 1);
    });

    test('directory configuration never treats an enabled inline manager as its creator', async () => {
        const inline = makeManager('inline-script');
        const canConfigure = sinon.stub().resolves(true);
        inline[pythonToolSupport].canConfigure = canConfigure;
        managers.registerEnvironmentManager(inline, { extensionId: PYTHON_EXTENSION_ID });
        const configured = await api.configureEnvironment({}, source.token);
        assert.strictEqual(configured.status === 'success' && configured.created, true);
        assert.ok(create.calledOnce);
        assert.ok(canConfigure.notCalled);
    });

    test('inline setup can install owned dependencies but direct tool package mutation is rejected', async () => {
        const script = Uri.file(path.join(root.fsPath, 'script.py'));
        await fs.outputFile(script.fsPath, '');
        projectList.push({ uri: script, name: 'script' });
        projectSettings.push({ path: 'script.py', envManager: INLINE_SCRIPT_MANAGER_ID });
        const inline = makeManager('inline-script');
        const created = await addEnvironment(path.join(temp, 'inline-cache'), INLINE_SCRIPT_MANAGER_ID);
        inline[pythonToolSupport].create = async (_scope, operation) => {
            await operation.managePackages(created, { install: ['requests'] });
            (inline.get as sinon.SinonStub).resolves(created);
            return created;
        };
        managers.registerEnvironmentManager(inline, { extensionId: PYTHON_EXTENSION_ID });
        sinon.stub(managers, 'setEnvironmentForTools').resolves();
        const configured = await api.configureEnvironment({ resourcePath: script.fsPath }, source.token);
        assert.strictEqual(configured.status, 'success', JSON.stringify(configured));
        assert.ok(manage.calledOnce);
        const install = await api.installPackages({ resourcePath: script.fsPath, packages: ['other'] }, source.token);
        assert.strictEqual(install.status === 'error' && install.code, 'IMMUTABLE_ENVIRONMENT');
        assert.strictEqual(install.environment, created);
        assert.ok(manage.calledOnce, 'No second package mutation may enter the shared cache');
    });

    test('rejects unsupported creation instead of calling an interactive manager create', async () => {
        const poetry = makeManager('poetry');
        managers.registerEnvironmentManager(poetry, { extensionId: PYTHON_EXTENSION_ID });
        explicitSettings.set('python-envs.defaultEnvManager', POETRY_MANAGER_ID);
        const result = await api.configureEnvironment({}, source.token);
        assert.strictEqual(result.status === 'error' && result.code, 'UNSUPPORTED_CREATION');
        assert.ok((poetry.create as sinon.SinonStub).notCalled);
        assert.ok(create.notCalled);
    });

    test('a System manager setting without a selection still routes automatic creation through venv', async () => {
        explicitSettings.set('python-envs.defaultEnvManager', SYSTEM_MANAGER_ID);
        (system.get as sinon.SinonStub).resolves(undefined);
        const result = await api.configureEnvironment({}, source.token);
        assert.strictEqual(result.status === 'success' && result.created, true);
        assert.ok(create.calledOnce);
        assert.strictEqual(create.firstCall.args[1].baseEnvironment, undefined);
        assert.ok((system.create as sinon.SinonStub).notCalled);
    });

    test('rejects contributed managers that have not opted into the internal capability', async () => {
        const contributed: EnvironmentManager = { ...makeManager('custom') };
        Reflect.deleteProperty(contributed, pythonToolSupport);
        managers.registerEnvironmentManager(contributed, { extensionId: PYTHON_EXTENSION_ID });
        explicitSettings.set('python-envs.defaultEnvManager', `${PYTHON_EXTENSION_ID}:custom`);
        const result = await api.configureEnvironment({}, source.token);
        assert.strictEqual(result.status === 'error' && result.code, 'UNSUPPORTED_MANAGER');
        assert.ok((contributed.get as sinon.SinonStub).notCalled);
    });

    test('uses Conda capability instead of replacing the configured manager with venv', async () => {
        const conda = makeManager('conda', base);
        const createConda = sinon
            .stub()
            .callsFake(async (scope: Uri) => addEnvironment(path.join(scope.fsPath, '.conda'), CONDA_MANAGER_ID));
        conda[pythonToolSupport].create = createConda;
        managers.registerEnvironmentManager(conda, { extensionId: PYTHON_EXTENSION_ID });
        explicitSettings.set('python-envs.defaultEnvManager', CONDA_MANAGER_ID);
        const result = await api.configureEnvironment({}, source.token);
        assert.strictEqual(result.environment?.envId.managerId, CONDA_MANAGER_ID);
        assert.ok(createConda.calledOnce);
        assert.ok(create.notCalled);
    });

    for (const manual of [false, true]) {
        test(`isolates ${
            manual ? 'manually selected' : 'automatically selected'
        } Conda base before package writes`, async () => {
            const condaBase = {
                ...(await addEnvironment(path.join(temp, 'conda-base'), CONDA_MANAGER_ID)),
                name: 'base',
            };
            const conda = makeManager('conda', condaBase);
            const createConda = sinon
                .stub()
                .callsFake(async (scope: Uri) => addEnvironment(path.join(scope.fsPath, '.conda'), CONDA_MANAGER_ID));
            conda[pythonToolSupport].create = createConda;
            managers.registerEnvironmentManager(conda, { extensionId: PYTHON_EXTENSION_ID });
            explicitSettings.set('python-envs.defaultEnvManager', CONDA_MANAGER_ID);
            if (manual) {
                await managers.setEnvironment(root, condaBase);
            }
            const install = await api.installPackages({ packages: ['requests'] }, source.token);
            assert.strictEqual(install.status === 'error' && install.code, 'ENVIRONMENT_NOT_ISOLATED');
            assert.ok(manage.notCalled);
            const configure = await api.configureEnvironment({}, source.token);
            assert.strictEqual(configure.status, 'success', JSON.stringify(configure));
            assert.strictEqual(configure.environment?.sysPrefix, path.join(root.fsPath, '.conda'));
            assert.ok(createConda.calledOnce);
            assert.strictEqual(createConda.firstCall.args[1].baseEnvironment, condaBase);
            assert.ok(create.notCalled);
        });
    }

    for (const name of ['named-environment', 'base']) {
        test(`reuses an existing isolated Conda prefix named ${name}`, async () => {
            const isolated = {
                ...(await addEnvironment(path.join(temp, 'environments', name), CONDA_MANAGER_ID)),
                group: 'Prefix',
            };
            const conda = makeManager('conda', isolated);
            managers.registerEnvironmentManager(conda, { extensionId: PYTHON_EXTENSION_ID });
            explicitSettings.set('python-envs.defaultEnvManager', CONDA_MANAGER_ID);
            const result = await api.configureEnvironment({}, source.token);
            assert.strictEqual(result.status === 'success' && result.created, false);
            assert.strictEqual(result.environment, isolated);
            assert.strictEqual((await api.installPackages({ packages: ['requests'] }, source.token)).status, 'success');
            assert.strictEqual(manage.firstCall.args[0], isolated);
            assert.ok(create.notCalled);
        });
    }

    test('package queries return an explicit empty array and preserve query failures with the environment', async () => {
        const empty = await api.getEnvironment({ includePackages: true }, source.token);
        assert.deepStrictEqual(empty.status === 'success' && empty.packages, []);
        listPackages.rejects(new Error('pip list failed'));
        const failed = await api.getEnvironment({ includePackages: true }, source.token);
        assert.strictEqual(failed.status === 'error' && failed.code, 'PACKAGE_QUERY_FAILED');
        assert.strictEqual(failed.environment, base);
    });

    test('package queries return string version DTOs', async () => {
        listPackages.resolves([{ name: 'requests', version: '2.32.0' } as Package]);
        const result = await api.getEnvironment({ includePackages: true }, source.token);
        assert.deepStrictEqual(result.status === 'success' && result.packages, [
            { name: 'requests', version: '2.32.0' },
        ]);
    });

    test('requires configure before installing into automatic global fallback and forwards the real token', async () => {
        const initial = await api.installPackages({ packages: ['requests'] }, source.token);
        assert.strictEqual(initial.status === 'error' && initial.code, 'ENVIRONMENT_NOT_ISOLATED');
        assert.ok(manage.notCalled);
        await api.configureEnvironment({}, source.token);
        const result = await api.installPackages({ packages: ['requests'] }, source.token);
        assert.strictEqual(result.status, 'success');
        assert.strictEqual(manage.firstCall.args[1].runHeadless, true);
        assert.strictEqual(manage.firstCall.args[2], source.token);
        assert.strictEqual(manage.firstCall.args[3].fsPath, root.fsPath);
    });

    test('returns partial creation and reuses its directory rather than creating a suffixed environment', async () => {
        const partial = await addEnvironment(path.join(root.fsPath, '.venv'));
        environments.clear();
        await fs.remove(partial.sysPrefix);
        create.callsFake(async () => {
            await fs.outputFile(partial.execInfo.run.executable, '');
            await fs.outputFile(path.join(partial.sysPrefix, 'pyvenv.cfg'), 'version = 3.12.4\n');
            environments.set(normalizePath(partial.sysPrefix), partial);
            throw new PythonToolError('PACKAGE_INSTALL_FAILED', 'Project dependency installation failed', partial);
        });
        const failed = await api.configureEnvironment({}, source.token);
        assert.strictEqual(failed.status === 'error' && failed.code, 'PACKAGE_INSTALL_FAILED');
        assert.strictEqual(failed.environment, partial);
        const retry = await api.configureEnvironment({}, source.token);
        assert.strictEqual(retry.environment, partial);
        assert.ok(create.calledOnce);
    });

    test('rejects invalid requests and package options without entering manager operations', async () => {
        for (const request of [
            null,
            [],
            { resourcePath: '' },
            { resourcePath: 'relative' },
            { resourcePath: 'https://example.org/project' },
            { resourcePath: 42 },
        ]) {
            const result = await invoke('getEnvironment', request);
            assert.strictEqual(result.status === 'error' && result.code, 'INVALID_REQUEST');
        }
        for (const packages of [[], [''], ['--index-url'], ['a\nb'], [42], 'requests']) {
            const result = await invoke('installPackages', { packages });
            assert.strictEqual(result.status === 'error' && result.code, 'INVALID_REQUEST');
        }
        assert.strictEqual((await invoke('getEnvironment', { includePackages: 'yes' })).status, 'error');
        assert.ok(create.notCalled);
        assert.ok(manage.notCalled);
    });

    test('reports workspace ambiguity with paths and never guesses a root', async () => {
        const other = Uri.file(path.join(temp, 'other'));
        folders.returns([
            { uri: root, name: 'workspace', index: 0 },
            { uri: other, name: 'other', index: 1 },
        ]);
        const result = await api.configureEnvironment({}, source.token);
        assert.strictEqual(result.status === 'error' && result.code, 'AMBIGUOUS_RESOURCE');
        assert.ok(
            result.status === 'error' && result.message.includes(root.fsPath) && result.message.includes(other.fsPath),
        );
        folders.returns([]);
        assert.strictEqual((await api.configureEnvironment({}, source.token)).status, 'error');
        assert.ok(create.notCalled);
    });

    test('enforces trust before executing queries or mutations', async () => {
        (workspaceApis.isWorkspaceTrusted as sinon.SinonStub).returns(false);
        for (const method of ['getEnvironment', 'configureEnvironment', 'installPackages'] as const) {
            const result = await invoke(method, { packages: ['requests'] });
            assert.strictEqual(result.status === 'error' && result.code, 'WORKSPACE_UNTRUSTED');
        }
        assert.ok((venv.get as sinon.SinonStub).notCalled);
    });

    test('bounds real discovery and does not report cached fallback as ready', async () => {
        const clock = sinon.useFakeTimers();
        const started = createDeferred<void>();
        (venv[pythonToolSupport].initialize as sinon.SinonStub).callsFake(() => {
            started.resolve();
            return new Promise<void>(() => {});
        });
        const pending = api.configureEnvironment({}, source.token);
        await started.promise;
        await clock.tickAsync(30_001);
        const result = await pending;
        assert.strictEqual(result.status === 'error' && result.code, 'NOT_READY');
        assert.ok(create.notCalled);
    });

    test('throws real cancellation before starting and after creation without selecting', async () => {
        source.cancel();
        await assert.rejects(api.configureEnvironment({}, source.token), CancellationError);
        source.dispose();
        source = new CancellationTokenSource();
        create.callsFake(async (scope: Uri) => {
            const env = await addEnvironment(path.join(scope.fsPath, '.venv'));
            source.cancel();
            return env;
        });
        await assert.rejects(api.configureEnvironment({}, source.token), CancellationError);
        assert.ok((venv.set as sinon.SinonStub).notCalled);
        assert.strictEqual(projectSettings.length, 0);
    });

    test('cleanup failure is an error with the selected environment even when its token is cancelled', async () => {
        const configured = await api.configureEnvironment({}, source.token);
        manage.callsFake(async () => {
            source.cancel();
            throw new ProcessTerminationError('python', new CancellationError(), new Error('Access denied'));
        });
        const result = await api.installPackages({ packages: ['requests'] }, source.token);
        assert.strictEqual(result.status === 'error' && result.code, 'PROCESS_TERMINATION_FAILED');
        assert.strictEqual(result.environment, configured.environment);
        assert.ok(result.status === 'error' && result.message.includes('may still be modifying'));
    });
});
