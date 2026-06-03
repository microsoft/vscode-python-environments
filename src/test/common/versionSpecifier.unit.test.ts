import assert from 'node:assert';
import { PEP440Version } from '../../common/utils/pep440Version';
import { VersionConstraint, VersionSpecifier } from '../../common/utils/versionSpecifier';

suite('VersionSpecifier', () => {
    function v(s: string): PEP440Version {
        const parsed = PEP440Version.parse(s);
        assert.ok(parsed, `Failed to parse "${s}"`);
        return parsed;
    }

    suite('parse', () => {
        test('parses >= operator', () => {
            const s = VersionSpecifier.parse('>=1.2.3');
            assert.ok(s);
            assert.strictEqual(s.op, '>=');
            assert.strictEqual(s.version.toString(), '1.2.3');
            assert.strictEqual(s.wildcard, false);
        });

        test('parses == with wildcard', () => {
            const s = VersionSpecifier.parse('==1.2.*');
            assert.ok(s);
            assert.strictEqual(s.op, '==');
            assert.strictEqual(s.wildcard, true);
        });

        test('parses != with wildcard', () => {
            const s = VersionSpecifier.parse('!=1.0.*');
            assert.ok(s);
            assert.strictEqual(s.op, '!=');
            assert.strictEqual(s.wildcard, true);
        });

        test('parses === (arbitrary equality)', () => {
            const s = VersionSpecifier.parse('===1.0');
            assert.ok(s);
            assert.strictEqual(s.op, '===');
        });

        test('parses ~= (compatible release)', () => {
            const s = VersionSpecifier.parse('~=1.4.2');
            assert.ok(s);
            assert.strictEqual(s.op, '~=');
        });

        test('allows whitespace between operator and version', () => {
            const s = VersionSpecifier.parse('>= 1.0');
            assert.ok(s);
            assert.strictEqual(s.op, '>=');
        });

        test('rejects wildcard with invalid operator', () => {
            assert.strictEqual(VersionSpecifier.parse('>=1.2.*'), undefined);
            assert.strictEqual(VersionSpecifier.parse('<1.0.*'), undefined);
        });

        test('returns undefined for invalid input', () => {
            assert.strictEqual(VersionSpecifier.parse(''), undefined);
            assert.strictEqual(VersionSpecifier.parse('1.0'), undefined);
            assert.strictEqual(VersionSpecifier.parse('>>1.0'), undefined);
        });
    });

    suite('contains', () => {
        test('== exact match', () => {
            const s = VersionSpecifier.parse('==1.2.3');
            assert.ok(s);
            assert.strictEqual(s.contains(v('1.2.3')), true);
            assert.strictEqual(s.contains(v('1.2.4')), false);
        });

        test('!= excludes exact match', () => {
            const s = VersionSpecifier.parse('!=1.0');
            assert.ok(s);
            assert.strictEqual(s.contains(v('1.0')), false);
            assert.strictEqual(s.contains(v('1.1')), true);
        });

        test('>= includes boundary', () => {
            const s = VersionSpecifier.parse('>=1.2');
            assert.ok(s);
            assert.strictEqual(s.contains(v('1.2')), true);
            assert.strictEqual(s.contains(v('1.3')), true);
            assert.strictEqual(s.contains(v('1.1')), false);
        });

        test('< excludes boundary', () => {
            const s = VersionSpecifier.parse('<2.0');
            assert.ok(s);
            assert.strictEqual(s.contains(v('1.9')), true);
            assert.strictEqual(s.contains(v('2.0')), false);
        });

        test('== wildcard matches prefix', () => {
            const s = VersionSpecifier.parse('==1.2.*');
            assert.ok(s);
            assert.strictEqual(s.contains(v('1.2.0')), true);
            assert.strictEqual(s.contains(v('1.2.99')), true);
            assert.strictEqual(s.contains(v('1.3.0')), false);
        });

        test('!= wildcard excludes prefix', () => {
            const s = VersionSpecifier.parse('!=1.0.*');
            assert.ok(s);
            assert.strictEqual(s.contains(v('1.0.5')), false);
            assert.strictEqual(s.contains(v('1.1.0')), true);
        });

        test('~= compatible release', () => {
            const s = VersionSpecifier.parse('~=1.4.2');
            assert.ok(s);
            assert.strictEqual(s.contains(v('1.4.2')), true);
            assert.strictEqual(s.contains(v('1.4.5')), true);
            assert.strictEqual(s.contains(v('1.5.0')), false);
            assert.strictEqual(s.contains(v('1.4.1')), false);
        });

        test('=== arbitrary equality', () => {
            const s = VersionSpecifier.parse('===1.0');
            assert.ok(s);
            assert.strictEqual(s.contains(v('1.0')), true);
            assert.strictEqual(s.contains(v('1.0.0')), false); // string mismatch: "1.0" vs "1.0.0"
        });
    });

    suite('toString', () => {
        test('round-trips specifier string', () => {
            assert.strictEqual(VersionSpecifier.parse('>=1.2.3')?.toString(), '>=1.2.3');
            assert.strictEqual(VersionSpecifier.parse('==1.2.*')?.toString(), '==1.2.*');
            assert.strictEqual(VersionSpecifier.parse('~=1.4.2')?.toString(), '~=1.4.2');
        });
    });
});

suite('VersionConstraint', () => {
    function v(s: string): PEP440Version {
        const parsed = PEP440Version.parse(s);
        assert.ok(parsed, `Failed to parse "${s}"`);
        return parsed;
    }

    suite('parse', () => {
        test('parses single specifier', () => {
            const c = VersionConstraint.parse('>=1.0');
            assert.ok(c);
            assert.strictEqual(c.specifiers.length, 1);
        });

        test('parses multiple comma-separated specifiers', () => {
            const c = VersionConstraint.parse('>=1.2, <2.0');
            assert.ok(c);
            assert.strictEqual(c.specifiers.length, 2);
            assert.strictEqual(c.specifiers[0].op, '>=');
            assert.strictEqual(c.specifiers[1].op, '<');
        });

        test('returns undefined for empty string', () => {
            assert.strictEqual(VersionConstraint.parse(''), undefined);
        });

        test('returns undefined if any clause is invalid', () => {
            assert.strictEqual(VersionConstraint.parse('>=1.0, invalid'), undefined);
        });
    });

    suite('contains', () => {
        test('all specifiers must match', () => {
            const c = VersionConstraint.parse('>=1.2, <2.0');
            assert.ok(c);
            assert.strictEqual(c.contains(v('1.5')), true);
            assert.strictEqual(c.contains(v('1.2')), true);
            assert.strictEqual(c.contains(v('2.0')), false);
            assert.strictEqual(c.contains(v('1.1')), false);
        });

        test('exclusion constraint', () => {
            const c = VersionConstraint.parse('>=1.0, !=1.5');
            assert.ok(c);
            assert.strictEqual(c.contains(v('1.4')), true);
            assert.strictEqual(c.contains(v('1.5')), false);
            assert.strictEqual(c.contains(v('1.6')), true);
        });
    });

    suite('toString', () => {
        test('round-trips constraint string', () => {
            const c = VersionConstraint.parse('>=1.2,<2.0');
            assert.ok(c);
            assert.strictEqual(c.toString(), '>=1.2,<2.0');
        });
    });
});
