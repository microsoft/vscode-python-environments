// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import {
    CancellationTokenSource,
    ConfigurationTarget,
    Disposable,
    EventEmitter,
    Uri,
    WorkspaceConfiguration,
} from 'vscode';
import { PackageManager, PythonEnvironment } from '../../api';
import { PYTHON_EXTENSION_ID, SYSTEM_MANAGER_ID, VENV_MANAGER_ID } from '../../common/constants';
import * as persistentState from '../../common/persistentState';
import { createDeferred, Deferred } from '../../common/utils/deferred';
import * as frameUtils from '../../common/utils/frameUtils';
import * as windowApis from '../../common/window.apis';
import * as workspaceApis from '../../common/workspace.apis';
import { PythonEnvironmentApiImpl } from '../../extensionApi';
import { PythonEnvironmentManagers } from '../../features/envManagers';
import { applyInitialEnvironmentSelection } from '../../features/interpreterSelection';
import { PythonProjectManagerImpl } from '../../features/projectManager';
import { SYSTEM_WORKSPACE_KEY } from '../../managers/builtin/cache';
import { SysPythonManager } from '../../managers/builtin/sysPythonManager';
import * as systemUtils from '../../managers/builtin/utils';
import { VenvManager } from '../../managers/builtin/venvManager';
import * as venvUtils from '../../managers/builtin/venvUtils';
import { NativePythonFinder } from '../../managers/common/nativePythonFinder';
import { createMockLogOutputChannel } from '../mocks/helper';

