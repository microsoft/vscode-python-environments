// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import { DidChangeEnvironmentEventArgs, PythonEnvironment, PythonProject } from '../../api';
import * as frameUtils from '../../common/utils/frameUtils';
import * as workspaceApis from '../../common/workspace.apis';
import { PythonEnvironmentManagers } from '../../features/envManagers';
import type { PythonProjectManager } from '../../features/projectManager';

suite('PythonEnvironmentManagers - getEnvironment', () => {
    let sandbox: sinon.SinonSandbox;
    let envManagers: PythonEnvironmentManagers;
    let mockProjectManager: sinon.SinonStubbedInstance<PythonProjectManager>;

    const env311: PythonEnvironment = {
        envId: { id: 'system-311', managerId: 'ms-python.python:system' },
        name: 'Python 3.11',
        displayName: 'Python 3.11.15',
        version: '3.11.15',
        displayPath: '/usr/bin/python3.11',
        environmentPath: Uri.file('/usr/bin/python3.11'),
        sysPrefix: '/usr',
        execInfo: { run: { executable: '/usr/bin/python3.11' } },
    };

    const env314: PythonEnvironment = {
        envId: { id: 'system-314', managerId: 'ms-python.python:system' },
        name: 'Python 3.14',
        displayName: 'Python 3.14.4',
        version: '3.14.4',
        displayPath: '/usr/bin/python3.14',
        environmentPath: Uri.file('/usr/bin/python3.14'),
        sysPrefix: '/usr',
        execInfo: { run: { executable: '/usr/bin/python3.14' } },
    };

    setup(() => {
        sandbox = sinon.createSandbox();

        // Stub getCallingExtension to avoid stack-frame analysis issues in tests
        sandbox.stub(frameUtils, 'getCallingExtension').returns('ms-python.python');

        // Stub getConfiguration to return a minimal config that returns the system manager
        sandbox.stub(workspaceApis, 'getConfiguration').returns({
            get: (key: string, defaultValue?: unknown) => {
                if (key === 'defaultEnvManager') {
                    return 'ms-python.python:system';
                }
                if (key === 'pythonProjects') {
                    return [];
                }
                return defaultValue;
            },
            has: () => false,
            inspect: () => undefined,
            update: () => Promise.resolve(),
        } as any);

        mockProjectManager = {
            getProjects: sandbox.stub().returns([]),
            get: sandbox.stub().returns(undefined),
        } as unknown as sinon.SinonStubbedInstance<PythonProjectManager>;

        envManagers = new PythonEnvironmentManagers(mockProjectManager as unknown as PythonProjectManager);
    });

    teardown(() => {
        sandbox.restore();
    });

    /**
     * Registers a fake environment manager that returns predefined environments.
     */
    function registerFakeManager(managerId: string, getStub: sinon.SinonStub): void {
        const fakeManager = {
            name: managerId.split(':')[1],
            displayName: managerId,
            preferredPackageManagerId: 'ms-python.python:pip',
            get: getStub,
            set: sandbox.stub().resolves(),
            resolve: sandbox.stub().resolves(undefined),
            refresh: sandbox.stub().resolves(),
            getEnvironments: sandbox.stub().resolves([]),
            onDidChangeEnvironments: sandbox.stub().returns({ dispose: () => {} }),
            onDidChangeEnvironment: sandbox.stub().returns({ dispose: () => {} }),
        };
        envManagers.registerEnvironmentManager(fakeManager as any, { extensionId: 'ms-python.python' });
    }

    test('should NOT update cache when manager.get() returns a different env than what was set', async () => {
        // Register a system manager whose get() returns env314 (the "latest")
        const getStub = sandbox.stub().resolves(env314);
        registerFakeManager('ms-python.python:system', getStub);

        // Simulate that initial selection set env311 via setEnvironment
        await envManagers.setEnvironment(undefined, env311, false);
        // Allow the setEnvironment change event to flush
        await new Promise((resolve) => setImmediate(resolve));

        // Now subscribe to change events AFTER the initial selection
        const changeEvents: any[] = [];
        envManagers.onDidChangeActiveEnvironment((e) => changeEvents.push(e));

        // Now getEnvironment() calls manager.get() which returns env314
        // but this should NOT update the cache or fire a change event
        const result = await envManagers.getEnvironment(undefined);

        // getEnvironment returns what the manager reports (env314)
        assert.strictEqual(result?.envId.id, 'system-314', 'Should return the manager result');

        // But the internal cache should NOT have been updated
        // (We verify by checking no change event was fired)
        // Allow setImmediate callbacks to run
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(changeEvents.length, 0, 'Should NOT fire onDidChangeActiveEnvironment');
    });

    test('should NOT fire change events on read', async () => {
        const getStub = sandbox.stub().resolves(env311);
        registerFakeManager('ms-python.python:system', getStub);

        const changeEvents: any[] = [];
        envManagers.onDidChangeActiveEnvironment((e) => changeEvents.push(e));

        // Call getEnvironment multiple times
        await envManagers.getEnvironment(undefined);
        await envManagers.getEnvironment(undefined);
        await envManagers.getEnvironment(undefined);

        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(changeEvents.length, 0, 'Pure read should never fire change events');
    });

    test('should still return the correct env from manager.get()', async () => {
        const getStub = sandbox.stub().resolves(env311);
        registerFakeManager('ms-python.python:system', getStub);

        const result = await envManagers.getEnvironment(undefined);
        assert.strictEqual(result?.envId.id, 'system-311');
        assert.ok(getStub.calledOnce, 'Should delegate to manager.get()');
    });

    test('should return undefined when no managers are registered', async () => {
        // No managers registered at all — size === 0 guard fires
        const result = await envManagers.getEnvironment(Uri.file('/some/unknown/path'));
        assert.strictEqual(result, undefined);
    });

    test('should return undefined when settings point to an unregistered manager', async () => {
        // Register a 'conda' manager, but the config stub returns 'ms-python.python:system'
        // as the defaultEnvManager. getEnvironmentManager will look up 'ms-python.python:system'
        // in the map, find nothing, check the cache (empty), and return undefined.
        // This exercises the fallback path in getEnvironmentManager beyond the size === 0 guard.
        const getStub = sandbox.stub().resolves(env311);
        registerFakeManager('ms-python.python:conda', getStub);

        const result = await envManagers.getEnvironment(Uri.file('/some/unrelated/path'));
        assert.strictEqual(
            result,
            undefined,
            'Should return undefined when settings point to an unregistered manager and cache is empty',
        );
    });

    test('setEnvironment should still fire change events and update cache', async () => {
        const getStub = sandbox.stub().resolves(env311);
        registerFakeManager('ms-python.python:system', getStub);

        const changeEvents: any[] = [];
        envManagers.onDidChangeActiveEnvironment((e) => changeEvents.push(e));

        // setEnvironment SHOULD update cache and fire event
        await envManagers.setEnvironment(undefined, env311, false);

        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(changeEvents.length, 1, 'setEnvironment should fire change event');
        assert.strictEqual(changeEvents[0].new?.envId.id, 'system-311');
    });

    test('subsequent getEnvironment does not overwrite setEnvironment selection', async () => {
        // This is the core issue #1492 scenario:
        // 1. setEnvironment selects env311 (from defaultInterpreterPath)
        // 2. telemetry calls getEnvironment which triggers manager.get() returning env314
        // 3. The selection should NOT flip to env314

        const getStub = sandbox.stub().resolves(env314);
        registerFakeManager('ms-python.python:system', getStub);

        // Step 1: Initial selection picks env311
        await envManagers.setEnvironment(undefined, env311, false);
        // Allow the setEnvironment change event to flush
        await new Promise((resolve) => setImmediate(resolve));

        // Subscribe AFTER initial selection
        const changeEvents: any[] = [];
        envManagers.onDidChangeActiveEnvironment((e) => changeEvents.push(e));

        // Step 2: Telemetry calls getEnvironment (which internally calls manager.get() → env314)
        const result = await envManagers.getEnvironment(undefined);

        // It can return env314 (that's what the manager reports), but it must NOT fire a change event
        assert.strictEqual(result?.envId.id, 'system-314');

        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(
            changeEvents.length,
            0,
            'getEnvironment must not fire change events, preserving the initial selection',
        );
    });
});

