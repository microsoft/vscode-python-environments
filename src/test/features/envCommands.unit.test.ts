import * as assert from 'assert';
import * as sinon from 'sinon';
import * as typeMoq from 'typemoq';
import { Memento, Terminal, Uri } from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi, PythonProject } from '../../api';
import * as commandApi from '../../common/command.api';
import { INLINE_SCRIPT_ENVS_KEY, INLINE_SCRIPT_MANAGER_ID } from '../../common/constants';
import * as persistentState from '../../common/persistentState';
import * as managerApi from '../../common/pickers/managers';
import * as projectApi from '../../common/pickers/projects';
import * as windowApis from '../../common/window.apis';
import {
    clearEnvironmentCachesCommand,
    clearScriptEnvironmentCacheCommand,
    createAnyEnvironmentCommand,
    removePythonProject,
    revealEnvInManagerView,
    runInDedicatedTerminalCommand,
    runInTerminalCommand,
} from '../../features/envCommands';
import * as settingHelpers from '../../features/settings/settingHelpers';
import * as terminalRunner from '../../features/terminal/runInTerminal';
import * as shellProviders from '../../features/terminal/shells/providers';
import { ShellStartupScriptProvider } from '../../features/terminal/shells/startupProvider';
import { TerminalManager } from '../../features/terminal/terminalManager';
import { EnvManagerView } from '../../features/views/envManagersView';
import { ProjectEnvironment, ProjectItem } from '../../features/views/treeViewItems';
import { EnvironmentManagers, InternalEnvironmentManager, PythonProjectManager } from '../../internal.api';
import { setupNonThenable } from '../mocks/helper';
import { createMockPythonEnvironment } from '../mocks/pythonEnvironment';

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

suite('Remove Python Project Command Tests', () => {
    teardown(() => {
        sinon.restore();
    });

    test('clears the active environment before removing the project', async () => {
        const calls: string[] = [];
        const project: PythonProject = {
            uri: Uri.file('/some/test/workspace/project'),
            name: 'project',
        };
        const item = new ProjectItem(project);
        const envManagers = {
            setEnvironment: sinon.stub().callsFake(async () => {
                calls.push('clearEnvironment');
            }),
        } as unknown as EnvironmentManagers;
        const projectManager = {
            remove: sinon.stub().callsFake(() => {
                calls.push('removeProject');
            }),
        } as unknown as PythonProjectManager;
        sinon.stub(settingHelpers, 'removePythonProjectSetting').callsFake(async () => {
            calls.push('removeSetting');
        });

        await removePythonProject(item, projectManager, envManagers);

        assert.deepStrictEqual(calls, ['clearEnvironment', 'removeSetting', 'removeProject']);
        assert.ok(
            (envManagers.setEnvironment as sinon.SinonStub).calledOnceWithExactly(project.uri, undefined),
            'Should clear the project environment through the central manager',
        );
    });
});

