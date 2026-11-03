// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'node:assert';
import * as sinon from 'sinon';
import { CancellationTokenSource, Uri } from 'vscode';
import { PythonEnvironment } from '../../api';
import { handlePythonPath } from '../../common/utils/pythonPath';
import * as logging from '../../common/logging';
import type { InternalEnvironmentManager } from '../../managers/common/registeredManagers';
import { VENV_MANAGER_ID, CONDA_MANAGER_ID, SYSTEM_MANAGER_ID } from '../../common/constants';

function createMockManager(
    id: string,
    displayName: string,
    resolveResult: PythonEnvironment | undefined = undefined,
): sinon.SinonStubbedInstance<InternalEnvironmentManager> {
    return {
        id,
        displayName,
        resolve: sinon.stub().resolves(resolveResult),
    } as unknown as sinon.SinonStubbedInstance<InternalEnvironmentManager>;
}

function createMockEnv(managerId: string): PythonEnvironment {
    return {
        envId: { id: `env-${managerId}`, managerId },
        name: `env-${managerId}`,
        displayName: `Env ${managerId}`,
        version: '3.11.0',
        displayPath: '/usr/bin/python3',
        environmentPath: Uri.file('/usr/bin/python3'),
        sysPrefix: '/usr',
        execInfo: { run: { executable: '/usr/bin/python3' } },
    } as PythonEnvironment;
}

