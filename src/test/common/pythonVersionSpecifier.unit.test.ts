import assert from 'node:assert';
import { PythonVersion } from '../../common/pythonVersion';
import { PythonVersionSpecifier } from '../../common/pythonVersionSpecifier';

/**
 * Evaluates a specifier against a version, yielding `undefined` when the
 * specifier is malformed so that invalid input stays distinguishable from a
 * valid non-match.
 */
function matches(version: string, specifier: unknown): boolean | undefined {
    return PythonVersionSpecifier.tryParse(specifier)?.matches(new PythonVersion(version));
}

suite('PythonVersionSpecifier', () => {
    test('matches release-prefix wildcard specifiers', () => {
        assert.strictEqual(matches('3.14.0', '==3.*'), true);
        assert.strictEqual(matches('3.14.0', '==3.14.*'), true);
        assert.strictEqual(matches('3.14.0', '==3.14.0.*'), true);
        assert.strictEqual(matches('3.14.0', '==3.13.*'), false);
        assert.strictEqual(matches('3.14.0', '==4.*'), false);
    });

    test('rejects malformed wildcards without throwing', () => {
        assert.strictEqual(matches('3.14.0', '==*'), undefined);
        assert.strictEqual(matches('3.14.0', '==3.*.0'), undefined);
        assert.strictEqual(matches('3.14.0', '>=3.14.*'), undefined);
        assert.strictEqual(matches('3.14.0', '==3.14.0.0.*'), undefined);
        assert.strictEqual(matches('3.14.0', `==${Number.MAX_SAFE_INTEGER}0.*`), undefined);
        assert.strictEqual(matches('3.14.0', undefined), undefined);
    });

    test('rejects a wildcard over a prerelease prefix', () => {
        assert.strictEqual(matches('3.14.0b1', '==3.14.0b1.*'), undefined);
        assert.strictEqual(matches('3.14.0b1', '!=3.14.0b1.*'), undefined);
    });

    test('matches ordered and compound specifiers', () => {
        assert.strictEqual(matches('3.12.4', '>=3.11'), true);
        assert.strictEqual(matches('3.12.4', '>=3.10,<3.13'), true);
        assert.strictEqual(matches('3.12.4', '>=3.13'), false);
        assert.strictEqual(matches('3.12.4', '<=3.12.4'), true);
        assert.strictEqual(matches('3.12.4', '>3.12.4'), false);
    });

    test('matches equality and wildcard specifiers', () => {
        assert.strictEqual(matches('3.12.4', '==3.12.4'), true);
        assert.strictEqual(matches('3.12.4', '!=3.12.3'), true);
        assert.strictEqual(matches('3.12.4', '==3.12.*'), true);
        assert.strictEqual(matches('3.12.4', '!=3.12.*'), false);
        assert.strictEqual(matches('3.12.4', '==3.11.*'), false);
    });

    test('matches compatible-release specifiers', () => {
        assert.strictEqual(matches('3.12.4', '~=3.11'), true);
        assert.strictEqual(matches('4.0.0', '~=3.11'), false);
        assert.strictEqual(matches('3.11.10', '~=3.11.2'), true);
        assert.strictEqual(matches('3.12.0', '~=3.11.2'), false);
    });

    test('supports arbitrary equality and release equality', () => {
        assert.strictEqual(matches('3.11', '==3.11.0'), true);
        assert.strictEqual(matches('3.11', '===3.11'), true);
        assert.strictEqual(matches('3.11', '===3.11.0'), false);
    });

    test('excludes prereleases unless the specifier names one', () => {
        assert.strictEqual(matches('3.11.0rc1', '>=3.11'), false);
        assert.strictEqual(matches('3.11.0rc1', '>=3.11.0rc1'), true);
        assert.strictEqual(matches('3.14.0b1', '==3.14.*'), false);
    });

    test('excludes prereleases of an exclusive upper bound', () => {
        assert.strictEqual(matches('3.14.0rc1', '>=3.13.0rc1,<3.14'), false);
        assert.strictEqual(matches('3.13.5rc1', '>=3.13.0rc1,<3.14'), true);
        assert.strictEqual(matches('3.14.0rc1', '>=3.13.0rc1,<3.14.0rc2'), true);
        assert.strictEqual(matches('3.14.0rc1', '>=3.13.0rc1,<=3.14'), true);
        assert.strictEqual(matches('3.13.9', '>=3.13,<3.14'), true);
    });

    test('accepts a leading v on the literal', () => {
        assert.strictEqual(matches('3.12.4', '>=v3.11'), true);
        assert.strictEqual(matches('3.12.4', '==v3.12.*'), true);
        assert.strictEqual(matches('3.12.4', '>=v'), undefined);
    });

    test('rejects malformed specifiers without throwing', () => {
        assert.strictEqual(matches('3.12.4', ''), undefined);
        assert.strictEqual(matches('3.12.4', '3.12'), undefined);
        assert.strictEqual(matches('3.12.4', '>=3.12.*'), undefined);
        assert.strictEqual(matches('3.12.4', `!=${Number.MAX_SAFE_INTEGER}0.*`), undefined);
        assert.strictEqual(matches('3.12.4', '~=3'), undefined);
        assert.strictEqual(matches('3.12.4', '>=3.11,'), undefined);
        assert.strictEqual(matches('3.12.4', '>=3.11,,<4'), undefined);
        assert.strictEqual(matches('3.12.4', undefined), undefined);
    });

    test('distinguishes invalid specifiers from valid non-matches', () => {
        assert.strictEqual(matches('3.12.4', '>=3.13'), false);
        assert.strictEqual(matches('3.12.4', '>=3.12.*'), undefined);
        assert.strictEqual(matches('3.12.4', '>=3.13,invalid'), undefined);
    });

    test('validates every clause before reporting a non-match', () => {
        assert.strictEqual(PythonVersionSpecifier.tryParse('>=3.13,invalid'), undefined);
        assert.ok(PythonVersionSpecifier.tryParse('>=3.10,<3.13'));
    });

    test('reuses a parsed specifier across versions', () => {
        const specifier = PythonVersionSpecifier.tryParse('>=3.11,<3.14');
        assert.ok(specifier);

        assert.strictEqual(specifier.matches(new PythonVersion('3.12.4')), true);
        assert.strictEqual(specifier.matches(new PythonVersion('3.10.0')), false);
        assert.strictEqual(specifier.matches(new PythonVersion('3.14.0')), false);
    });
});
