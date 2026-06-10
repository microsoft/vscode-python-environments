import { compare as pep440Compare, valid as pep440Valid } from '@renovatebot/pep440';
import assert from 'node:assert';
import { shortenVersionString } from '../../managers/common/utils';

suite('pep440Version', () => {
    suite('pep440Valid', () => {
        test('accepts simple release', () => {
            assert.strictEqual(pep440Valid('1.2.3'), '1.2.3');
        });

        test('accepts single segment', () => {
            assert.strictEqual(pep440Valid('42'), '42');
        });

        test('accepts epoch', () => {
            assert.ok(pep440Valid('2!1.0'));
        });

        test('accepts pre-release versions', () => {
            assert.ok(pep440Valid('1.0a1'));
            assert.ok(pep440Valid('1.0b2'));
            assert.ok(pep440Valid('1.0rc3'));
            assert.ok(pep440Valid('1.0alpha1'));
            assert.ok(pep440Valid('1.0beta2'));
            assert.ok(pep440Valid('1.0c1'));
            assert.ok(pep440Valid('1.0preview1'));
        });

        test('accepts post release', () => {
            assert.ok(pep440Valid('1.0.post1'));
        });

        test('accepts implicit post release (dash form)', () => {
            assert.ok(pep440Valid('1.0-1'));
        });

        test('accepts dev release', () => {
            assert.ok(pep440Valid('1.0.dev3'));
        });

        test('accepts local version', () => {
            assert.ok(pep440Valid('1.0+ubuntu1'));
        });

        test('accepts leading v', () => {
            assert.ok(pep440Valid('v1.0'));
        });

        test('rejects invalid versions', () => {
            assert.strictEqual(pep440Valid('not-a-version'), null);
            assert.strictEqual(pep440Valid(''), null);
            assert.strictEqual(pep440Valid('abc.def'), null);
        });
    });

    suite('pep440Compare', () => {
        test('release ordering', () => {
            assert.ok(pep440Compare('1.0', '1.1') < 0);
            assert.ok(pep440Compare('1.0', '2.0') < 0);
            assert.ok(pep440Compare('1.0.0', '1.0.1') < 0);
        });

        test('epoch takes precedence', () => {
            assert.ok(pep440Compare('1!1.0', '2!0.1') < 0);
        });

        test('dev < alpha < beta < rc < final', () => {
            assert.ok(pep440Compare('1.0.dev1', '1.0a1') < 0);
            assert.ok(pep440Compare('1.0a1', '1.0b1') < 0);
            assert.ok(pep440Compare('1.0b1', '1.0rc1') < 0);
            assert.ok(pep440Compare('1.0rc1', '1.0') < 0);
        });

        test('final < post', () => {
            assert.ok(pep440Compare('1.0', '1.0.post1') < 0);
        });

        test('pre-release number ordering', () => {
            assert.ok(pep440Compare('1.0a1', '1.0a2') < 0);
        });

        test('dev on pre-release sorts before pre without dev', () => {
            assert.ok(pep440Compare('1.0a1.dev1', '1.0a1') < 0);
        });

        test('equality', () => {
            assert.strictEqual(pep440Compare('1.0.0', '1.0'), 0);
        });
    });

    suite('shortenVersionString', () => {
        test('returns X.Y.Z for 3-segment version', () => {
            assert.strictEqual(shortenVersionString('3.11.4'), '3.11.4');
        });

        test('returns X.Y.x for 2-segment version', () => {
            assert.strictEqual(shortenVersionString('3.11'), '3.11.x');
        });

        test('returns input for invalid version', () => {
            assert.strictEqual(shortenVersionString('not-a-version'), 'not-a-version');
        });

        test('extracts major.minor.micro from complex version', () => {
            assert.strictEqual(shortenVersionString('3.12.1a1'), '3.12.1');
        });
    });
});
