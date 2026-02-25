import assert from 'node:assert';
import { RpcTimeoutError, getConfigureTimeoutMs } from '../../../managers/common/nativePythonFinder';

suite('RpcTimeoutError', () => {
    test('has correct name property', () => {
        const error = new RpcTimeoutError('configure', 30000);
        assert.strictEqual(error.name, 'RpcTimeoutError');
    });

    test('has correct method property', () => {
        const error = new RpcTimeoutError('configure', 30000);
        assert.strictEqual(error.method, 'configure');
    });

    test('message includes method name and timeout', () => {
        const error = new RpcTimeoutError('resolve', 5000);
        assert.strictEqual(error.message, "Request 'resolve' timed out after 5000ms");
    });

    test('is instanceof Error', () => {
        const error = new RpcTimeoutError('configure', 30000);
        assert.ok(error instanceof Error);
        assert.ok(error instanceof RpcTimeoutError);
    });
});

suite('getConfigureTimeoutMs', () => {
    test('returns base timeout (30s) on first attempt', () => {
        assert.strictEqual(getConfigureTimeoutMs(0), 30_000);
    });

    test('doubles timeout on first retry (60s)', () => {
        assert.strictEqual(getConfigureTimeoutMs(1), 60_000);
    });

    test('doubles again on second retry (120s)', () => {
        assert.strictEqual(getConfigureTimeoutMs(2), 120_000);
    });

    test('caps at REFRESH_TIMEOUT_MS (120s) for higher retries', () => {
        // 30_000 * 2^3 = 240_000, but capped at 120_000
        assert.strictEqual(getConfigureTimeoutMs(3), 120_000);
        assert.strictEqual(getConfigureTimeoutMs(10), 120_000);
    });
});