suite('PythonEnvironmentManagers - refreshEnvironment', () => {
    let sandbox: sinon.SinonSandbox;
    let envManagers: PythonEnvironmentManagers;
    let mockProjectManager: sinon.SinonStubbedInstance<PythonProjectManager>;

    const env311: PythonEnvironment = {
        envId: { id: 'system-311', managerId: 'ms-python.python:system' },
        name: 'Python 3.11',
        displayName: 'Python 3.11.15',
        version: '3.11.15',
        displayPath: '/usr/bin/python3.11',
        environmentPath: Uri.file('/usr/bin/python3.11'),
        sysPrefix: '/usr',
        execInfo: { run: { executable: '/usr/bin/python3.11' } },
    };

    const env314: PythonEnvironment = {
        envId: { id: 'system-314', managerId: 'ms-python.python:system' },
        name: 'Python 3.14',
        displayName: 'Python 3.14.4',
        version: '3.14.4',
        displayPath: '/usr/bin/python3.14',
        environmentPath: Uri.file('/usr/bin/python3.14'),
        sysPrefix: '/usr',
        execInfo: { run: { executable: '/usr/bin/python3.14' } },
    };

    setup(() => {
        sandbox = sinon.createSandbox();
        sandbox.stub(frameUtils, 'getCallingExtension').returns('ms-python.python');
        sandbox.stub(workspaceApis, 'getConfiguration').returns({
            get: (key: string, defaultValue?: unknown) => {
                if (key === 'defaultEnvManager') {
                    return 'ms-python.python:system';
                }
                if (key === 'pythonProjects') {
                    return [];
                }
                return defaultValue;
            },
            has: () => false,
            inspect: () => undefined,
            update: () => Promise.resolve(),
        } as any);

        mockProjectManager = {
            getProjects: sandbox.stub().returns([]),
            get: sandbox.stub().returns(undefined),
        } as unknown as sinon.SinonStubbedInstance<PythonProjectManager>;

        envManagers = new PythonEnvironmentManagers(mockProjectManager as unknown as PythonProjectManager);
    });

    teardown(() => {
        sandbox.restore();
    });

    function registerFakeManager(managerId: string, getStub: sinon.SinonStub): void {
        const fakeManager = {
            name: managerId.split(':')[1],
            displayName: managerId,
            preferredPackageManagerId: 'ms-python.python:pip',
            get: getStub,
            set: sandbox.stub().resolves(),
            resolve: sandbox.stub().resolves(undefined),
            refresh: sandbox.stub().resolves(),
            getEnvironments: sandbox.stub().resolves([]),
            onDidChangeEnvironments: sandbox.stub().returns({ dispose: () => {} }),
            onDidChangeEnvironment: sandbox.stub().returns({ dispose: () => {} }),
        };
        envManagers.registerEnvironmentManager(fakeManager as any, { extensionId: 'ms-python.python' });
    }

    test('should fire change event when manager reports a new environment', async () => {
        const getStub = sandbox.stub().resolves(env314);
        registerFakeManager('ms-python.python:system', getStub);

        // Set initial env
        await envManagers.setEnvironment(undefined, env311, false);
        await new Promise((resolve) => setImmediate(resolve));

        const changeEvents: any[] = [];
        envManagers.onDidChangeActiveEnvironment((e) => changeEvents.push(e));

        // refreshEnvironment should detect the difference and fire
        await envManagers.refreshEnvironment(undefined);
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(changeEvents.length, 1, 'refreshEnvironment should fire change event');
        assert.strictEqual(changeEvents[0].old?.envId.id, 'system-311');
        assert.strictEqual(changeEvents[0].new?.envId.id, 'system-314');

        // Verify the cache was updated: a second refresh with the same env must NOT fire again
        await envManagers.refreshEnvironment(undefined);
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(changeEvents.length, 1, 'Second refresh with same env should NOT fire a second event');
    });

    test('should NOT fire change event when manager reports same environment', async () => {
        const getStub = sandbox.stub().resolves(env311);
        registerFakeManager('ms-python.python:system', getStub);

        // Set initial env to env311
        await envManagers.setEnvironment(undefined, env311, false);
        await new Promise((resolve) => setImmediate(resolve));

        const changeEvents: any[] = [];
        envManagers.onDidChangeActiveEnvironment((e) => changeEvents.push(e));

        // refreshEnvironment sees no difference
        await envManagers.refreshEnvironment(undefined);
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(changeEvents.length, 0, 'No change means no event');
    });

    test('should do nothing when no manager found for scope', async () => {
        // No manager registered — should not throw
        await envManagers.refreshEnvironment(Uri.file('/unknown/path'));
    });
});

