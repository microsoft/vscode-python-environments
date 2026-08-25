import * as assert from 'assert';
import * as sinon from 'sinon';
import * as typeMoq from 'typemoq';
import { Uri } from 'vscode';
import { PythonEnvironment, PythonProject } from '../../api';
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
} from '../../features/envCommands';
import * as settingHelpers from '../../features/settings/settingHelpers';
import * as shellProviders from '../../features/terminal/shells/providers';
import { ShellStartupScriptProvider } from '../../features/terminal/shells/startupProvider';
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
        const clearCache = sinon.stub().resolves();
        const envManagers = {
            getEnvironmentManager: sinon.stub().withArgs(INLINE_SCRIPT_MANAGER_ID).returns({
                supportsClearCache: () => true,
                clearCache,
            }),
        } as unknown as EnvironmentManagers;
        const projectManager = {
            getProjects: sinon.stub().returns([]),
            remove: sinon.stub(),
        } as unknown as PythonProjectManager;
        sinon.stub(windowApis, 'showWarningMessage').resolves(undefined);
        const removeInlineSettings = sinon.stub(settingHelpers, 'removeInlineScriptPythonProjectSettings').resolves([]);

        await clearScriptEnvironmentCacheCommand(envManagers, projectManager);

        sinon.assert.notCalled(clearCache);
        sinon.assert.notCalled(removeInlineSettings);
        sinon.assert.notCalled(projectManager.remove as sinon.SinonStub);
    });

    test('clears cache before inline settings cleanup and unloads removed projects', async () => {
        const calls: string[] = [];
        const selectionEvents: string[] = [];
        let associationPresent = true;
        const inlineProject: PythonProject = {
            uri: Uri.file('/workspace/script.py'),
            name: 'script.py',
        };
        const clearCache = sinon.stub().callsFake(async () => {
            calls.push('clearCache');
            associationPresent = false;
            selectionEvents.push('cleared');
        });
        const envManagers = {
            getEnvironmentManager: sinon.stub().withArgs(INLINE_SCRIPT_MANAGER_ID).returns({
                supportsClearCache: () => true,
                clearCache,
            }),
        } as unknown as EnvironmentManagers;
        const projectManager = {
            getProjects: sinon.stub().callsFake(() => {
                calls.push('getProjects');
                return [inlineProject];
            }),
            remove: sinon.stub().callsFake(() => {
                calls.push('removeProjects');
            }),
        } as unknown as PythonProjectManager;
        sinon.stub(windowApis, 'showWarningMessage').resolves('Clear Cache' as never);
        const removeInlineSettings = sinon
            .stub(settingHelpers, 'removeInlineScriptPythonProjectSettings')
            .callsFake(async (projects) => {
                calls.push('removeInlineSettings');
                assert.deepStrictEqual(projects, [inlineProject]);
                assert.strictEqual(associationPresent, false);
                assert.deepStrictEqual(selectionEvents, ['cleared']);
                return [inlineProject];
            });

        await clearScriptEnvironmentCacheCommand(envManagers, projectManager);

        sinon.assert.calledOnce(clearCache);
        sinon.assert.calledOnce(removeInlineSettings);
        sinon.assert.calledOnceWithExactly(projectManager.remove as sinon.SinonStub, [inlineProject]);
        assert.deepStrictEqual(calls, ['clearCache', 'getProjects', 'removeInlineSettings', 'removeProjects']);
    });

    test('keeps loaded projects when inline settings cleanup leaves them configured', async () => {
        const inlineProject: PythonProject = {
            uri: Uri.file('/workspace/runner'),
            name: 'runner',
        };
        const clearCache = sinon.stub().resolves();
        const envManagers = {
            getEnvironmentManager: sinon.stub().withArgs(INLINE_SCRIPT_MANAGER_ID).returns({
                supportsClearCache: () => true,
                clearCache,
            }),
        } as unknown as EnvironmentManagers;
        const projectManager = {
            getProjects: sinon.stub().returns([inlineProject]),
            remove: sinon.stub(),
        } as unknown as PythonProjectManager;
        sinon.stub(windowApis, 'showWarningMessage').resolves('Clear Cache' as never);
        const removeInlineSettings = sinon.stub(settingHelpers, 'removeInlineScriptPythonProjectSettings').resolves([]);

        await clearScriptEnvironmentCacheCommand(envManagers, projectManager);

        sinon.assert.calledOnce(clearCache);
        sinon.assert.calledOnceWithExactly(removeInlineSettings, [inlineProject]);
        sinon.assert.notCalled(projectManager.remove as sinon.SinonStub);
    });

    test('preserves project settings when cache cleanup reports a partial failure', async () => {
        const clearCache = sinon.stub().rejects(new Error('one cache entry could not be deleted'));
        const envManagers = {
            getEnvironmentManager: sinon.stub().withArgs(INLINE_SCRIPT_MANAGER_ID).returns({
                supportsClearCache: () => true,
                clearCache,
            }),
        } as unknown as EnvironmentManagers;
        const projectManager = {
            getProjects: sinon.stub().returns([]),
            remove: sinon.stub(),
        } as unknown as PythonProjectManager;
        sinon.stub(windowApis, 'showWarningMessage').resolves('Clear Cache' as never);
        const removeInlineSettings = sinon.stub(settingHelpers, 'removeInlineScriptPythonProjectSettings').resolves([]);

        await assert.rejects(clearScriptEnvironmentCacheCommand(envManagers, projectManager), /could not be deleted/);

        sinon.assert.calledOnce(clearCache);
        sinon.assert.notCalled(removeInlineSettings);
        sinon.assert.notCalled(projectManager.remove as sinon.SinonStub);
    });
});

suite('Clear Environment Caches Command Tests', () => {
    teardown(() => {
        sinon.restore();
    });

    test('generic clear preserves inline association persistence while clearing other state and managers', async () => {
        const inlineAssociations = { 'C:\\workspace\\script.py': 'C:\\cache\\python.exe' };
        const workspaceState = new Map<string, unknown>([
            [INLINE_SCRIPT_ENVS_KEY, inlineAssociations],
            ['other-workspace-state', { stale: true }],
        ]);
        const calls: string[] = [];
        sinon.stub(persistentState, 'clearPersistentState').callsFake(async (options) => {
            calls.push('persistent');
            const preserved = new Set(options?.preserveWorkspaceKeys ?? []);
            for (const key of workspaceState.keys()) {
                if (!preserved.has(key)) {
                    workspaceState.delete(key);
                }
            }
        });
        const envManagers = {
            clearCache: sinon.stub().callsFake(async () => {
                calls.push('managers');
                assert.deepStrictEqual(workspaceState.get(INLINE_SCRIPT_ENVS_KEY), inlineAssociations);
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

        await clearEnvironmentCachesCommand(envManagers, [startupProvider]);

        assert.deepStrictEqual(calls, ['persistent', 'managers', 'shells']);
        assert.deepStrictEqual(workspaceState.get(INLINE_SCRIPT_ENVS_KEY), inlineAssociations);
        assert.strictEqual(workspaceState.has('other-workspace-state'), false);
        sinon.assert.calledOnceWithExactly(envManagers.clearCache as sinon.SinonStub, undefined);
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
