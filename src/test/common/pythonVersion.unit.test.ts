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

    test('satisfies release-prefix wildcard specifiers', () => {
        const version = new PythonVersion('3.14.0b1');

        assert.strictEqual(version.satisfies('==3.*'), true);
        assert.strictEqual(version.satisfies('==3.14.*'), true);
        assert.strictEqual(version.satisfies('==3.14.0.*'), true);
        assert.strictEqual(version.satisfies('==3.13.*'), false);
        assert.strictEqual(version.satisfies('==4.*'), false);
    });

    test('rejects malformed wildcards without throwing', () => {
        const version = new PythonVersion('3.14.0');

        assert.strictEqual(version.satisfies('==*'), undefined);
        assert.strictEqual(version.satisfies('==3.*.0'), undefined);
        assert.strictEqual(version.satisfies('>=3.14.*'), undefined);
        assert.strictEqual(version.satisfies(`==${Number.MAX_SAFE_INTEGER}0.*`), undefined);
        assert.strictEqual(version.satisfies(undefined), undefined);
    });

    test('satisfies ordered and compound specifiers', () => {
        const version = new PythonVersion('3.12.4');

        assert.strictEqual(version.satisfies('>=3.11'), true);
        assert.strictEqual(version.satisfies('>=3.10,<3.13'), true);
        assert.strictEqual(version.satisfies('>=3.13'), false);
        assert.strictEqual(version.satisfies('<=3.12.4'), true);
        assert.strictEqual(version.satisfies('>3.12.4'), false);
    });

    test('satisfies equality and wildcard specifiers', () => {
        const version = new PythonVersion('3.12.4');

        assert.strictEqual(version.satisfies('==3.12.4'), true);
        assert.strictEqual(version.satisfies('!=3.12.3'), true);
        assert.strictEqual(version.satisfies('==3.12.*'), true);
        assert.strictEqual(version.satisfies('!=3.12.*'), false);
        assert.strictEqual(version.satisfies('==3.11.*'), false);
    });

    test('satisfies compatible-release specifiers', () => {
        assert.strictEqual(new PythonVersion('3.12.4').satisfies('~=3.11'), true);
        assert.strictEqual(new PythonVersion('4.0.0').satisfies('~=3.11'), false);
        assert.strictEqual(new PythonVersion('3.11.10').satisfies('~=3.11.2'), true);
        assert.strictEqual(new PythonVersion('3.12.0').satisfies('~=3.11.2'), false);
    });

    test('supports arbitrary equality and release equality', () => {
        assert.strictEqual(new PythonVersion('3.11').satisfies('==3.11.0'), true);
        assert.strictEqual(new PythonVersion('3.11').satisfies('===3.11'), true);
        assert.strictEqual(new PythonVersion('3.11').satisfies('===3.11.0'), false);
        assert.strictEqual(new PythonVersion('3.11.0rc1').satisfies('>=3.11'), true);
    });

    test('rejects malformed specifiers without throwing', () => {
        const version = new PythonVersion('3.12.4');

        assert.strictEqual(version.satisfies(''), undefined);
        assert.strictEqual(version.satisfies('3.12'), undefined);
        assert.strictEqual(version.satisfies('>=3.12.*'), undefined);
        assert.strictEqual(version.satisfies(`!=${Number.MAX_SAFE_INTEGER}0.*`), undefined);
        assert.strictEqual(version.satisfies('~=3'), undefined);
        assert.strictEqual(version.satisfies('>=3.11,'), undefined);
        assert.strictEqual(version.satisfies('>=3.11,,<4'), undefined);
        assert.strictEqual(version.satisfies(undefined), undefined);
    });

    test('distinguishes invalid specifiers from valid non-matches', () => {
        const version = new PythonVersion('3.12.4');

        assert.strictEqual(version.satisfies('>=3.13'), false);
        assert.strictEqual(version.satisfies('>=3.12.*'), undefined);
        assert.strictEqual(version.satisfies('>=3.13,invalid'), undefined);
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
