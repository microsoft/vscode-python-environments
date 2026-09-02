import assert from 'node:assert';
import { PythonVersion } from '../../common/pythonVersion';

suite('PythonVersion', () => {
    test('normalizes missing version components', () => {
        assert.strictEqual(new PythonVersion('3').toString(), '3.0.0');
        assert.strictEqual(new PythonVersion('3.12').toString(), '3.12.0');
        assert.strictEqual(new PythonVersion('3.12.4').toString(), '3.12.4');
    });

    test('normalizes surrounding whitespace and leading zeroes', () => {
        assert.strictEqual(new PythonVersion(' 03.012.004 ').toString(), '3.12.4');
    });

    test('normalizes Python release-level suffixes', () => {
        assert.strictEqual(new PythonVersion('3.14.3.final.0').toString(), '3.14.3');
        assert.strictEqual(new PythonVersion('3.14.0.beta.1').toString(), '3.14.0b1');
        assert.strictEqual(new PythonVersion('3.14.0b1').toString(), '3.14.0b1');
        assert.strictEqual(new PythonVersion('3.15.0rc1').toString(), '3.15.0rc1');
    });

    test('normalizes every prerelease spelling and separator', () => {
        assert.strictEqual(new PythonVersion('3.14.0alpha1').toString(), '3.14.0a1');
        assert.strictEqual(new PythonVersion('3.14.0beta1').toString(), '3.14.0b1');
        assert.strictEqual(new PythonVersion('3.14.0candidate1').toString(), '3.14.0rc1');
        assert.strictEqual(new PythonVersion('3.14.0-alpha-1').toString(), '3.14.0a1');
        assert.strictEqual(new PythonVersion('3.14.0_alpha_1').toString(), '3.14.0a1');
        assert.strictEqual(new PythonVersion('3.14.0.alpha.1').toString(), '3.14.0a1');
        assert.strictEqual(new PythonVersion('3.14.0ALPHA1').toString(), '3.14.0a1');
    });

    test('treats every release-candidate alias as the same level', () => {
        for (const alias of ['rc1', 'c1', 'pre1', 'preview1', 'candidate1']) {
            assert.strictEqual(new PythonVersion(`3.14.0${alias}`).toString(), '3.14.0rc1', alias);
        }
    });

    test('compares each numeric component in order', () => {
        assert.ok(new PythonVersion('3.9').compareTo(new PythonVersion('3.10')) < 0);
        assert.ok(new PythonVersion('3.12.9').compareTo(new PythonVersion('3.12.10')) < 0);
        assert.ok(new PythonVersion('4').compareTo(new PythonVersion('3.99.99')) > 0);
        assert.strictEqual(new PythonVersion('3.12').compareTo(new PythonVersion('3.12.0')), 0);
    });

    test('orders prereleases before the final release of the same numeric release', () => {
        const prerelease = new PythonVersion('3.14.0rc1');
        const final = new PythonVersion('3.14.0');

        assert.strictEqual(prerelease.compareTo(final), -1);
        assert.strictEqual(final.compareTo(prerelease), 1);
    });

    test('preserves release precision for formatting and selector matching', () => {
        const version = new PythonVersion('3.12.4');

        assert.strictEqual(new PythonVersion('3').toReleaseString(), '3');
        assert.strictEqual(new PythonVersion('3.12').toReleaseString(), '3.12');
        assert.strictEqual(version.toReleaseString(), '3.12.4');
        assert.strictEqual(new PythonVersion('3.14.0rc1').toReleaseString(), '3.14.0');
        assert.strictEqual(version.matchesSelector(new PythonVersion('3.12')), true);
        assert.strictEqual(new PythonVersion('3.120.1').matchesSelector(new PythonVersion('3.12')), false);
        assert.strictEqual(version.matchesSelector(new PythonVersion('3.12.4')), true);
        assert.strictEqual(version.matchesSelector(new PythonVersion('3.12.5')), false);
        assert.strictEqual(new PythonVersion('3.14.0').matchesSelector(new PythonVersion('3.14.0rc1')), false);
    });

    test('orders prereleases before the final release', () => {
        assert.ok(new PythonVersion('3.14.0a1').compareTo(new PythonVersion('3.14.0b1')) < 0);
        assert.ok(new PythonVersion('3.14.0b1').compareTo(new PythonVersion('3.14.0b2')) < 0);
        assert.ok(new PythonVersion('3.14.0b2').compareTo(new PythonVersion('3.14.0rc1')) < 0);
        assert.ok(new PythonVersion('3.14.0rc1').compareTo(new PythonVersion('3.14.0')) < 0);
    });

    test('preserves the version as supplied alongside the normalized form', () => {
        const version = new PythonVersion(' 3.14.0.beta.1 ');

        assert.strictEqual(version.source, '3.14.0.beta.1');
        assert.strictEqual(version.toString(), '3.14.0b1');
    });

    test('compares a bounded number of leading release components', () => {
        const version = new PythonVersion('3.12.4');

        assert.strictEqual(version.matchesReleasePrefix(new PythonVersion('3.12')), true);
        assert.strictEqual(version.matchesReleasePrefix(new PythonVersion('3.12.5')), false);
        assert.strictEqual(version.matchesReleasePrefix(new PythonVersion('3.12.5'), 2), true);
        assert.strictEqual(version.matchesReleasePrefix(new PythonVersion('3.13.4'), 1), true);
    });

    test('rejects versions that cannot be compared safely', () => {
        for (const version of [
            '',
            '3.',
            '3.12.1.4',
            '3.12.1.final.1',
            'Python 3.12',
            `${Number.MAX_SAFE_INTEGER}0.1.0`,
        ]) {
            assert.throws(() => new PythonVersion(version), TypeError);
        }
    });

    test('tries to parse untrusted values without throwing', () => {
        assert.strictEqual(PythonVersion.tryParse('3.14.0b1')?.toString(), '3.14.0b1');
        assert.strictEqual(PythonVersion.tryParse('invalid'), undefined);
        assert.strictEqual(PythonVersion.tryParse(undefined), undefined);
        assert.strictEqual(PythonVersion.tryParse({ version: '3.14.0' }), undefined);
    });
});
