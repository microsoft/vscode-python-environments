import assert from 'node:assert';
import { PEP440Version } from '../../common/utils/pep440Version';

suite('PEP440Version', () => {
    suite('parse', () => {
        test('simple release', () => {
            const v = PEP440Version.parse('1.2.3');
            assert.ok(v);
            assert.deepStrictEqual([...v.release], [1, 2, 3]);
            assert.strictEqual(v.epoch, 0);
            assert.strictEqual(v.pre, undefined);
            assert.strictEqual(v.post, undefined);
            assert.strictEqual(v.dev, undefined);
            assert.strictEqual(v.local, undefined);
        });

        test('single segment release', () => {
            const v = PEP440Version.parse('42');
            assert.ok(v);
            assert.deepStrictEqual([...v.release], [42]);
        });

        test('epoch', () => {
            const v = PEP440Version.parse('2!1.0');
            assert.ok(v);
            assert.strictEqual(v.epoch, 2);
        });

        test('alpha pre-release', () => {
            const v = PEP440Version.parse('1.0a1');
            assert.ok(v);
            assert.strictEqual(v.pre, 'a');
            assert.strictEqual(v.preNumber, 1);
        });

        test('beta pre-release', () => {
            const v = PEP440Version.parse('1.0b2');
            assert.ok(v);
            assert.strictEqual(v.pre, 'b');
            assert.strictEqual(v.preNumber, 2);
        });

        test('rc pre-release', () => {
            const v = PEP440Version.parse('1.0rc3');
            assert.ok(v);
            assert.strictEqual(v.pre, 'rc');
            assert.strictEqual(v.preNumber, 3);
        });

        test('normalizes "alpha" to "a"', () => {
            const v = PEP440Version.parse('1.0alpha1');
            assert.ok(v);
            assert.strictEqual(v.pre, 'a');
        });

        test('normalizes "beta" to "b"', () => {
            const v = PEP440Version.parse('1.0beta2');
            assert.ok(v);
            assert.strictEqual(v.pre, 'b');
        });

        test('normalizes "c" to "rc"', () => {
            const v = PEP440Version.parse('1.0c1');
            assert.ok(v);
            assert.strictEqual(v.pre, 'rc');
        });

        test('normalizes "preview" to "rc"', () => {
            const v = PEP440Version.parse('1.0preview1');
            assert.ok(v);
            assert.strictEqual(v.pre, 'rc');
        });

        test('post release', () => {
            const v = PEP440Version.parse('1.0.post1');
            assert.ok(v);
            assert.strictEqual(v.post, 1);
        });

        test('implicit post release (dash form)', () => {
            const v = PEP440Version.parse('1.0-1');
            assert.ok(v);
            assert.strictEqual(v.post, 1);
        });

        test('dev release', () => {
            const v = PEP440Version.parse('1.0.dev3');
            assert.ok(v);
            assert.strictEqual(v.dev, 3);
        });

        test('local version', () => {
            const v = PEP440Version.parse('1.0+ubuntu1');
            assert.ok(v);
            assert.strictEqual(v.local, 'ubuntu1');
        });

        test('leading v is accepted', () => {
            const v = PEP440Version.parse('v1.0');
            assert.ok(v);
            assert.strictEqual(v.major, 1);
        });

        test('pre-release without number defaults to 0', () => {
            const v = PEP440Version.parse('1.0a');
            assert.ok(v);
            assert.strictEqual(v.preNumber, 0);
        });

        test('dev without number defaults to 0', () => {
            const v = PEP440Version.parse('1.0.dev');
            assert.ok(v);
            assert.strictEqual(v.dev, 0);
        });

        test('returns undefined for invalid version', () => {
            assert.strictEqual(PEP440Version.parse('not-a-version'), undefined);
            assert.strictEqual(PEP440Version.parse(''), undefined);
            assert.strictEqual(PEP440Version.parse('abc.def'), undefined);
        });
    });

    suite('constructor normalization', () => {
        test('preserves trailing zeros in release', () => {
            const v = new PEP440Version([1, 0, 0]);
            assert.deepStrictEqual([...v.release], [1, 0, 0]);
        });

        test('normalizes local separators', () => {
            const v = new PEP440Version([1], { local: 'Ubuntu-1_2' });
            assert.strictEqual(v.local, 'ubuntu.1.2');
        });

        test('normalizes pre label "alpha" to "a"', () => {
            const v = new PEP440Version([1], { pre: 'alpha' });
            assert.strictEqual(v.pre, 'a');
            assert.strictEqual(v.preNumber, 0);
        });
    });

    suite('toString', () => {
        test('simple version', () => {
            assert.strictEqual(PEP440Version.parse('1.2.3')?.toString(), '1.2.3');
        });

        test('epoch included when non-zero', () => {
            assert.strictEqual(PEP440Version.parse('2!1.0')?.toString(), '2!1.0');
        });

        test('pre-release', () => {
            assert.strictEqual(PEP440Version.parse('1.0a1')?.toString(), '1.0a1');
            assert.strictEqual(PEP440Version.parse('1.0rc3')?.toString(), '1.0rc3');
        });

        test('post-release', () => {
            assert.strictEqual(PEP440Version.parse('1.0.post1')?.toString(), '1.0.post1');
        });

        test('dev release', () => {
            assert.strictEqual(PEP440Version.parse('1.0.dev5')?.toString(), '1.0.dev5');
        });

        test('local version', () => {
            assert.strictEqual(PEP440Version.parse('1.0+local1')?.toString(), '1.0+local1');
        });

        test('normalizes alternate labels in output', () => {
            assert.strictEqual(PEP440Version.parse('1.0alpha1')?.toString(), '1.0a1');
            assert.strictEqual(PEP440Version.parse('1.0c3')?.toString(), '1.0rc3');
        });
    });

    suite('properties', () => {
        test('major/minor/micro', () => {
            const v = PEP440Version.parse('3.11.4');
            assert.ok(v);
            assert.strictEqual(v.major, 3);
            assert.strictEqual(v.minor, 11);
            assert.strictEqual(v.micro, 4);
        });

        test('minor defaults to 0 for single segment', () => {
            const v = PEP440Version.parse('5');
            assert.ok(v);
            assert.strictEqual(v.minor, 0);
            assert.strictEqual(v.micro, 0);
        });

        test('isPreRelease', () => {
            assert.strictEqual(PEP440Version.parse('1.0')?.isPreRelease, false);
            assert.strictEqual(PEP440Version.parse('1.0a1')?.isPreRelease, true);
            assert.strictEqual(PEP440Version.parse('1.0.dev1')?.isPreRelease, true);
        });

        test('isPostRelease', () => {
            assert.strictEqual(PEP440Version.parse('1.0.post1')?.isPostRelease, true);
            assert.strictEqual(PEP440Version.parse('1.0')?.isPostRelease, false);
        });

        test('isLocal', () => {
            assert.strictEqual(PEP440Version.parse('1.0+local')?.isLocal, true);
            assert.strictEqual(PEP440Version.parse('1.0')?.isLocal, false);
        });
    });

    suite('compare', () => {
        function v(s: string): PEP440Version {
            const parsed = PEP440Version.parse(s);
            assert.ok(parsed, `Failed to parse "${s}"`);
            return parsed;
        }

        test('release ordering', () => {
            assert.ok(PEP440Version.compare(v('1.0'), v('1.1')) < 0);
            assert.ok(PEP440Version.compare(v('1.0'), v('2.0')) < 0);
            assert.ok(PEP440Version.compare(v('1.0.0'), v('1.0.1')) < 0);
        });

        test('epoch takes precedence', () => {
            assert.ok(PEP440Version.compare(v('1!1.0'), v('2!0.1')) < 0);
        });

        test('dev < alpha < beta < rc < final', () => {
            assert.ok(PEP440Version.compare(v('1.0.dev1'), v('1.0a1')) < 0);
            assert.ok(PEP440Version.compare(v('1.0a1'), v('1.0b1')) < 0);
            assert.ok(PEP440Version.compare(v('1.0b1'), v('1.0rc1')) < 0);
            assert.ok(PEP440Version.compare(v('1.0rc1'), v('1.0')) < 0);
        });

        test('final < post', () => {
            assert.ok(PEP440Version.compare(v('1.0'), v('1.0.post1')) < 0);
        });

        test('pre-release number ordering', () => {
            assert.ok(PEP440Version.compare(v('1.0a1'), v('1.0a2')) < 0);
        });

        test('dev on pre-release sorts before pre without dev', () => {
            assert.ok(PEP440Version.compare(v('1.0a1.dev1'), v('1.0a1')) < 0);
        });

        test('equality', () => {
            assert.strictEqual(PEP440Version.compare(v('1.0.0'), v('1.0')), 0);
        });
    });
});
