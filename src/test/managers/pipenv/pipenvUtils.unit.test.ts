import * as assert from 'assert';
import { getPipenvVersion, PIPENV_GLOBAL } from '../../../managers/pipenv/pipenvUtils';

suite('Pipenv Utils Tests', () => {
    test('getPipenvVersion should handle missing pipenv gracefully', async () => {
        const result = await getPipenvVersion('non-existent-pipenv');
        // Should return undefined for non-existent pipenv, not throw an error
        assert.strictEqual(result, undefined);
    });

    test('pipenv constants should be properly defined', () => {
        assert.strictEqual(PIPENV_GLOBAL, 'Global');
    });
});