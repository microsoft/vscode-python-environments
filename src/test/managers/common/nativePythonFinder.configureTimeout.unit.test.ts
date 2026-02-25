import assert from 'node:assert';
import {
    ConfigureRetryState,
    RpcTimeoutError,
    getConfigureTimeoutMs,
} from '../../../managers/common/nativePythonFinder';

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

suite('ConfigureRetryState', () => {
    let state: ConfigureRetryState;

    setup(() => {
        state = new ConfigureRetryState();
    });

    test('initial timeout count is 0', () => {
        assert.strictEqual(state.timeoutCount, 0);
    });

    test('initial timeout is base (30s)', () => {
        assert.strictEqual(state.getTimeoutMs(), 30_000);
    });

    test('onSuccess resets timeout count', () => {
        state.onTimeout(); // count = 1
        state.onSuccess();
        assert.strictEqual(state.timeoutCount, 0);
        assert.strictEqual(state.getTimeoutMs(), 30_000);
    });

    test('first timeout does not kill (returns false)', () => {
        const shouldKill = state.onTimeout();
        assert.strictEqual(shouldKill, false);
        assert.strictEqual(state.timeoutCount, 1);
    });

    test('first timeout increases next timeout to 60s', () => {
        state.onTimeout();
        assert.strictEqual(state.getTimeoutMs(), 60_000);
    });

    test('second consecutive timeout kills (returns true)', () => {
        state.onTimeout(); // count = 1
        const shouldKill = state.onTimeout(); // count = 2 → kill → reset to 0
        assert.strictEqual(shouldKill, true);
        assert.strictEqual(state.timeoutCount, 0); // Reset after kill
    });

    test('non-timeout error resets counter via reset()', () => {
        state.onTimeout(); // count = 1
        state.reset(); // simulates non-timeout error
        assert.strictEqual(state.timeoutCount, 0);
        // Next timeout should not trigger kill
        const shouldKill = state.onTimeout();
        assert.strictEqual(shouldKill, false);
    });

    test('interleaved non-timeout error prevents premature kill', () => {
        state.onTimeout(); // count = 1
        state.reset(); // non-timeout error resets
        state.onTimeout(); // count = 1 again (not 2)
        assert.strictEqual(state.timeoutCount, 1);
        // Still shouldn't kill — only 1 consecutive timeout
        assert.strictEqual(state.getTimeoutMs(), 60_000);
    });

    test('reset after kill allows fresh retry cycle', () => {
        state.onTimeout();
        state.onTimeout(); // kill → reset
        // Counter was reset by onTimeout when it returned true
        assert.strictEqual(state.timeoutCount, 0);
        assert.strictEqual(state.getTimeoutMs(), 30_000);
        // First timeout of new cycle should not kill
        const shouldKill = state.onTimeout();
        assert.strictEqual(shouldKill, false);
    });
});
