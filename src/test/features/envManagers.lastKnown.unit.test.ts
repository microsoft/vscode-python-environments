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
    ): string {
        const onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
        const onDidChangeEnvironments = new EventEmitter<DidChangeEnvironmentsEventArgs>();
        const manager = {
            name: 'test-env-mgr',
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
});