suite('handlePythonPath', () => {
    const testUri = Uri.file('/test/python3');

    teardown(() => {
        sinon.restore();
    });

    test('tool resolution explicitly skips unsupported managers without invoking their public resolver', async () => {
        const unsupported = createMockManager('other.extension:manager', 'Unsupported');
        const expected = createMockEnv(VENV_MANAGER_ID);
        const supported = createMockManager(VENV_MANAGER_ID, 'Venv');
        const resolve = sinon.stub().resolves(expected);
        Object.defineProperty(supported, 'tools', { value: { resolve } });
        const logged = sinon.stub(logging, 'traceVerbose');
        const result = await handlePythonPath(testUri, [supported], [unsupported], undefined, undefined, true);
        assert.strictEqual(result, expected);
        assert.ok(resolve.calledOnceWithExactly(testUri));
        assert.ok((unsupported.resolve as sinon.SinonStub).notCalled);
        assert.ok((supported.resolve as sinon.SinonStub).notCalled);
        assert.ok(logged.calledWithMatch(/Skipping other.extension:manager.*non-interactive/));
    });

    test('returns undefined when no managers can resolve the path', async () => {
        const manager1 = createMockManager(VENV_MANAGER_ID, 'Venv');
        const manager2 = createMockManager(CONDA_MANAGER_ID, 'Conda');

        const result = await handlePythonPath(testUri, [manager1, manager2], []);

        assert.strictEqual(result, undefined);
    });

    test('returns environment from project manager that resolves first', async () => {
        const mockEnv = createMockEnv(VENV_MANAGER_ID);
        const projectManager = createMockManager(VENV_MANAGER_ID, 'Venv', mockEnv);
        const globalManager = createMockManager(CONDA_MANAGER_ID, 'Conda');

        const result = await handlePythonPath(testUri, [globalManager], [projectManager]);

        assert.strictEqual(result, mockEnv);
        // Global manager should NOT have been called since project manager resolved
        assert.strictEqual((globalManager.resolve as sinon.SinonStub).called, false);
    });

    test('falls back to global managers when project managers cannot resolve', async () => {
        const mockEnv = createMockEnv(CONDA_MANAGER_ID);
        const projectManager = createMockManager(VENV_MANAGER_ID, 'Venv');
        const globalManager = createMockManager(CONDA_MANAGER_ID, 'Conda', mockEnv);

        const result = await handlePythonPath(testUri, [globalManager], [projectManager]);

        assert.strictEqual(result, mockEnv);
    });

    test('does not re-check managers already checked as project managers', async () => {
        const projectManager = createMockManager(VENV_MANAGER_ID, 'Venv');
        const globalManager = createMockManager(VENV_MANAGER_ID, 'Venv');

        const result = await handlePythonPath(testUri, [globalManager], [projectManager]);

        assert.strictEqual(result, undefined);
        // Project manager checked, but global manager with same id should be skipped
        assert.strictEqual((projectManager.resolve as sinon.SinonStub).callCount, 1);
        assert.strictEqual((globalManager.resolve as sinon.SinonStub).callCount, 0);
    });

    test('returns undefined and does not throw for unresolvable paths', async () => {
        const manager = createMockManager(SYSTEM_MANAGER_ID, 'System');

        const result = await handlePythonPath(Uri.file('/usr/bin/node'), [manager], []);

        assert.strictEqual(result, undefined);
    });

    test('respects cancellation token', async () => {
        const cts = new CancellationTokenSource();
        cts.cancel();

        const manager = createMockManager(VENV_MANAGER_ID, 'Venv');

        const result = await handlePythonPath(testUri, [], [manager], undefined, cts.token);

        assert.strictEqual(result, undefined);
        assert.strictEqual((manager.resolve as sinon.SinonStub).called, false);
    });

    test('respects cancellation token for global managers', async () => {
        const cts = new CancellationTokenSource();
        cts.cancel();

        const manager = createMockManager(VENV_MANAGER_ID, 'Venv');

        const result = await handlePythonPath(testUri, [manager], [], undefined, cts.token);

        assert.strictEqual(result, undefined);
        assert.strictEqual((manager.resolve as sinon.SinonStub).called, false);
    });

    test('reports progress for project managers', async () => {
        const reporter = { report: sinon.stub() };
        const projectManager = createMockManager(VENV_MANAGER_ID, 'Venv');

        await handlePythonPath(testUri, [], [projectManager], reporter);

        assert.strictEqual(reporter.report.callCount, 1);
        assert.deepStrictEqual(reporter.report.firstCall.args[0], { message: 'Checking Venv' });
    });

    test('reports progress for global managers', async () => {
        const reporter = { report: sinon.stub() };
        const manager1 = createMockManager(VENV_MANAGER_ID, 'Venv');
        const manager2 = createMockManager(CONDA_MANAGER_ID, 'Conda');

        await handlePythonPath(testUri, [manager1, manager2], [], reporter);

        assert.strictEqual(reporter.report.callCount, 2);
        // Conda has higher priority, so it's checked first
        assert.deepStrictEqual(reporter.report.firstCall.args[0], { message: 'Checking Conda' });
        assert.deepStrictEqual(reporter.report.secondCall.args[0], { message: 'Checking Venv' });
    });

    test('sorts managers by priority order', async () => {
        // Neither resolves, so both get called — lets us verify call order
        const systemManager = createMockManager(SYSTEM_MANAGER_ID, 'System');
        const condaManager = createMockManager(CONDA_MANAGER_ID, 'Conda');

        // Pass system first in array, but conda should be tried first (higher priority)
        await handlePythonPath(testUri, [systemManager, condaManager], []);

        assert.ok((condaManager.resolve as sinon.SinonStub).calledBefore(systemManager.resolve as sinon.SinonStub));
    });

    test('returns first resolving manager and stops checking', async () => {
        const venvEnv = createMockEnv(VENV_MANAGER_ID);
        const condaEnv = createMockEnv(CONDA_MANAGER_ID);
        const venvManager = createMockManager(VENV_MANAGER_ID, 'Venv', venvEnv);
        const condaManager = createMockManager(CONDA_MANAGER_ID, 'Conda', condaEnv);

        // Conda is higher priority, so it resolves first
        const result = await handlePythonPath(testUri, [venvManager, condaManager], []);

        assert.strictEqual(result, condaEnv);
        // Venv should NOT have been called since conda resolved first
        assert.strictEqual((venvManager.resolve as sinon.SinonStub).called, false);
    });

    test('returns undefined when both arrays are empty', async () => {
        const result = await handlePythonPath(testUri, [], []);

        assert.strictEqual(result, undefined);
    });
});
