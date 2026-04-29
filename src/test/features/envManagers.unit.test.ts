// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import { PythonEnvironment } from '../../api';
import * as frameUtils from '../../common/utils/frameUtils';
import * as workspaceApis from '../../common/workspace.apis';
import { PythonEnvironmentManagers } from '../../features/envManagers';
import { PythonProjectManager } from '../../internal.api';

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
