import * as assert from 'assert';
import { mergeEnvVariables } from '../../../features/execution/envVarUtils';

suite('Env Var Utils Tests', () => {
    test('mergeEnvVariables substitutes every reference to a base variable', () => {
        const env = mergeEnvVariables(
            { ROOT: '/home/user', SECRET: 'pa$$word' },
            { A: '${ROOT}/a:${ROOT}/b', B: '${SECRET}' },
        );
        assert.strictEqual(env.A, '/home/user/a:/home/user/b');
        assert.strictEqual(env.B, 'pa$$word');
    });
});
