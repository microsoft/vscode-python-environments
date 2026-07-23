// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Tests for PythonEnvironmentManagers.getLastKnownEnvironment, the synchronous accessor that
 * lets the public getEnvironment API serve a value promptly while a slow initial resolution
 * runs in the background (avoids blocking consumers such as Pylance's configuration handler).
 */

import { Extension } from 'vscode';

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as typeMoq from 'typemoq';
import { EventEmitter, Uri } from 'vscode';
import {
    DidChangeEnvironmentEventArgs,
    DidChangeEnvironmentsEventArgs,
    EnvironmentManager,
    GetEnvironmentScope,
    PythonEnvironment,
    PythonEnvironmentId,
} from '../../api';
import * as extensionApis from '../../common/extension.apis';
import { PythonEnvironmentManagers } from '../../features/envManagers';
import * as settingHelpers from '../../features/settings/settingHelpers';
import { PythonProjectManager } from '../../internal.api';
import { setupNonThenable } from '../mocks/helper';

suite('PythonEnvironmentManagers getLastKnownEnvironment', () => {
    let envManagers: PythonEnvironmentManagers;
    let projectManager: typeMoq.IMock<PythonProjectManager>;

    function makeEnv(id: string): PythonEnvironment {
        const envId: PythonEnvironmentId = { id, managerId: 'test-manager' };
        return {
            envId,
            name: id,
            displayName: id,
            displayPath: `/path/${id}`,
            version: '3.11.0',
            environmentPath: Uri.file(`/path/${id}`),
            execInfo: { run: { executable: `/path/${id}/python`, args: [] } },
            sysPrefix: `/path/${id}`,
        } as PythonEnvironment;
    }

    setup(() => {
        const mockPythonExtension = { id: 'ms-python.python', extensionPath: '/mock/python/extension' };
        const mockEnvsExtension = { id: 'ms-python.vscode-python-envs', extensionPath: '/mock/envs/extension' };

        const getExtensionStub = sinon.stub(extensionApis, 'getExtension');
        getExtensionStub.withArgs('ms-python.python').returns(mockPythonExtension as Extension<unknown>);
        getExtensionStub.withArgs('ms-python.vscode-python-envs').returns(mockEnvsExtension as Extension<unknown>);
        sinon
            .stub(extensionApis, 'allExtensions')
            .returns([mockPythonExtension, mockEnvsExtension] as Extension<unknown>[]);

        projectManager = typeMoq.Mock.ofType<PythonProjectManager>();
        setupNonThenable(projectManager);
        // No project for a scope -> refreshEnvironment/getLastKnownEnvironment use the 'global' key.
        projectManager.setup((pm) => pm.get(typeMoq.It.isAny())).returns(() => undefined);

        envManagers = new PythonEnvironmentManagers(projectManager.object);
    });

    teardown(() => {
        sinon.restore();
        envManagers.dispose();
    });

    function registerManager(
        getImpl: (scope: GetEnvironmentScope) => Promise<PythonEnvironment | undefined>,
        setImpl: EnvironmentManager['set'] = async () => undefined,
        name = 'test-env-mgr',
    ): string {
        const onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
        const onDidChangeEnvironments = new EventEmitter<DidChangeEnvironmentsEventArgs>();
        const manager = {
            name,
            displayName: 'Test Env Manager',
            preferredPackageManagerId: 'ms-python.python:pip',
            onDidChangeEnvironment: onDidChangeEnvironment.event,
            onDidChangeEnvironments: onDidChangeEnvironments.event,
            get: getImpl,
            getEnvironments: async () => [],
            set: setImpl,
            resolve: async () => undefined,
            refresh: async () => undefined,
        } as unknown as EnvironmentManager;

        envManagers.registerEnvironmentManager(manager);
        const id = envManagers.managers[0].id;
        // Force the default environment manager (used for undefined/global scope) to resolve to ours.
        sinon.stub(settingHelpers, 'getDefaultEnvManagerSetting').returns(id);
        return id;
    }

    test('returns undefined before any environment has been resolved', () => {
        registerManager(async () => makeEnv('env1'));
        assert.strictEqual(envManagers.getLastKnownEnvironment(undefined), undefined);
    });

    test('returns the active environment after it has been resolved', async () => {
        const env = makeEnv('env1');
        registerManager(async () => env);

        // Refreshing the active selection populates the last-known cache.
        await envManagers.refreshEnvironment(undefined);

        // Now available synchronously without any await or refresh.
        assert.strictEqual(envManagers.getLastKnownEnvironment(undefined), env);
    });

    test('reflects the most recent environment after it changes', async () => {
        let current = makeEnv('env1');
        registerManager(async () => current);

        await envManagers.refreshEnvironment(undefined);
        assert.strictEqual(envManagers.getLastKnownEnvironment(undefined)?.envId.id, 'env1');

        current = makeEnv('env2');
        await envManagers.refreshEnvironment(undefined);
        assert.strictEqual(envManagers.getLastKnownEnvironment(undefined)?.envId.id, 'env2');
    });

    test('does not update selection, settings, or events when a registered manager rejects a selection', async () => {
        const scope = Uri.file('/workspace/script.py');
        const project = { name: 'script.py', uri: scope };
        projectManager.setup((pm) => pm.get(scope)).returns(() => project);
        const managerSet = sinon.stub().rejects(new Error('Inline-script environment is not an owned cache entry.'));
        const managerId = registerManager(async () => undefined, managerSet);
        const rejected = {
            ...makeEnv('unowned'),
            envId: { id: 'unowned', managerId },
        };
        const settings = sinon.stub(settingHelpers, 'setAllManagerSettings').resolves();
        const events: DidChangeEnvironmentEventArgs[] = [];
        envManagers.onDidChangeActiveEnvironment((event) => events.push(event));

        await assert.rejects(envManagers.setEnvironment(scope, rejected), /not an owned cache entry/);
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(envManagers.getLastKnownEnvironment(scope), undefined);
        assert.strictEqual(settings.callCount, 0);
        assert.strictEqual(events.length, 0);
    });

    test('does not publish batch or global selections when the manager rejects', async () => {
        const scope = Uri.file('/workspace/script.py');
        const managerSet = sinon.stub().rejects(new Error('selection rejected'));
        const managerId = registerManager(async () => undefined, managerSet);
        const rejected = {
            ...makeEnv('rejected'),
            envId: { id: 'rejected', managerId },
        };
        const settings = sinon.stub(settingHelpers, 'setAllManagerSettings').resolves();
        const events: DidChangeEnvironmentEventArgs[] = [];
        envManagers.onDidChangeActiveEnvironment((event) => events.push(event));

        await assert.rejects(envManagers.setEnvironments([scope], rejected, false), /selection rejected/);
        await assert.rejects(envManagers.setEnvironments('global', rejected, false), /selection rejected/);
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(envManagers.getLastKnownEnvironment(scope), undefined);
        assert.strictEqual(envManagers.getLastKnownEnvironment(undefined), undefined);
        assert.strictEqual(settings.callCount, 0);
        assert.strictEqual(events.length, 0);
    });

    test('passes same-manager batch unsets to the manager atomically', async () => {
        const first = Uri.file('/workspace/first.py');
        const second = Uri.file('/workspace/second.py');
        const managerSet = sinon.stub().resolves();
        registerManager(async () => undefined, managerSet);

        await envManagers.setEnvironments([first, second], undefined, false);

        sinon.assert.calledOnceWithExactly(managerSet, [first, second], undefined);
    });

    test('does not let an older same-manager refresh overwrite a newer selection', async () => {
        const initial = makeEnv('initial');
        let resolveStaleRefresh: ((environment: PythonEnvironment) => void) | undefined;
        const staleRefresh = new Promise<PythonEnvironment>((resolve) => {
            resolveStaleRefresh = resolve;
        });
        const managerGet = sinon.stub();
        managerGet.onFirstCall().resolves(initial);
        managerGet.onSecondCall().returns(staleRefresh);
        const managerId = registerManager(managerGet);
        const selected = {
            ...makeEnv('selected'),
            envId: { id: 'selected', managerId },
        };

        await envManagers.refreshEnvironment(undefined);
        const refresh = envManagers.refreshEnvironment(undefined);
        await envManagers.setEnvironment(undefined, selected, false);
        resolveStaleRefresh!(initial);
        await refresh;

        assert.strictEqual(envManagers.getLastKnownEnvironment(undefined), selected);
    });

    test('retains an in-flight refresh when a concurrent selection fails', async () => {
        const refreshed = makeEnv('refreshed');
        let resolveRefresh: ((environment: PythonEnvironment) => void) | undefined;
        const managerGet = sinon.stub().returns(
            new Promise<PythonEnvironment>((resolve) => {
                resolveRefresh = resolve;
            }),
        );
        const managerId = registerManager(managerGet, sinon.stub().rejects(new Error('selection rejected')));
        const rejected = {
            ...makeEnv('rejected'),
            envId: { id: 'rejected', managerId },
        };

        const refresh = envManagers.refreshEnvironment(undefined);
        await assert.rejects(envManagers.setEnvironment(undefined, rejected, false), /selection rejected/);
        resolveRefresh!(refreshed);
        await refresh;

        assert.strictEqual(envManagers.getLastKnownEnvironment(undefined), refreshed);
    });

    test('tracks inline-script selections independently for scripts in the same project', async () => {
        const firstUri = Uri.file('/workspace/first.py');
        const secondUri = Uri.file('/workspace/second.py');
        const managerId = registerManager(async () => undefined, async () => undefined, 'inline-script');
        const first = { ...makeEnv('first'), envId: { id: 'first', managerId } };
        const second = { ...makeEnv('second'), envId: { id: 'second', managerId } };

        await envManagers.setEnvironment(firstUri, first, false);
        await envManagers.setEnvironment(secondUri, second, false);

        assert.strictEqual(envManagers.getLastKnownEnvironment(firstUri), first);
        assert.strictEqual(envManagers.getLastKnownEnvironment(secondUri), second);
    });

    test('retains an earlier successful refresh when a later refresh fails', async () => {
        const refreshed = makeEnv('refreshed');
        let resolveFirst: ((environment: PythonEnvironment) => void) | undefined;
        const managerGet = sinon.stub();
        managerGet.onFirstCall().returns(
            new Promise<PythonEnvironment>((resolve) => {
                resolveFirst = resolve;
            }),
        );
        managerGet.onSecondCall().rejects(new Error('refresh rejected'));
        registerManager(managerGet);

        const first = envManagers.refreshEnvironment(undefined);
        await assert.rejects(envManagers.refreshEnvironment(undefined), /refresh rejected/);
        resolveFirst!(refreshed);
        await first;

        assert.strictEqual(envManagers.getLastKnownEnvironment(undefined), refreshed);
    });
});
