import assert from 'assert';
import { PythonEnvironment } from '../../../api';
import { isActivatableEnvironment } from '../../../features/common/activation';

suite('isActivatableEnvironment', () => {
    function env(execInfo: Partial<PythonEnvironment['execInfo']>): PythonEnvironment {
        return { execInfo: { run: { executable: 'python' }, ...execInfo } } as PythonEnvironment;
    }

    test('Environment without activation is not activatable', () => {
        assert.strictEqual(isActivatableEnvironment(env({})), false);
    });

    test('Environment with an empty shell activation map is not activatable', () => {
        assert.strictEqual(isActivatableEnvironment(env({ shellActivation: new Map() })), false);
    });

    test('Environment with shell activation commands is activatable', () => {
        const shellActivation = new Map([['bash', [{ executable: 'source', args: ['activate'] }]]]);
        assert.strictEqual(isActivatableEnvironment(env({ shellActivation })), true);
    });

    test('Environment with an activation command is activatable', () => {
        assert.strictEqual(isActivatableEnvironment(env({ activation: [{ executable: 'activate' }] })), true);
    });
});
