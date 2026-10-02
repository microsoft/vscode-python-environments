// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Regression tests for selection of an environment for the default (non-workspace) context —
 * the rootless context shared by ordinary loose files opened without a workspace/folder.
 *
 * See https://github.com/microsoft/vscode-python-environments/issues/1522: selecting a
 * different environment for a standalone file did not stick because subsequent reads were
 * routed back to the configured default manager, and loose-file URI selection silently
 * resolved to an empty project list.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as typeMoq from 'typemoq';
import { EventEmitter, Extension, Uri } from 'vscode';
import {
    DidChangeEnvironmentEventArgs,
    DidChangeEnvironmentsEventArgs,
    EnvironmentManager,
    GetEnvironmentScope,
    PythonEnvironment,
    PythonProject,
} from '../../api';
import * as extensionApis from '../../common/extension.apis';
import * as defaultEnvironmentState from '../../features/defaultEnvironmentState';
import { PythonEnvironmentManagers } from '../../features/envManagers';
import * as settingHelpers from '../../features/settings/settingHelpers';
import type { PythonProjectManager } from '../../features/projectManager';
import { setupNonThenable } from '../mocks/helper';

suite('Default (non-workspace) environment selection', () => {
    let envManagers: PythonEnvironmentManagers;
    let projectManager: typeMoq.IMock<PythonProjectManager>;
    let projectsByUri: Map<string, PythonProject>;
    let configuredManagerId: string;
    let setAllManagerSettings: sinon.SinonStub;
    let saveSelection: sinon.SinonStub;
    let loadSelection: sinon.SinonStub;

    /** Per-manager environment currently reported by manager.get(). */
    const managerSelections = new Map<string, PythonEnvironment | undefined>();

    function makeEnv(id: string, managerId: string): PythonEnvironment {
        return {
            envId: { id, managerId },
            name: id,
            displayName: id,
            displayPath: `/envs/${id}`,
            version: '3.12.0',
            environmentPath: Uri.file(`/envs/${id}`),
            execInfo: { run: { executable: `/envs/${id}/bin/python`, args: [] } },
            sysPrefix: `/envs/${id}`,
        } as PythonEnvironment;
    }

    /**
     * Registers a manager whose get()/set() operate on a per-scope map, mimicking a real
     * manager that owns its own selection state.
     */
    function registerManager(name: string): { id: string; set: sinon.SinonStub } {
        const onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
        const onDidChangeEnvironments = new EventEmitter<DidChangeEnvironmentsEventArgs>();
        const scopeKey = (scope: GetEnvironmentScope): string =>
            scope instanceof Uri ? scope.toString() : 'global';
        const selections = new Map<string, PythonEnvironment | undefined>();
        const set = sinon.stub().callsFake(async (scope: unknown, environment?: PythonEnvironment) => {
            const scopes = Array.isArray(scope) ? scope : [scope];
            scopes.forEach((s) => selections.set(scopeKey(s as GetEnvironmentScope), environment));
            managerSelections.set(name, environment);
        });
        const manager = {
            name,
            displayName: name,
            preferredPackageManagerId: 'ms-python.python:pip',
            onDidChangeEnvironment: onDidChangeEnvironment.event,
            onDidChangeEnvironments: onDidChangeEnvironments.event,
            get: async (scope: GetEnvironmentScope) =>
                selections.get(scopeKey(scope)) ?? managerSelections.get(name),
            getEnvironments: async () => [],
            set,
            resolve: async (uri: Uri) => makeEnv(uri.fsPath, `ms-python.python:${name}`),
            refresh: async () => undefined,
        } as unknown as EnvironmentManager;

        const index = envManagers.managers.length;
        envManagers.registerEnvironmentManager(manager);
        return { id: envManagers.managers[index].id, set };
    }

    setup(() => {
        managerSelections.clear();
        const mockPythonExtension = { id: 'ms-python.python', extensionPath: '/mock/python/extension' };
        const getExtensionStub = sinon.stub(extensionApis, 'getExtension');
        getExtensionStub.withArgs('ms-python.python').returns(mockPythonExtension as Extension<unknown>);
        sinon.stub(extensionApis, 'allExtensions').returns([mockPythonExtension] as Extension<unknown>[]);

        projectManager = typeMoq.Mock.ofType<PythonProjectManager>();
        setupNonThenable(projectManager);
        projectsByUri = new Map();
        projectManager.setup((pm) => pm.get(typeMoq.It.isAny())).returns((uri) => projectsByUri.get(uri.toString()));
        projectManager.setup((pm) => pm.getProjects()).returns(() => Array.from(projectsByUri.values()));

        envManagers = new PythonEnvironmentManagers(projectManager.object);
        configuredManagerId = 'ms-python.python:venv';
        sinon.stub(settingHelpers, 'getDefaultEnvManagerSetting').callsFake(() => configuredManagerId);
        sinon.stub(settingHelpers, 'getProjectEnvironmentManagerSetting').callsFake(() => undefined);
        setAllManagerSettings = sinon.stub(settingHelpers, 'setAllManagerSettings').resolves();
        saveSelection = sinon.stub(defaultEnvironmentState, 'saveDefaultEnvironmentSelection').resolves(true);
        loadSelection = sinon.stub(defaultEnvironmentState, 'loadDefaultEnvironmentSelection').resolves(undefined);
    });

    teardown(() => {
        sinon.restore();
        envManagers.dispose();
    });

    test('a cross-manager selection made without a context sticks across reads', async () => {
        const venv = registerManager('venv');
        const conda = registerManager('conda');
        configuredManagerId = venv.id;
        const condaEnv = makeEnv('conda-env', conda.id);

        await envManagers.setEnvironment(undefined, condaEnv);

        assert.strictEqual(envManagers.getEnvironmentManager(undefined)?.id, conda.id);
        assert.strictEqual((await envManagers.getEnvironment(undefined))?.envId.id, 'conda-env');
        assert.strictEqual(envManagers.getLastKnownEnvironment(undefined)?.envId.id, 'conda-env');
    });

    test('system -> conda -> venv selections each stick', async () => {
        const system = registerManager('system');
        const conda = registerManager('conda');
        const venv = registerManager('venv');
        configuredManagerId = venv.id;

        for (const [manager, id] of [
            [system, 'system-env'],
            [conda, 'conda-env'],
            [venv, 'venv-env'],
        ] as const) {
            await envManagers.setEnvironment(undefined, makeEnv(id, manager.id));
            assert.strictEqual(envManagers.getEnvironmentManager(undefined)?.id, manager.id);
            assert.strictEqual((await envManagers.getEnvironment(undefined))?.envId.id, id);
        }
    });

    test('selection through a loose-file URI is applied to the default context', async () => {
        const venv = registerManager('venv');
        const conda = registerManager('conda');
        configuredManagerId = venv.id;
        const looseFile = Uri.file('/tmp/loose/example.py');
        const condaEnv = makeEnv('conda-env', conda.id);

        await envManagers.setEnvironment(looseFile, condaEnv);

        // The manager is asked to set the default scope, not a fabricated project scope.
        sinon.assert.calledWith(conda.set, undefined, condaEnv);
        assert.strictEqual((await envManagers.getEnvironment(looseFile))?.envId.id, 'conda-env');
        assert.strictEqual((await envManagers.getEnvironment(undefined))?.envId.id, 'conda-env');
        assert.strictEqual(envManagers.getEnvironmentManager(looseFile)?.id, conda.id);
        assert.strictEqual(envManagers.getLastKnownEnvironment(looseFile)?.envId.id, 'conda-env');
    });

    test('a loose-file URI array selection is not an empty-project no-op', async () => {
        const venv = registerManager('venv');
        const conda = registerManager('conda');
        configuredManagerId = venv.id;
        const condaEnv = makeEnv('conda-env', conda.id);

        await envManagers.setEnvironments([Uri.file('/tmp/loose/example.py')], condaEnv);

        sinon.assert.calledWith(conda.set, undefined, condaEnv);
        assert.strictEqual((await envManagers.getEnvironment(undefined))?.envId.id, 'conda-env');
    });

    test('two ordinary loose files share the default selection', async () => {
        const venv = registerManager('venv');
        const conda = registerManager('conda');
        configuredManagerId = venv.id;
        const first = Uri.file('/tmp/loose/first.py');
        const second = Uri.file('/tmp/loose/second.py');

        await envManagers.setEnvironment(first, makeEnv('conda-env', conda.id));

        assert.strictEqual((await envManagers.getEnvironment(second))?.envId.id, 'conda-env');
        assert.strictEqual(envManagers.resolveContext(second).kind, 'default');
    });

    test('a real project keeps its own selection when the default context changes', async () => {
        const venv = registerManager('venv');
        const conda = registerManager('conda');
        configuredManagerId = venv.id;
        const projectUri = Uri.file('/workspace/project');
        projectsByUri.set(projectUri.toString(), { name: 'project', uri: projectUri });

        await envManagers.setEnvironment(projectUri, makeEnv('project-env', venv.id));
        await envManagers.setEnvironment(undefined, makeEnv('conda-env', conda.id));

        assert.strictEqual(envManagers.getLastKnownEnvironment(projectUri)?.envId.id, 'project-env');
        assert.strictEqual(envManagers.resolveContext(projectUri).kind, 'project');
        assert.strictEqual(envManagers.getLastKnownEnvironment(undefined)?.envId.id, 'conda-env');
    });

    test('default selection writes no settings and creates no project', async () => {
        const conda = registerManager('conda');

        await envManagers.setEnvironment(Uri.file('/tmp/loose/example.py'), makeEnv('conda-env', conda.id));

        assert.strictEqual(setAllManagerSettings.callCount, 0);
        projectManager.verify((pm) => pm.add(typeMoq.It.isAny(), typeMoq.It.isAny()), typeMoq.Times.never());
        assert.strictEqual(envManagers.resolveContext(undefined).kind, 'default');
    });

    test('the default change event carries an undefined uri', async () => {
        const conda = registerManager('conda');
        const events: DidChangeEnvironmentEventArgs[] = [];
        envManagers.onDidChangeActiveEnvironment((e) => events.push(e));

        await envManagers.setEnvironment(Uri.file('/tmp/loose/example.py'), makeEnv('conda-env', conda.id));
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].uri, undefined);
        assert.strictEqual(events[0].new?.envId.id, 'conda-env');
    });

    test('a delayed automatic startup selection does not undo a manual selection', async () => {
        const venv = registerManager('venv');
        const conda = registerManager('conda');
        configuredManagerId = venv.id;

        await envManagers.setEnvironment(undefined, makeEnv('conda-env', conda.id));
        // Startup/auto-discovery commits are never persisted to settings and must not win.
        await envManagers.setEnvironments('global', makeEnv('venv-env', venv.id), false);

        assert.strictEqual(envManagers.getEnvironmentManager(undefined)?.id, conda.id);
        assert.strictEqual((await envManagers.getEnvironment(undefined))?.envId.id, 'conda-env');
        sinon.assert.neverCalledWith(venv.set, undefined, sinon.match.has('envId', sinon.match.has('id', 'venv-env')));
    });

    test('rapid A -> B -> C selections settle on the last request', async () => {
        const a = registerManager('a');
        const b = registerManager('b');
        const c = registerManager('c');

        await Promise.all([
            envManagers.setEnvironment(undefined, makeEnv('a-env', a.id)),
            envManagers.setEnvironment(undefined, makeEnv('b-env', b.id)),
            envManagers.setEnvironment(undefined, makeEnv('c-env', c.id)),
        ]);

        assert.strictEqual(envManagers.getEnvironmentManager(undefined)?.id, c.id);
        assert.strictEqual((await envManagers.getEnvironment(undefined))?.envId.id, 'c-env');
    });

    test('a failed manager application neither publishes nor persists a selection', async () => {
        const venv = registerManager('venv');
        const conda = registerManager('conda');
        configuredManagerId = venv.id;
        conda.set.rejects(new Error('cannot select'));
        const events: DidChangeEnvironmentEventArgs[] = [];
        envManagers.onDidChangeActiveEnvironment((e) => events.push(e));

        await assert.rejects(envManagers.setEnvironment(undefined, makeEnv('conda-env', conda.id)), /cannot select/);
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(events.length, 0);
        assert.strictEqual(saveSelection.callCount, 0);
        assert.strictEqual(envManagers.getEnvironmentManager(undefined)?.id, venv.id);
    });

    test('clearing the default selection removes the override and recomputes the fallback', async () => {
        const venv = registerManager('venv');
        const conda = registerManager('conda');
        configuredManagerId = venv.id;
        const fallback = makeEnv('venv-env', venv.id);
        managerSelections.set('venv', fallback);

        await envManagers.setEnvironment(undefined, makeEnv('conda-env', conda.id));
        await envManagers.setEnvironment(undefined, undefined);

        assert.strictEqual(envManagers.getEnvironmentManager(undefined)?.id, venv.id);
        assert.strictEqual((await envManagers.getEnvironment(undefined))?.envId.id, 'venv-env');
        sinon.assert.calledWith(saveSelection.lastCall, undefined);
    });

    test('persists the manager id and environment path for the default selection', async () => {
        const conda = registerManager('conda');
        const condaEnv = makeEnv('conda-env', conda.id);

        await envManagers.setEnvironment(undefined, condaEnv);

        sinon.assert.calledWithMatch(saveSelection, {
            managerId: conda.id,
            environmentPath: condaEnv.environmentPath,
            environmentId: 'conda-env',
        });
    });

    test('restores the persisted manager and environment before any automatic fallback', async () => {
        const venv = registerManager('venv');
        const conda = registerManager('conda');
        configuredManagerId = venv.id;
        loadSelection.resolves({
            version: 1,
            managerId: conda.id,
            environmentPath: Uri.file('/envs/conda-env').toString(),
            environmentId: 'conda-env',
        });

        assert.strictEqual(await envManagers.restoreDefaultEnvironmentSelection(), true);

        assert.strictEqual(envManagers.getEnvironmentManager(undefined)?.id, conda.id);
        assert.ok((await envManagers.getEnvironment(undefined))?.envId.managerId.endsWith('conda'));
        // A late automatic selection cannot undo the restored choice.
        await envManagers.setEnvironments('global', makeEnv('venv-env', venv.id), false);
        assert.strictEqual(envManagers.getEnvironmentManager(undefined)?.id, conda.id);
    });

    test('ignores corrupted persisted state', async () => {
        const venv = registerManager('venv');
        configuredManagerId = venv.id;
        loadSelection.resolves(undefined);

        assert.strictEqual(await envManagers.restoreDefaultEnvironmentSelection(), false);
        assert.strictEqual(envManagers.getEnvironmentManager(undefined)?.id, venv.id);
    });

    test('keeps persisted state when the owning manager is not registered', async () => {
        const venv = registerManager('venv');
        configuredManagerId = venv.id;
        loadSelection.resolves({
            version: 1,
            managerId: 'third-party:manager',
            environmentPath: Uri.file('/envs/other').toString(),
        });

        assert.strictEqual(await envManagers.restoreDefaultEnvironmentSelection(), false);
        assert.strictEqual(envManagers.getEnvironmentManager(undefined)?.id, venv.id);
        // The stored selection must survive a temporarily unregistered manager.
        assert.strictEqual(saveSelection.callCount, 0);
    });

    test('clears persisted state when the environment no longer resolves', async () => {
        const venv = registerManager('venv');
        const conda = registerManager('conda');
        configuredManagerId = venv.id;
        sinon.stub(envManagers.managers[1], 'resolve').resolves(undefined);
        loadSelection.resolves({
            version: 1,
            managerId: conda.id,
            environmentPath: Uri.file('/envs/removed').toString(),
        });

        assert.strictEqual(await envManagers.restoreDefaultEnvironmentSelection(), false);
        sinon.assert.calledWith(saveSelection, undefined);
        assert.strictEqual(envManagers.getEnvironmentManager(undefined)?.id, venv.id);
    });

    test('a newer explicit selection is never replaced by a restore', async () => {
        const venv = registerManager('venv');
        const conda = registerManager('conda');
        configuredManagerId = venv.id;
        loadSelection.resolves({
            version: 1,
            managerId: venv.id,
            environmentPath: Uri.file('/envs/venv-env').toString(),
        });

        await envManagers.setEnvironment(undefined, makeEnv('conda-env', conda.id));
        assert.strictEqual(await envManagers.restoreDefaultEnvironmentSelection(), true);

        assert.strictEqual(envManagers.getEnvironmentManager(undefined)?.id, conda.id);
        assert.strictEqual((await envManagers.getEnvironment(undefined))?.envId.id, 'conda-env');
    });

    test('an unrelated configured-manager change does not reset an explicit selection', async () => {
        const venv = registerManager('venv');
        const conda = registerManager('conda');
        const system = registerManager('system');
        configuredManagerId = venv.id;

        await envManagers.setEnvironment(undefined, makeEnv('conda-env', conda.id));
        configuredManagerId = system.id;

        assert.strictEqual(envManagers.getEnvironmentManager(undefined)?.id, conda.id);
        assert.strictEqual((await envManagers.getEnvironment(undefined))?.envId.id, 'conda-env');
    });

    test('a refresh cannot undo the explicit default selection', async () => {
        const venv = registerManager('venv');
        const conda = registerManager('conda');
        configuredManagerId = venv.id;
        managerSelections.set('venv', makeEnv('venv-env', venv.id));

        await envManagers.setEnvironment(undefined, makeEnv('conda-env', conda.id));
        await envManagers.refreshEnvironment(Uri.file('/tmp/loose/example.py'));

        assert.strictEqual(envManagers.getLastKnownEnvironment(undefined)?.envId.id, 'conda-env');
    });
});
