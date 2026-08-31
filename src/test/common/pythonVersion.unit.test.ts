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

    test('compares each numeric component in order', () => {
        assert.ok(new PythonVersion('3.9').compareTo(new PythonVersion('3.10')) < 0);
        assert.ok(new PythonVersion('3.12.9').compareTo(new PythonVersion('3.12.10')) < 0);
        assert.ok(new PythonVersion('4').compareTo(new PythonVersion('3.99.99')) > 0);
        assert.strictEqual(new PythonVersion('3.12').compareTo(new PythonVersion('3.12.0')), 0);
    });

    test('orders prereleases before the final release', () => {
        assert.ok(new PythonVersion('3.14.0a1').compareTo(new PythonVersion('3.14.0b1')) < 0);
        assert.ok(new PythonVersion('3.14.0b1').compareTo(new PythonVersion('3.14.0b2')) < 0);
        assert.ok(new PythonVersion('3.14.0b2').compareTo(new PythonVersion('3.14.0rc1')) < 0);
        assert.ok(new PythonVersion('3.14.0rc1').compareTo(new PythonVersion('3.14.0')) < 0);
    });

    test('rejects versions that cannot be compared safely', () => {
        for (const version of ['', '3.', '3.12.1.4', 'Python 3.12', `${Number.MAX_SAFE_INTEGER}0.1.0`]) {
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
