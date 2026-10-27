import assert from 'node:assert';
import {
    NativeInfo,
    NativePythonEnvironmentKind,
    RpcTimeoutError,
    retryRpcTimeout,
} from '../../../managers/common/nativePythonFinder';
import {
    getRefreshTelemetryMeasures,
    shouldRetainPetInfo,
} from '../../../managers/common/petTelemetry';

suite('NativePythonFinder telemetry', () => {
    test('builds numeric refresh measures with available context', () => {
        const nativeInfo: NativeInfo[] = [
            { executable: '/envs/conda/bin/python', kind: NativePythonEnvironmentKind.conda },
            { executable: '/workspace/.venv/bin/python', kind: NativePythonEnvironmentKind.venv },
            { tool: 'Conda', executable: '/tools/conda' },
        ];

        const measures = getRefreshTelemetryMeasures({
            duration: 1200,
            nativeInfo,
            condaKind: NativePythonEnvironmentKind.conda,
            unresolvedCount: 1,
            workspaceDirCount: 2,
            searchPathCount: 3,
            attempt: 1,
            refreshPerformance: {
                total: 1100,
                breakdown: {
                    Locators: 100,
                    Path: 200,
                    GlobalVirtualEnvs: 300,
                    Workspaces: 400,
                },
                locators: { Conda: 75 },
            },
        });

        assert.deepStrictEqual(measures, {
            duration: 1200,
            envCount: 2,
            condaEnvCount: 1,
            managerCount: 1,
            unresolvedCount: 1,
            attempt: 1,
            workspaceDirCount: 2,
            searchPathCount: 3,
            breakdownLocators: 100,
            breakdownPathEnv: 200,
            breakdownGlobalVirtualEnvs: 300,
            breakdownWorkspaces: 400,
        });
    });

    test('omits refresh context that was unavailable before an early failure', () => {
        const measures = getRefreshTelemetryMeasures({
            duration: 50,
            nativeInfo: [],
            condaKind: NativePythonEnvironmentKind.conda,
            unresolvedCount: 0,
            attempt: 0,
        });

        assert.deepStrictEqual(measures, {
            duration: 50,
            envCount: 0,
            condaEnvCount: 0,
            managerCount: 0,
            unresolvedCount: 0,
            attempt: 0,
        });
    });

    test('uses the caller-provided Conda kind identity', () => {
        const measures = getRefreshTelemetryMeasures({
            duration: 1,
            nativeInfo: [{ kind: 'custom-conda' }],
            condaKind: 'custom-conda',
            unresolvedCount: 0,
            attempt: 0,
        });

        assert.strictEqual(measures.condaEnvCount, 1);
    });

    test('retains PET info only when the binary is provably unchanged', () => {
        assert.strictEqual(shouldRetainPetInfo(false, undefined, undefined), true);
        assert.strictEqual(shouldRetainPetInfo(true, '10:20', '10:20'), true);
        assert.strictEqual(shouldRetainPetInfo(true, '10:20', '11:20'), false);
        assert.strictEqual(shouldRetainPetInfo(true, '10:20', undefined), false);
        assert.strictEqual(shouldRetainPetInfo(true, undefined, '10:20'), false);
    });

    test('retries an RPC timeout and returns the later result', async () => {
        let attempts = 0;

        const result = await retryRpcTimeout(async () => {
            attempts++;
            if (attempts === 1) {
                throw new RpcTimeoutError('info', 2000);
            }
            return { petVersion: '0.1.0', buildId: '42' };
        }, 3);

        assert.deepStrictEqual(result, { petVersion: '0.1.0', buildId: '42' });
        assert.strictEqual(attempts, 2);
    });

    test('does not retry non-timeout RPC failures', async () => {
        const expected = new Error('method not found');
        let attempts = 0;

        await assert.rejects(
            retryRpcTimeout(async () => {
                attempts++;
                throw expected;
            }, 3),
            (error: unknown) => error === expected,
        );
        assert.strictEqual(attempts, 1);
    });

    test('stops retrying after the connection is superseded', async () => {
        let attempts = 0;
        let connectionIsCurrent = true;

        await assert.rejects(
            retryRpcTimeout(
                async () => {
                    attempts++;
                    connectionIsCurrent = false;
                    throw new RpcTimeoutError('info', 2000);
                },
                3,
                () => connectionIsCurrent,
            ),
            RpcTimeoutError,
        );
        assert.strictEqual(attempts, 1);
    });

    test('rejects invalid RPC retry limits', async () => {
        await assert.rejects(retryRpcTimeout(async () => 'unused', 0), RangeError);
        await assert.rejects(retryRpcTimeout(async () => 'unused', 1.5), RangeError);
    });

    test('stops retrying RPC timeouts at the attempt limit', async () => {
        let attempts = 0;

        await assert.rejects(
            retryRpcTimeout(async () => {
                attempts++;
                throw new RpcTimeoutError('info', 2000);
            }, 3),
            RpcTimeoutError,
        );
        assert.strictEqual(attempts, 3);
    });
});