suite('Clear Script Environment Cache Command Tests', () => {
    teardown(() => {
        sinon.restore();
    });

    test('cancels without clearing the cache or touching project settings', async () => {
        const clearInlineScriptCache = sinon.stub().resolves();
        const envManagers = {
            getEnvironmentManager: sinon.stub().withArgs(INLINE_SCRIPT_MANAGER_ID).returns({
                supportsClearCache: () => true,
            }),
            clearInlineScriptCache,
        } as unknown as EnvironmentManagers;
        sinon.stub(windowApis, 'showWarningMessage').resolves(undefined);

        await clearScriptEnvironmentCacheCommand(envManagers);

        sinon.assert.notCalled(clearInlineScriptCache);
    });

    test('delegates coordinated inline cache and project cleanup', async () => {
        const clearInlineScriptCache = sinon.stub().resolves();
        const envManagers = {
            getEnvironmentManager: sinon.stub().withArgs(INLINE_SCRIPT_MANAGER_ID).returns({
                supportsClearCache: () => true,
            }),
            clearInlineScriptCache,
        } as unknown as EnvironmentManagers;
        sinon.stub(windowApis, 'showWarningMessage').resolves('Clear Cache' as never);

        await clearScriptEnvironmentCacheCommand(envManagers);

        sinon.assert.calledOnce(clearInlineScriptCache);
    });

    test('propagates coordinated cleanup failures', async () => {
        const clearInlineScriptCache = sinon.stub().rejects(new Error('one cache entry could not be deleted'));
        const envManagers = {
            getEnvironmentManager: sinon.stub().withArgs(INLINE_SCRIPT_MANAGER_ID).returns({
                supportsClearCache: () => true,
            }),
            clearInlineScriptCache,
        } as unknown as EnvironmentManagers;
        sinon.stub(windowApis, 'showWarningMessage').resolves('Clear Cache' as never);

        await assert.rejects(clearScriptEnvironmentCacheCommand(envManagers), /could not be deleted/);

        sinon.assert.calledOnce(clearInlineScriptCache);
    });
});