suite('PythonEnvironmentManagers - clearCache', () => {
    let sandbox: sinon.SinonSandbox;
    let envManagers: PythonEnvironmentManagers;

    setup(() => {
        sandbox = sinon.createSandbox();
        sandbox.stub(frameUtils, 'getCallingExtension').returns('ms-python.python');
        envManagers = new PythonEnvironmentManagers({
            get: sandbox.stub().returns(undefined),
            getProjects: sandbox.stub().returns([]),
        } as unknown as PythonProjectManager);
    });

    teardown(() => {
        sandbox.restore();
    });

    function registerManager(name: string, clearCache: sinon.SinonStub): void {
        envManagers.registerEnvironmentManager(
            {
                name,
                displayName: name,
                preferredPackageManagerId: 'ms-python.python:pip',
                get: sandbox.stub().resolves(undefined),
                set: sandbox.stub().resolves(),
                resolve: sandbox.stub().resolves(undefined),
                refresh: sandbox.stub().resolves(),
                getEnvironments: sandbox.stub().resolves([]),
                clearCache,
                onDidChangeEnvironments: sandbox.stub().returns({ dispose: () => {} }),
                onDidChangeEnvironment: sandbox.stub().returns({ dispose: () => {} }),
            } as any,
            { extensionId: 'ms-python.python' },
        );
    }

    test('clears every existing manager when the inline preview manager is absent', async () => {
        const systemClearCache = sandbox.stub().resolves();
        registerManager('system', systemClearCache);

        await envManagers.clearCache(undefined);

        sinon.assert.calledOnce(systemClearCache);
    });

    test('does not clear the preview inline manager through the generic command path', async () => {
        const systemClearCache = sandbox.stub().resolves();
        const inlineClearCache = sandbox.stub().resolves();
        registerManager('system', systemClearCache);
        registerManager('inline-script', inlineClearCache);

        await envManagers.clearCache(undefined);

        sinon.assert.calledOnce(systemClearCache);
        sinon.assert.notCalled(inlineClearCache);
    });
});

