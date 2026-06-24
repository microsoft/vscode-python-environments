import assert from 'assert';
import * as sinon from 'sinon';
import * as logging from '../../common/logging';
import { safeRegister } from '../../common/utils/asyncUtils';

suite('safeRegister', () => {
    let traceErrorStub: sinon.SinonStub;

    setup(() => {
        traceErrorStub = sinon.stub(logging, 'traceError');
    });

    teardown(() => {
        sinon.restore();
    });

    test('resolves when the task succeeds', async () => {
        await safeRegister('test-manager', Promise.resolve());
        assert.ok(traceErrorStub.notCalled, 'traceError should not be called on success');
    });

    test('resolves (not rejects) when the task fails', async () => {
        const failing = Promise.reject(new Error('boom'));
        // safeRegister must not propagate the rejection
        await safeRegister('failing-manager', failing);
        // If we got here without throwing, the test passes
    });

    test('logs the manager name and error when the task fails', async () => {
        const error = new Error('registration exploded');
        await safeRegister('conda', Promise.reject(error));

        assert.ok(traceErrorStub.calledOnce, 'traceError should be called once');
        const [message, loggedError] = traceErrorStub.firstCall.args;
        assert.ok(message.includes('conda'), 'log message should contain the manager name');
        assert.strictEqual(loggedError, error, 'original error should be passed through');
    });

    test('independent tasks continue when one fails', async () => {
        const results: string[] = [];

        await Promise.all([
            safeRegister('will-fail', Promise.reject(new Error('fail'))),
            safeRegister(
                'will-succeed-1',
                Promise.resolve().then(() => {
                    results.push('a');
                }),
            ),
            safeRegister(
                'will-succeed-2',
                Promise.resolve().then(() => {
                    results.push('b');
                }),
            ),
        ]);

        assert.deepStrictEqual(results.sort(), ['a', 'b'], 'both successful tasks should complete');
        assert.ok(traceErrorStub.calledOnce, 'only the failing task should log an error');
    });

    test('handles non-Error rejections', async () => {
        await safeRegister('string-reject', Promise.reject('just a string'));

        assert.ok(traceErrorStub.calledOnce);
        const [, loggedError] = traceErrorStub.firstCall.args;
        assert.strictEqual(loggedError, 'just a string');
    });
});
