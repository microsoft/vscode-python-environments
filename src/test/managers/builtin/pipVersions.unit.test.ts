import assert from 'assert';
import { explain } from '@renovatebot/pep440';
import { parsePipIndexVersionsJson, parsePipInstallVersions } from '../../../managers/builtin/pipManager';

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

    suite('parsePipInstallVersions', () => {
        test('parses versions from pip error output', () => {
            const output = `Collecting requests==__invalid__\n  Could not find a version that satisfies the requirement requests==__invalid__ (from versions: 2.31.0, 2.30.0, 2.28.2)\n  No matching distribution found for requests==__invalid__`;
            const versions = parsePipInstallVersions(output);
            assert.ok(versions);
            assert.strictEqual(versions!.length, 3);
            assert.strictEqual(versions![0].public, '2.31.0');
            assert.strictEqual(versions![1].public, '2.30.0');
            assert.strictEqual(versions![2].public, '2.28.2');
        });

        test('handles PEP 440 pre/post/dev versions', () => {
            const output = `Could not find a version that satisfies the requirement pkg==__invalid__ (from versions: 1.0.0, 1.0.0a1, 1.0.0.post1, 1.0.0.dev1)\nNo matching distribution found for pkg==__invalid__`;
            const versions = parsePipInstallVersions(output);
            assert.ok(versions);
            assert.ok(versions!.length === 4);
            // newest first: 1.0.0.post1 > 1.0.0 > 1.0.0a1 > 1.0.0.dev1
            assert.strictEqual(versions![0].public, '1.0.0.post1');
            assert.strictEqual(versions![1].public, '1.0.0');
            assert.strictEqual(versions![2].public, '1.0.0a1');
            assert.strictEqual(versions![3].public, '1.0.0.dev1');
        });

        test('returns undefined when pip reports "from versions: none"', () => {
            const output = `Could not find a version that satisfies the requirement nonexistent-pkg==__invalid__ (from versions: none)\nNo matching distribution found for nonexistent-pkg==__invalid__`;
            const versions = parsePipInstallVersions(output);
            assert.strictEqual(versions, undefined);
        });

        test('returns undefined when output has no version list', () => {
            const versions = parsePipInstallVersions('some unrelated error output');
            assert.strictEqual(versions, undefined);
        });

        test('handles surrounding stderr noise', () => {
            const output = `WARNING: some deprecation warning\nERROR: Could not find a version that satisfies the requirement pkg==__invalid__ (from versions: 1.2.3, 1.2.2)\nERROR: No matching distribution found`;
            const versions = parsePipInstallVersions(output);
            assert.ok(versions);
            assert.strictEqual(versions!.length, 2);
            assert.strictEqual(versions![0].public, '1.2.3');
        });
    });
});