suite('PythonEnvironmentManagers - selection stored by a non-default manager', () => {
    const VENV_MANAGER = 'ms-python.python:venv';
    const SYSTEM_MANAGER = 'ms-python.python:system';
    const projectUri = Uri.file(path.resolve('selection-project'));
    const fileUri = Uri.joinPath(projectUri, 'main.py');
    const outsideUri = Uri.file(path.resolve('outside', 'script.py'));
    const project: PythonProject = { name: 'selection-project', uri: projectUri };

    let sandbox: sinon.SinonSandbox;
    let envManagers: PythonEnvironmentManagers;
    let venvGet: sinon.SinonStub;
    let systemGet: sinon.SinonStub;
    let systemSelections: Map<string, PythonEnvironment | undefined>;

    function makeEnv(id: string, managerId: string, version: string): PythonEnvironment {
        const envPath = path.resolve(id, 'python');
        return {
            envId: { id, managerId },
            name: id,
            displayName: `Python ${version}`,
            version,
            displayPath: envPath,
            environmentPath: Uri.file(envPath),
            sysPrefix: path.resolve(id),
            execInfo: { run: { executable: envPath } },
        };
    }

    // The interpreter configured in python.defaultInterpreterPath (a global, so owned by the system manager).
    const configured = makeEnv('system-312', SYSTEM_MANAGER, '3.12.14');
    // The venv manager's fallback when a scope has no venv: the newest global Python.
    const newestGlobal = makeEnv('system-314', SYSTEM_MANAGER, '3.14.8');
    const localVenv = makeEnv('venv-313', VENV_MANAGER, '3.13.15');

    function selectionKey(scope: Uri | undefined): string {
        return scope && scope.fsPath.startsWith(projectUri.fsPath) ? projectUri.fsPath : 'global';
    }

    function registerManager(name: string, get: sinon.SinonStub, set: sinon.SinonStub): void {
        envManagers.registerEnvironmentManager(
            {
                name,
                displayName: name,
                preferredPackageManagerId: 'ms-python.python:pip',
                get,
                set,
                resolve: sandbox.stub().resolves(undefined),
                refresh: sandbox.stub().resolves(),
                getEnvironments: sandbox.stub().resolves([]),
                onDidChangeEnvironments: sandbox.stub().returns({ dispose: () => {} }),
                onDidChangeEnvironment: sandbox.stub().returns({ dispose: () => {} }),
            } as any,
            { extensionId: 'ms-python.python' },
        );
    }

    async function flush(): Promise<void> {
        await new Promise((resolve) => setImmediate(resolve));
    }

    setup(() => {
        sandbox = sinon.createSandbox();
        sandbox.stub(frameUtils, 'getCallingExtension').returns('ms-python.python');
        // No explicit python-envs settings: routing uses the package default manager (venv).
        sandbox.stub(workspaceApis, 'getConfiguration').returns({
            get: (key: string, defaultValue?: unknown) => {
                if (key === 'defaultEnvManager') {
                    return VENV_MANAGER;
                }
                if (key === 'pythonProjects') {
                    return [];
                }
                return defaultValue;
            },
            has: () => false,
            inspect: () => undefined,
            update: () => Promise.resolve(),
        } as any);

        envManagers = new PythonEnvironmentManagers({
            getProjects: sandbox.stub().returns([project]),
            get: (uri: Uri) => (selectionKey(uri) === 'global' ? undefined : project),
        } as unknown as PythonProjectManager);

        venvGet = sandbox.stub().resolves(newestGlobal);
        registerManager('venv', venvGet, sandbox.stub().resolves());

        systemSelections = new Map();
        systemGet = sandbox
            .stub()
            .callsFake(async (scope: Uri | undefined) => systemSelections.get(selectionKey(scope)));
        const systemSet = sandbox.stub().callsFake(async (scope: Uri | undefined, env?: PythonEnvironment) => {
            systemSelections.set(selectionKey(scope), env);
        });
        registerManager('system', systemGet, systemSet);
    });

    teardown(() => {
        sandbox.restore();
        envManagers.dispose();
    });

    test('a project without a venv uses an explicit selection stored by the system manager', async () => {
        await envManagers.setEnvironment(projectUri, configured, false, { explicit: true });

        assert.strictEqual(envManagers.getEnvironmentManager(fileUri)?.id, VENV_MANAGER);
        assert.strictEqual((await envManagers.getEnvironment(fileUri))?.envId.id, configured.envId.id);
        assert.strictEqual((await envManagers.getEnvironment(projectUri))?.envId.id, configured.envId.id);
    });

    test('files outside a project use an explicit global selection stored by the system manager', async () => {
        await envManagers.setEnvironments('global', configured, false, { explicit: true });

        assert.strictEqual((await envManagers.getEnvironment(outsideUri))?.envId.id, configured.envId.id);
        assert.strictEqual((await envManagers.getEnvironment(undefined))?.envId.id, configured.envId.id);
    });

    test('a user selection stored by the system manager is explicit by default', async () => {
        await envManagers.setEnvironments('global', configured);

        assert.strictEqual((await envManagers.getEnvironment(outsideUri))?.envId.id, configured.envId.id);
    });

    test('a venv owned by the default manager still wins over an explicit selection from another manager', async () => {
        venvGet.resolves(localVenv);
        await envManagers.setEnvironment(projectUri, configured, false, { explicit: true });

        assert.strictEqual((await envManagers.getEnvironment(fileUri))?.envId.id, localVenv.envId.id);
    });

    test('the default manager fallback is returned when no explicit selection exists', async () => {
        assert.strictEqual((await envManagers.getEnvironment(fileUri))?.envId.id, newestGlobal.envId.id);
        sinon.assert.notCalled(systemGet);
    });

    test('an auto-discovered selection does not replace the default manager fallback', async () => {
        await envManagers.setEnvironment(projectUri, configured, false);

        assert.strictEqual((await envManagers.getEnvironment(fileUri))?.envId.id, newestGlobal.envId.id);
    });

    test('a later auto-discovered selection clears an explicit one even if the system manager kept it', async () => {
        // python.defaultInterpreterPath applied, then removed: the system manager still stores the old
        // interpreter, and global auto-discovery reads it back from there.
        await envManagers.setEnvironments('global', configured, false, { explicit: true });
        await envManagers.setEnvironments('global', configured, false);

        assert.strictEqual((await envManagers.getEnvironment(outsideUri))?.envId.id, newestGlobal.envId.id);
        assert.strictEqual((await envManagers.getEnvironment(undefined))?.envId.id, newestGlobal.envId.id);
    });

    test('clearing an explicit selection publishes the environment that reads now return', async () => {
        await envManagers.setEnvironments('global', configured, false, { explicit: true });
        await flush();
        const changeEvents: DidChangeEnvironmentEventArgs[] = [];
        envManagers.onDidChangeActiveEnvironment((e) => changeEvents.push(e));

        await envManagers.setEnvironments('global', configured, false);
        await flush();

        assert.deepStrictEqual(
            changeEvents.map((e) => [e.old?.envId.id, e.new?.envId.id]),
            [[configured.envId.id, newestGlobal.envId.id]],
        );
        assert.strictEqual(envManagers.getLastKnownEnvironment(undefined)?.envId.id, newestGlobal.envId.id);
    });

    test('clearing an explicit project selection publishes the environment that reads now return', async () => {
        await envManagers.setEnvironment(projectUri, configured, false, { explicit: true });
        await flush();
        const changeEvents: DidChangeEnvironmentEventArgs[] = [];
        envManagers.onDidChangeActiveEnvironment((e) => changeEvents.push(e));

        await envManagers.setEnvironment(projectUri, configured, false);
        await flush();

        assert.deepStrictEqual(
            changeEvents.map((e) => [e.old?.envId.id, e.new?.envId.id]),
            [[configured.envId.id, newestGlobal.envId.id]],
        );
        assert.strictEqual(envManagers.getLastKnownEnvironment(projectUri)?.envId.id, newestGlobal.envId.id);
    });

    test('clearing the selection clears the explicit selection', async () => {
        await envManagers.setEnvironments('global', configured, false, { explicit: true });
        await envManagers.setEnvironments('global', undefined);

        assert.strictEqual((await envManagers.getEnvironment(undefined))?.envId.id, newestGlobal.envId.id);
    });

    suite('a user selection from a third manager', () => {
        const pyenvEnv = makeEnv('pyenv-311', 'ms-python.python:pyenv', '3.11.9');
        let pyenvGlobal: PythonEnvironment | undefined;

        setup(() => {
            pyenvGlobal = undefined;
            registerManager(
                'pyenv',
                sandbox.stub().callsFake(async () => pyenvGlobal),
                sandbox.stub().callsFake(async (_scope: Uri | undefined, env?: PythonEnvironment) => {
                    pyenvGlobal = env;
                }),
            );
        });

        test('is not replaced when an automatic selection runs again', async () => {
            await envManagers.setEnvironments('global', pyenvEnv);
            await flush();
            const changeEvents: DidChangeEnvironmentEventArgs[] = [];
            envManagers.onDidChangeActiveEnvironment((e) => changeEvents.push(e));

            // A settings change re-runs the priority chain; global auto-discovery reports the system manager's global.
            await envManagers.setEnvironments('global', newestGlobal, false, { explicit: false });
            await flush();

            assert.strictEqual(changeEvents.length, 0);
            assert.strictEqual((await envManagers.getEnvironment(undefined))?.envId.id, pyenvEnv.envId.id);
            assert.strictEqual(envManagers.getLastKnownEnvironment(undefined)?.envId.id, pyenvEnv.envId.id);
        });

        test('is replaced by an environment chosen by a setting', async () => {
            await envManagers.setEnvironments('global', pyenvEnv);
            await envManagers.setEnvironments('global', configured, false, { explicit: true });

            assert.strictEqual((await envManagers.getEnvironment(undefined))?.envId.id, configured.envId.id);
        });

        test('is replaced by another user selection', async () => {
            await envManagers.setEnvironments('global', pyenvEnv);
            await envManagers.setEnvironments('global', configured);

            assert.strictEqual((await envManagers.getEnvironment(undefined))?.envId.id, configured.envId.id);
        });
    });

    test('refreshEnvironment keeps an explicit selection while the default manager only has its fallback', async () => {
        await envManagers.setEnvironment(projectUri, configured, false, { explicit: true });
        await flush();
        const changeEvents: DidChangeEnvironmentEventArgs[] = [];
        envManagers.onDidChangeActiveEnvironment((e) => changeEvents.push(e));

        await envManagers.refreshEnvironment(projectUri);
        await flush();

        assert.strictEqual(changeEvents.length, 0);
        assert.strictEqual(envManagers.getLastKnownEnvironment(projectUri)?.envId.id, configured.envId.id);
    });

    test('refreshEnvironment switches to a venv once the default manager has one', async () => {
        await envManagers.setEnvironment(projectUri, configured, false, { explicit: true });
        await flush();
        const changeEvents: DidChangeEnvironmentEventArgs[] = [];
        envManagers.onDidChangeActiveEnvironment((e) => changeEvents.push(e));

        venvGet.resolves(localVenv);
        await envManagers.refreshEnvironment(projectUri);
        await flush();

        assert.strictEqual(changeEvents.length, 1);
        assert.strictEqual(changeEvents[0].old?.envId.id, configured.envId.id);
        assert.strictEqual(changeEvents[0].new?.envId.id, localVenv.envId.id);
        assert.strictEqual((await envManagers.getEnvironment(fileUri))?.envId.id, localVenv.envId.id);
    });

    test('refreshEnvironment settles on the default manager fallback after its venv goes away', async () => {
        // The system manager kept an older per-project entry from an earlier session.
        systemSelections.set(projectUri.fsPath, configured);
        venvGet.resolves(localVenv);
        await envManagers.setEnvironment(projectUri, localVenv, false);
        await flush();
        const changeEvents: DidChangeEnvironmentEventArgs[] = [];
        envManagers.onDidChangeActiveEnvironment((e) => changeEvents.push(e));

        venvGet.resolves(newestGlobal);
        await envManagers.refreshEnvironment(projectUri);
        await flush();
        await envManagers.refreshEnvironment(projectUri);
        await flush();

        assert.deepStrictEqual(
            changeEvents.map((e) => [e.old?.envId.id, e.new?.envId.id]),
            [[localVenv.envId.id, newestGlobal.envId.id]],
        );
        assert.strictEqual((await envManagers.getEnvironment(fileUri))?.envId.id, newestGlobal.envId.id);
        assert.strictEqual(envManagers.getLastKnownEnvironment(projectUri)?.envId.id, newestGlobal.envId.id);
    });
});