suite('Clear Environment Caches Command Tests', () => {
    teardown(() => {
        sinon.restore();
    });

    function makeWorkspaceMemento(store: Map<string, unknown>): Memento {
        return {
            get: <T>(key: string) => store.get(key) as T | undefined,
            update: async (key: string, value: unknown) => {
                if (value === undefined) {
                    store.delete(key);
                } else {
                    store.set(key, value);
                }
            },
            keys: () => [...store.keys()],
        } as unknown as Memento;
    }

    test('generic clear preserves the inline association key while clearing other workspace/global state and managers', async () => {
        const inlineAssociations = { 'C:\\workspace\\script.py': 'C:\\cache\\python.exe' };
        const store = new Map<string, unknown>([
            [INLINE_SCRIPT_ENVS_KEY, inlineAssociations],
            ['other-workspace-state', { stale: true }],
        ]);
        const workspaceState = makeWorkspaceMemento(store);

        const calls: string[] = [];
        let clearedWorkspaceKeys: readonly string[] | undefined;
        let globalCleared = false;
        const workspacePersistent = {
            clear: sinon.stub().callsFake(async (keys?: string[]) => {
                calls.push('workspace');
                clearedWorkspaceKeys = keys;
                for (const key of keys ?? [...store.keys()]) {
                    store.delete(key);
                }
            }),
        } as unknown as persistentState.PersistentState;
        const globalPersistent = {
            clear: sinon.stub().callsFake(async () => {
                calls.push('global');
                globalCleared = true;
            }),
        } as unknown as persistentState.PersistentState;
        sinon.stub(persistentState, 'getWorkspacePersistentState').resolves(workspacePersistent);
        sinon.stub(persistentState, 'getGlobalPersistentState').resolves(globalPersistent);

        const envManagers = {
            clearCache: sinon.stub().callsFake(async () => {
                calls.push('managers');
                // The inline association key must still be present when non-inline managers run.
                assert.deepStrictEqual(store.get(INLINE_SCRIPT_ENVS_KEY), inlineAssociations);
            }),
        } as unknown as EnvironmentManagers;
        const startupProvider = {
            clearCache: sinon.stub().callsFake(async () => {
                calls.push('shells');
            }),
        } as unknown as ShellStartupScriptProvider;
        sinon.stub(shellProviders, 'clearShellProfileCache').callsFake(async (providers) => {
            await Promise.all(providers.map((provider) => provider.clearCache()));
        });

        await clearEnvironmentCachesCommand(envManagers, [startupProvider], workspaceState);

        // Only the inline key is excluded from the explicit workspace key list handed to clear().
        assert.deepStrictEqual(clearedWorkspaceKeys, ['other-workspace-state']);
        assert.strictEqual(globalCleared, true);
        // Persistent state (workspace + global) is cleared before managers, which run before shells.
        assert.ok(calls.indexOf('managers') > calls.indexOf('workspace'), 'managers run after workspace clear');
        assert.ok(calls.indexOf('managers') > calls.indexOf('global'), 'managers run after global clear');
        assert.ok(calls.indexOf('shells') > calls.indexOf('managers'), 'shells run after managers');
        assert.strictEqual(calls[calls.length - 1], 'shells');
        // Inline association key preserved; other workspace key cleared.
        assert.deepStrictEqual(store.get(INLINE_SCRIPT_ENVS_KEY), inlineAssociations);
        assert.strictEqual(store.has('other-workspace-state'), false);
        sinon.assert.calledOnceWithExactly(envManagers.clearCache as sinon.SinonStub, undefined);
    });

    test('generic clear preserves a dormant inline association key when the inline manager is not registered', async () => {
        const inlineAssociations = { 'C:\\workspace\\script.py': 'C:\\cache\\python.exe' };
        const store = new Map<string, unknown>([[INLINE_SCRIPT_ENVS_KEY, inlineAssociations]]);
        const workspaceState = makeWorkspaceMemento(store);

        let clearedWorkspaceKeys: readonly string[] | undefined;
        const workspacePersistent = {
            clear: sinon.stub().callsFake(async (keys?: string[]) => {
                clearedWorkspaceKeys = keys;
                for (const key of keys ?? [...store.keys()]) {
                    store.delete(key);
                }
            }),
        } as unknown as persistentState.PersistentState;
        const globalPersistent = {
            clear: sinon.stub().resolves(),
        } as unknown as persistentState.PersistentState;
        sinon.stub(persistentState, 'getWorkspacePersistentState').resolves(workspacePersistent);
        sinon.stub(persistentState, 'getGlobalPersistentState').resolves(globalPersistent);

        const envManagers = {
            clearCache: sinon.stub().resolves(),
        } as unknown as EnvironmentManagers;
        sinon.stub(shellProviders, 'clearShellProfileCache').resolves();

        await clearEnvironmentCachesCommand(envManagers, [], workspaceState);

        // The only workspace key is the inline key, so the explicit list is empty and it is preserved.
        assert.deepStrictEqual(clearedWorkspaceKeys, []);
        assert.deepStrictEqual(store.get(INLINE_SCRIPT_ENVS_KEY), inlineAssociations);
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

suite('Run In Terminal Command Tests', () => {
    const scriptUri = Uri.file('/some/test/workspace/folder/script.py');
    const project: PythonProject = {
        uri: Uri.file('/some/test/workspace/folder'),
        name: 'test-folder',
    };

    let environment: PythonEnvironment;
    let resolvedEnvironment: PythonEnvironment;
    let terminal: Terminal;
    let api: PythonEnvironmentApi;
    let terminalManager: TerminalManager;
    let getPythonProject: sinon.SinonStub;
    let getEnvironment: sinon.SinonStub;
    let resolveEnvironment: sinon.SinonStub;
    let getProjectTerminal: sinon.SinonStub;
    let getDedicatedTerminal: sinon.SinonStub;
    let runInTerminalStub: sinon.SinonStub;

    setup(() => {
        environment = createMockPythonEnvironment({
            envPath: '/some/test/env/python',
            id: 'discovered-environment',
        });
        resolvedEnvironment = createMockPythonEnvironment({
            envPath: '/some/test/resolved-env/python',
            id: 'resolved-environment',
        });
        terminal = {} as Terminal;

        getPythonProject = sinon.stub().returns(project);
        getEnvironment = sinon.stub().resolves(environment);
        resolveEnvironment = sinon.stub().resolves(resolvedEnvironment);
        api = {
            getPythonProject,
            getEnvironment,
            resolveEnvironment,
        } as unknown as PythonEnvironmentApi;

        getProjectTerminal = sinon.stub().resolves(terminal);
        getDedicatedTerminal = sinon.stub().resolves(terminal);
        terminalManager = {
            getProjectTerminal,
            getDedicatedTerminal,
        } as unknown as TerminalManager;

        runInTerminalStub = sinon.stub(terminalRunner, 'runInTerminal').resolves();
    });

    teardown(() => {
        sinon.restore();
    });

    test('successful normal terminal dispatch resolves and uses the resolved environment', async () => {
        const result = await runInTerminalCommand(scriptUri, api, terminalManager);

        assert.strictEqual(result, undefined);
        sinon.assert.calledOnceWithExactly(resolveEnvironment, environment.environmentPath);
        sinon.assert.calledOnceWithExactly(getProjectTerminal, project, resolvedEnvironment);
        sinon.assert.calledOnce(runInTerminalStub);
        const [receivedEnvironment, receivedTerminal, receivedOptions] = runInTerminalStub.firstCall.args;
        assert.strictEqual(receivedEnvironment, resolvedEnvironment);
        assert.strictEqual(receivedTerminal, terminal);
        assert.deepStrictEqual(receivedOptions, {
            cwd: project.uri,
            args: [scriptUri.fsPath],
            show: true,
        });
    });

    test('successful dedicated terminal dispatch resolves and falls back to the discovered environment', async () => {
        resolveEnvironment.resolves(undefined);

        const result = await runInDedicatedTerminalCommand(scriptUri, api, terminalManager);

        assert.strictEqual(result, undefined);
        sinon.assert.calledOnceWithExactly(resolveEnvironment, environment.environmentPath);
        sinon.assert.calledOnceWithExactly(getDedicatedTerminal, scriptUri, project, environment);
        sinon.assert.calledOnce(runInTerminalStub);
        const [receivedEnvironment, receivedTerminal, receivedOptions] = runInTerminalStub.firstCall.args;
        assert.strictEqual(receivedEnvironment, environment);
        assert.strictEqual(receivedTerminal, terminal);
        assert.deepStrictEqual(receivedOptions, {
            cwd: project.uri,
            args: [scriptUri.fsPath],
            show: true,
        });
    });

    test('normal terminal dispatch rejects non-URI and missing project/environment contexts', async () => {
        await assert.rejects(
            runInTerminalCommand('not-a-uri', api, terminalManager),
            /Invalid context for run-in-terminal/,
        );
        sinon.assert.notCalled(getPythonProject);
        sinon.assert.notCalled(getEnvironment);

        getPythonProject.returns(undefined);
        await assert.rejects(runInTerminalCommand(scriptUri, api, terminalManager), /Invalid context for run-in-terminal/);

        getPythonProject.returns(project);
        getEnvironment.resolves(undefined);
        await assert.rejects(runInTerminalCommand(scriptUri, api, terminalManager), /Invalid context for run-in-terminal/);

        sinon.assert.notCalled(getProjectTerminal);
        sinon.assert.notCalled(runInTerminalStub);
    });

    test('dedicated terminal dispatch rejects non-URI and missing project/environment contexts', async () => {
        await assert.rejects(
            runInDedicatedTerminalCommand('not-a-uri', api, terminalManager),
            /Invalid context for run-in-terminal/,
        );
        sinon.assert.notCalled(getPythonProject);
        sinon.assert.notCalled(getEnvironment);

        getPythonProject.returns(undefined);
        await assert.rejects(
            runInDedicatedTerminalCommand(scriptUri, api, terminalManager),
            /Invalid context for run-in-terminal/,
        );

        getPythonProject.returns(project);
        getEnvironment.resolves(undefined);
        await assert.rejects(
            runInDedicatedTerminalCommand(scriptUri, api, terminalManager),
            /Invalid context for run-in-terminal/,
        );

        sinon.assert.notCalled(getDedicatedTerminal);
        sinon.assert.notCalled(runInTerminalStub);
    });
});
