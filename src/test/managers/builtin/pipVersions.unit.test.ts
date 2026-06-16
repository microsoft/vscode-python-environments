import assert from 'assert';
import { explain } from '@renovatebot/pep440';
import { parsePipIndexVersionsJson } from '../../../managers/builtin/pipPackageManager';

suite('Pip Version Parsing', () => {
    suite('parsePipIndexVersionsJson', () => {
        test('parses valid JSON with versions array', () => {
            const output = JSON.stringify({ name: 'requests', versions: ['2.31.0', '2.30.0', '2.29.0'] });
            const versions = parsePipIndexVersionsJson(output);
            assert.deepStrictEqual(versions, ['2.31.0', '2.30.0', '2.29.0'].map((v) => explain(v)));
        });

        test('parses output with a single version', () => {
            const output = JSON.stringify({ name: 'my-package', versions: ['1.0.0'] });
            const versions = parsePipIndexVersionsJson(output);
            assert.deepStrictEqual(versions, [explain('1.0.0')]);
        });

        test('returns undefined for empty versions array', () => {
            const output = JSON.stringify({ name: 'pkg', versions: [] });
            const versions = parsePipIndexVersionsJson(output);
            assert.strictEqual(versions, undefined);
        });

        test('returns undefined for invalid JSON', () => {
            const versions = parsePipIndexVersionsJson('not json');
            assert.strictEqual(versions, undefined);
        });

        test('returns undefined when versions field is missing', () => {
            const output = JSON.stringify({ name: 'pkg' });
            const versions = parsePipIndexVersionsJson(output);
            assert.strictEqual(versions, undefined);
        });
    });
});