suite('Python tools stateless startup selection', () => {
    let root: Uri;
    let temp: string;
    let source: CancellationTokenSource;
    let stateValues: Map<string, unknown>;
    let workspaceSettings: Map<string, unknown>;
    let userDefaultManager: string | undefined;
    let registry: PythonEnvironmentManagers;
    let api: PythonEnvironmentApiImpl;
    let projects: PythonProjectManagerImpl;
    let base: PythonEnvironment;
    let local: PythonEnvironment;
    let nativeFinder: NativePythonFinder;
    let disposables: Disposable[];
    let persistedFallback: Deferred<void>;
    let releaseFallback: Deferred<void>;
    let holdFirstFallback: boolean;
    let create: sinon.SinonStub;

    async function makeEnvironment(prefix: string, managerId: string): Promise<PythonEnvironment> {
        const executable = path.join(prefix, process.platform === 'win32' ? 'python.exe' : 'python');
        await fs.outputFile(executable, '');
        if (managerId === VENV_MANAGER_ID) {
            await fs.outputFile(path.join(prefix, 'pyvenv.cfg'), 'version = 3.14.3\n');
        }
        return {
            envId: { id: prefix, managerId },
            name: path.basename(prefix),
            displayName: prefix,
            displayPath: executable,
            environmentPath: Uri.file(executable),
            sysPrefix: prefix,
            execInfo: { run: { executable } },
            version: '3.14.3.final.0',
        };
    }

    function createHostComponents(): void {
        projects = new PythonProjectManagerImpl();
        projects.initialize();
        registry = new PythonEnvironmentManagers(projects);
        type ApiArgs = ConstructorParameters<typeof PythonEnvironmentApiImpl>;
        api = new PythonEnvironmentApiImpl(
            registry,
            projects,
            {} as ApiArgs[2],
            {} as ApiArgs[3],
            { onDidChangeEnvironmentVariables: new EventEmitter().event } as ApiArgs[4],
            disposables,
        );
        const system = new SysPythonManager(nativeFinder, api, createMockLogOutputChannel());
        const venv = new VenvManager(nativeFinder, api, system, createMockLogOutputChannel());
        const pip: PackageManager = {
            name: 'pip',
            manage: sinon.stub().resolves(),
            refresh: sinon.stub().resolves(),
            getPackages: sinon.stub().resolves([]),
        };
        disposables.push(
            api.registerEnvironmentManager(system, { extensionId: PYTHON_EXTENSION_ID }),
            api.registerEnvironmentManager(venv, { extensionId: PYTHON_EXTENSION_ID }),
            api.registerPackageManager(pip, { extensionId: PYTHON_EXTENSION_ID }),
        );
    }

    async function disposeHostComponents(): Promise<void> {
        await new Promise<void>((resolve) => setImmediate(resolve));
        disposables.splice(0).forEach((disposable) => disposable.dispose());
        registry.dispose();
        projects.dispose();
    }

    setup(async () => {
        temp = await fs.mkdtemp(path.join(os.tmpdir(), 'python-tools-startup-'));
        root = Uri.file(path.join(temp, 'workspace with spaces'));
        await fs.ensureDir(root.fsPath);
        base = await makeEnvironment(path.join(temp, 'global python'), SYSTEM_MANAGER_ID);
        local = {
            ...base,
            envId: { id: 'local', managerId: VENV_MANAGER_ID },
            environmentPath: Uri.file(path.join(root.fsPath, '.venv', 'python')),
            sysPrefix: path.join(root.fsPath, '.venv'),
            execInfo: { run: { executable: path.join(root.fsPath, '.venv', 'python') } },
        };
        source = new CancellationTokenSource();
        disposables = [];
        stateValues = new Map();
        workspaceSettings = new Map();
        userDefaultManager = VENV_MANAGER_ID;
        persistedFallback = createDeferred<void>();
        releaseFallback = createDeferred<void>();
        holdFirstFallback = true;
        nativeFinder = {} as NativePythonFinder;
        const state: persistentState.PersistentState = {
            get: async <T>(key: string, defaultValue?: T) => (stateValues.get(key) ?? defaultValue) as T | undefined,
            set: async (key, value) => {
                stateValues.set(key, value);
                if (key === SYSTEM_WORKSPACE_KEY && holdFirstFallback) {
                    holdFirstFallback = false;
                    persistedFallback.resolve();
                    await releaseFallback.promise;
                }
            },
            clear: async () => {
                stateValues.clear();
            },
        };
        sinon.stub(persistentState, 'getWorkspacePersistentState').resolves(state);
        sinon.stub(persistentState, 'getGlobalPersistentState').resolves(state);
        sinon.stub(frameUtils, 'getCallingExtension').returns(PYTHON_EXTENSION_ID);
        const folder = { uri: root, name: 'workspace with spaces', index: 0 };
        sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([folder]);
        sinon.stub(workspaceApis, 'getWorkspaceFolder').returns(folder);
        sinon.stub(workspaceApis, 'getWorkspaceFile').returns(undefined);
        sinon.stub(workspaceApis, 'isWorkspaceTrusted').returns(true);
        for (const name of [
            'onDidChangeConfiguration',
            'onDidChangeWorkspaceFolders',
            'onDidDeleteFiles',
            'onDidRenameFiles',
        ] as const) {
            sinon.stub(workspaceApis, name).returns(new Disposable(() => {}));
        }
        sinon.stub(workspaceApis, 'getConfiguration').callsFake((section) => {
            const defaults = new Map<string, unknown>([
                ['python-envs.defaultEnvManager', VENV_MANAGER_ID],
                ['python-envs.defaultPackageManager', 'ms-python.python:pip'],
                ['python-envs.pythonProjects', []],
            ]);
            const configuration: WorkspaceConfiguration = {
                get: <T>(key: string, fallback?: T) =>
                    (workspaceSettings.get(`${section}.${key}`) ?? defaults.get(`${section}.${key}`) ?? fallback) as T,
                inspect: <T>(key: string) => ({
                    key,
                    globalValue: (key === 'defaultEnvManager' ? userDefaultManager : undefined) as T | undefined,
                    workspaceValue: workspaceSettings.get(`${section}.${key}`) as T | undefined,
                }),
                has: (key) => defaults.has(`${section}.${key}`) || workspaceSettings.has(`${section}.${key}`),
                update: async (key, value, target) => {
                    assert.notStrictEqual(target, ConfigurationTarget.Global);
                    workspaceSettings.set(`${section}.${key}`, value);
                },
            };
            return configuration;
        });
        sinon
            .stub(windowApis, 'withProgress')
            .callsFake(async (_options, task) => task({ report: () => {} }, source.token));
        sinon.stub(windowApis, 'showErrorMessage').throws(new Error('Unexpected question'));
        sinon.stub(windowApis, 'showInformationMessage').throws(new Error('Unexpected question'));
        sinon.stub(systemUtils, 'refreshPythons').resolves([base]);
        sinon
            .stub(venvUtils, 'findVirtualEnvironments')
            .callsFake(async () => ((await fs.pathExists(local.execInfo.run.executable)) ? [local] : []));
        create = sinon.stub(venvUtils, 'quickCreateVenv').callsFake(async () => {
            await fs.outputFile(local.execInfo.run.executable, '');
            await fs.outputFile(path.join(local.sysPrefix, 'pyvenv.cfg'), 'version = 3.14.3\n');
            return { environment: local };
        });
        createHostComponents();
    });

    teardown(async () => {
        releaseFallback.resolve();
        await disposeHostComponents();
        source.dispose();
        sinon.restore();
        await fs.remove(temp);
    });

    test('configure isolates a global selection while startup persistence is pending and preserves it on reload', async () => {
        const startup = applyInitialEnvironmentSelection(registry, projects, nativeFinder, api);
        await persistedFallback.promise;
        try {
            const configured = await api.__pythonTools.configureEnvironment(
                { resourcePath: root.fsPath },
                source.token,
            );
            assert.strictEqual(configured.status, 'success', JSON.stringify(configured));
            assert.strictEqual(configured.environment?.sysPrefix, local.sysPrefix);
            assert.ok(create.calledOnce);
            assert.notStrictEqual(workspaceSettings.get('python-envs.defaultEnvManager'), SYSTEM_MANAGER_ID);
        } finally {
            releaseFallback.resolve();
            await startup;
        }
        await disposeHostComponents();
        createHostComponents();
        await applyInitialEnvironmentSelection(registry, projects, nativeFinder, api);
        const afterReload = await api.__pythonTools.configureEnvironment({ resourcePath: root.fsPath }, source.token);
        assert.strictEqual(afterReload.environment?.sysPrefix, local.sysPrefix);
        assert.ok(create.calledOnce);
        assert.strictEqual(stateValues.has('python-envs.selectionOrigins'), false);
    });

    test('a read-only refresh and reload do not prevent automatic project isolation', async () => {
        const startup = applyInitialEnvironmentSelection(registry, projects, nativeFinder, api);
        await persistedFallback.promise;
        await registry.refreshEnvironment(root);
        releaseFallback.resolve();
        await startup;
        await disposeHostComponents();
        createHostComponents();
        await applyInitialEnvironmentSelection(registry, projects, nativeFinder, api);
        const result = await api.__pythonTools.configureEnvironment({ resourcePath: root.fsPath }, source.token);
        assert.strictEqual(result.environment?.sysPrefix, local.sysPrefix);
        assert.ok(create.calledOnce);
        assert.strictEqual(stateValues.has('python-envs.selectionOrigins'), false);
    });

    test('a persisted global choice survives human startup but agent configure isolates it after reload', async () => {
        holdFirstFallback = false;
        stateValues.set(SYSTEM_WORKSPACE_KEY, { [root.fsPath]: base.environmentPath.fsPath });
        await applyInitialEnvironmentSelection(registry, projects, nativeFinder, api);
        assert.strictEqual(registry.getLastKnownEnvironment(root)?.sysPrefix, base.sysPrefix);
        await disposeHostComponents();
        createHostComponents();
        await applyInitialEnvironmentSelection(registry, projects, nativeFinder, api);
        const configured = await api.__pythonTools.configureEnvironment({ resourcePath: root.fsPath }, source.token);
        assert.strictEqual(configured.environment?.sysPrefix, local.sysPrefix);
        assert.ok(create.calledOnce);
    });

    test('obsolete origin records are neither consulted nor updated', async () => {
        holdFirstFallback = false;
        const oldOrigins = { [root.toString()]: { path: base.environmentPath.fsPath, origin: 'explicit' } };
        stateValues.set('python-envs.selectionOrigins', oldOrigins);
        stateValues.set(SYSTEM_WORKSPACE_KEY, { [root.fsPath]: base.environmentPath.fsPath });
        await applyInitialEnvironmentSelection(registry, projects, nativeFinder, api);
        const configured = await api.__pythonTools.configureEnvironment({}, source.token);
        assert.strictEqual(configured.status, 'success', JSON.stringify(configured));
        assert.strictEqual(configured.environment?.sysPrefix, local.sysPrefix);
        assert.ok(create.calledOnce);
        assert.strictEqual(stateValues.get('python-envs.selectionOrigins'), oldOrigins);
    });

    test('agent selection persists across reload when a global defaultInterpreterPath is configured', async () => {
        holdFirstFallback = false;
        userDefaultManager = undefined;
        workspaceSettings.set('python.defaultInterpreterPath', base.execInfo.run.executable);
        sinon.stub(systemUtils, 'resolveSystemPythonEnvironmentPath').resolves(base);
        await applyInitialEnvironmentSelection(registry, projects, nativeFinder, api);
        assert.strictEqual(registry.getLastKnownEnvironment(root)?.sysPrefix, base.sysPrefix);
        const configured = await api.__pythonTools.configureEnvironment({}, source.token);
        assert.strictEqual(configured.status, 'success', JSON.stringify(configured));
        assert.strictEqual(configured.environment?.sysPrefix, local.sysPrefix);
        assert.strictEqual(workspaceSettings.get('python-envs.defaultEnvManager'), VENV_MANAGER_ID);
        assert.strictEqual(workspaceSettings.get('python.defaultInterpreterPath'), base.execInfo.run.executable);
        await disposeHostComponents();
        createHostComponents();
        await applyInitialEnvironmentSelection(registry, projects, nativeFinder, api);
        const selected = await api.__pythonTools.getEnvironment({}, source.token);
        assert.strictEqual(selected.status, 'success', JSON.stringify(selected));
        assert.strictEqual(selected.environment?.sysPrefix, local.sysPrefix);
        assert.ok(create.calledOnce);
    });

    test('a new nested directory persists its exact project and selection without replacing root defaults', async () => {
        holdFirstFallback = false;
        const nested = Uri.file(path.join(root.fsPath, 'New Service'));
        await fs.ensureDir(nested.fsPath);
        create.callsFake(async (...args: unknown[]) => {
            const creationRoot = args[5] as Uri;
            local = await makeEnvironment(path.join(creationRoot.fsPath, '.venv'), VENV_MANAGER_ID);
            return { environment: local };
        });
        await applyInitialEnvironmentSelection(registry, projects, nativeFinder, api);
        const configured = await api.__pythonTools.configureEnvironment({ resourcePath: nested.fsPath }, source.token);
        assert.strictEqual(configured.status, 'success', JSON.stringify(configured));
        assert.strictEqual(configured.environment?.sysPrefix, path.join(nested.fsPath, '.venv'));
        assert.deepStrictEqual(workspaceSettings.get('python-envs.pythonProjects'), [
            {
                path: 'New Service',
                envManager: VENV_MANAGER_ID,
                packageManager: 'ms-python.python:pip',
            },
        ]);
        assert.strictEqual(workspaceSettings.get('python-envs.defaultEnvManager'), undefined);
        await disposeHostComponents();
        createHostComponents();
        assert.ok(projects.getProjects().some((project) => project.uri.fsPath === nested.fsPath));
        const reloaded = await api.__pythonTools.getEnvironment({ resourcePath: nested.fsPath }, source.token);
        assert.strictEqual(reloaded.environment?.sysPrefix, local.sysPrefix);
    });

    test('ordinary selection keeps the existing root-default behavior for an unconfigured nested project', async () => {
        holdFirstFallback = false;
        const nested = Uri.file(path.join(root.fsPath, 'Human Project'));
        await fs.ensureDir(nested.fsPath);
        await projects.add(projects.create('Human Project', nested), { persistSettings: false });
        await registry.setEnvironment(nested, base);
        assert.strictEqual(workspaceSettings.get('python-envs.defaultEnvManager'), SYSTEM_MANAGER_ID);
        assert.strictEqual(workspaceSettings.get('python-envs.pythonProjects'), undefined);
        assert.strictEqual(registry.getLastKnownEnvironment(nested), base);
        assert.strictEqual(stateValues.has('python-envs.selectionOrigins'), false);
    });
});
