// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as sinon from 'sinon';
import {
    CACHE_KEY_HEX_LENGTH,
    computeCacheKey,
    normalizeDependency,
    normalizeInterpreterPath,
} from '../../common/inlineScriptCacheKey';
import * as platformUtils from '../../common/utils/platformUtils';

suite('inlineScriptCacheKey', () => {
    let isWindowsStub: sinon.SinonStub;

    teardown(() => {
        sinon.restore();
    });

    suite('normalizeDependency', () => {
        test('bare package name is returned lowercased', () => {
            assert.strictEqual(normalizeDependency('requests'), 'requests');
            assert.strictEqual(normalizeDependency('Requests'), 'requests');
            assert.strictEqual(normalizeDependency('REQUESTS'), 'requests');
        });

        test('PEP 503 name normalization collapses -_. variants', () => {
            assert.strictEqual(normalizeDependency('Flask-Login'), 'flask-login');
            assert.strictEqual(normalizeDependency('flask_login'), 'flask-login');
            assert.strictEqual(normalizeDependency('flask.login'), 'flask-login');
            assert.strictEqual(normalizeDependency('Flask__Login'), 'flask-login');
            assert.strictEqual(normalizeDependency('flask-_-login'), 'flask-login');
        });

        test('whitespace around comparison operators is stripped', () => {
            assert.strictEqual(normalizeDependency('requests<3'), 'requests<3');
            assert.strictEqual(normalizeDependency('requests <3'), 'requests<3');
            assert.strictEqual(normalizeDependency('requests < 3'), 'requests<3');
            assert.strictEqual(normalizeDependency('requests  <  3'), 'requests<3');
        });

        test('all two-char comparison operators are stripped', () => {
            assert.strictEqual(normalizeDependency('requests >= 2'), 'requests>=2');
            assert.strictEqual(normalizeDependency('requests <= 2'), 'requests<=2');
            assert.strictEqual(normalizeDependency('requests == 2'), 'requests==2');
            assert.strictEqual(normalizeDependency('requests != 2'), 'requests!=2');
            assert.strictEqual(normalizeDependency('requests ~= 2'), 'requests~=2');
        });

        test('multi-clause version specifiers normalize each clause', () => {
            assert.strictEqual(normalizeDependency('requests <3, !=2.0'), 'requests<3,!=2.0');
            // Space before `,` survives — we only fold around comparison operators. Deliberate.
            assert.strictEqual(normalizeDependency('requests >= 1.0 , < 3.0'), 'requests>=1.0 ,<3.0');
        });

        test('PEP 440 arbitrary-equality `===` is also folded', () => {
            assert.strictEqual(normalizeDependency('requests === 1.0.dev0'), 'requests===1.0.dev0');
            assert.strictEqual(normalizeDependency('requests=== 1.0.dev0'), 'requests===1.0.dev0');
        });

        test('extras section is preserved and leading whitespace before [ is stripped', () => {
            assert.strictEqual(normalizeDependency('requests[security]'), 'requests[security]');
            assert.strictEqual(normalizeDependency('requests [security]'), 'requests[security]');
            assert.strictEqual(normalizeDependency('Requests [security,socks]'), 'requests[security,socks]');
        });

        test('extras are PEP 503 normalized (lowercase + separator folding)', () => {
            assert.strictEqual(normalizeDependency('requests[Socks]'), 'requests[socks]');
            assert.strictEqual(normalizeDependency('requests[SOCKS]'), 'requests[socks]');
            assert.strictEqual(normalizeDependency('pkg[socks_5]'), 'pkg[socks-5]');
            assert.strictEqual(normalizeDependency('pkg[socks.5]'), 'pkg[socks-5]');
            assert.strictEqual(normalizeDependency('pkg[Socks_5]'), 'pkg[socks-5]');
        });

        test('extras are sorted alphabetically', () => {
            assert.strictEqual(normalizeDependency('requests[socks,security]'), 'requests[security,socks]');
            assert.strictEqual(normalizeDependency('pkg[c,b,a]'), 'pkg[a,b,c]');
        });

        test('extras are deduplicated after PEP 503 normalization', () => {
            assert.strictEqual(normalizeDependency('requests[socks,Socks]'), 'requests[socks]');
            assert.strictEqual(normalizeDependency('pkg[socks_5,Socks-5,SOCKS.5]'), 'pkg[socks-5]');
        });

        test('whitespace inside the extras list is tolerated', () => {
            assert.strictEqual(normalizeDependency('requests[ security , socks ]'), 'requests[security,socks]');
            assert.strictEqual(normalizeDependency('requests[security , socks]'), 'requests[security,socks]');
        });

        test('empty extras block normalizes to no extras', () => {
            assert.strictEqual(normalizeDependency('pkg[]'), 'pkg');
            assert.strictEqual(normalizeDependency('pkg[ ]'), 'pkg');
            assert.strictEqual(normalizeDependency('pkg[,,]'), 'pkg');
        });

        test('extras combine cleanly with a version specifier', () => {
            assert.strictEqual(normalizeDependency('Requests[Socks] >= 2'), 'requests[socks]>=2');
            assert.strictEqual(normalizeDependency('requests[socks,security]<3'), 'requests[security,socks]<3');
        });

        test('marker section after `;` is preserved but operator spaces inside it are stripped', () => {
            assert.strictEqual(
                normalizeDependency("requests >= 2 ; python_version >= '3.10'"),
                "requests>=2 ; python_version>='3.10'",
            );
        });

        test('empty and whitespace-only entries normalize to empty string', () => {
            assert.strictEqual(normalizeDependency(''), '');
            assert.strictEqual(normalizeDependency('   '), '');
            assert.strictEqual(normalizeDependency('\t\n'), '');
        });

        test('URL/VCS specifiers are returned trimmed without further folding', () => {
            const input = 'requests @ git+https://github.com/psf/requests@v2.31.0';
            const result = normalizeDependency(input);
            assert.strictEqual(result, normalizeDependency(input), 'must be idempotent');
            assert.ok(result.includes('requests'), 'leading name should still appear');
        });

        test('leading and trailing whitespace is stripped', () => {
            assert.strictEqual(normalizeDependency('  requests  '), 'requests');
            assert.strictEqual(normalizeDependency('\trequests<3\n'), 'requests<3');
        });

        test('idempotent: normalizing a normalized entry produces the same string', () => {
            const samples = [
                'requests',
                'flask-login',
                'requests<3',
                'requests[security]',
                'requests[security,socks]',
                "requests>=2 ; python_version>='3.10'",
            ];
            for (const s of samples) {
                assert.strictEqual(normalizeDependency(s), s, `not idempotent for ${JSON.stringify(s)}`);
            }
        });
    });

    suite('normalizeInterpreterPath', () => {
        test('on POSIX, returns the input unchanged', () => {
            isWindowsStub = sinon.stub(platformUtils, 'isWindows').returns(false);
            assert.strictEqual(normalizeInterpreterPath('/usr/bin/python3'), '/usr/bin/python3');
            assert.strictEqual(normalizeInterpreterPath('/Users/Me/.venv/bin/python'), '/Users/Me/.venv/bin/python');
        });

        test('on Windows, lowercases and converts backslashes to forward slashes', () => {
            isWindowsStub = sinon.stub(platformUtils, 'isWindows').returns(true);
            assert.strictEqual(normalizeInterpreterPath('C:\\Python313\\python.exe'), 'c:/python313/python.exe');
            assert.strictEqual(normalizeInterpreterPath('C:/Python313/python.exe'), 'c:/python313/python.exe');
            assert.strictEqual(normalizeInterpreterPath('c:\\python313\\python.exe'), 'c:/python313/python.exe');
        });
    });

    suite('computeCacheKey', () => {
        const interpreter = '/usr/bin/python3';

        setup(() => {
            // POSIX default so path-canonicalization assertions don't depend on the host platform.
            isWindowsStub = sinon.stub(platformUtils, 'isWindows').returns(false);
        });

        test('output is exactly CACHE_KEY_HEX_LENGTH lowercase hex characters', () => {
            const key = computeCacheKey({ dependencies: ['requests'], interpreterPath: interpreter });
            assert.match(key, /^[0-9a-f]+$/, 'must be lowercase hex');
            assert.strictEqual(key.length, CACHE_KEY_HEX_LENGTH);
        });

        test('identical inputs produce identical keys', () => {
            const a = computeCacheKey({ dependencies: ['requests', 'rich'], interpreterPath: interpreter });
            const b = computeCacheKey({ dependencies: ['requests', 'rich'], interpreterPath: interpreter });
            assert.strictEqual(a, b);
        });

        test('reordering dependencies does not change the key', () => {
            const a = computeCacheKey({ dependencies: ['requests', 'rich'], interpreterPath: interpreter });
            const b = computeCacheKey({ dependencies: ['rich', 'requests'], interpreterPath: interpreter });
            assert.strictEqual(a, b);
        });

        test('trivial whitespace differences inside a version spec do not change the key', () => {
            const a = computeCacheKey({ dependencies: ['requests <3'], interpreterPath: interpreter });
            const b = computeCacheKey({ dependencies: ['requests<3'], interpreterPath: interpreter });
            const c = computeCacheKey({ dependencies: ['requests  <  3'], interpreterPath: interpreter });
            assert.strictEqual(a, b);
            assert.strictEqual(b, c);
        });

        test('case differences in the package name do not change the key', () => {
            const a = computeCacheKey({ dependencies: ['Requests'], interpreterPath: interpreter });
            const b = computeCacheKey({ dependencies: ['requests'], interpreterPath: interpreter });
            assert.strictEqual(a, b);
        });

        test('PEP 503 separator differences in the package name do not change the key', () => {
            const a = computeCacheKey({ dependencies: ['Flask-Login'], interpreterPath: interpreter });
            const b = computeCacheKey({ dependencies: ['flask_login'], interpreterPath: interpreter });
            const c = computeCacheKey({ dependencies: ['flask.login'], interpreterPath: interpreter });
            assert.strictEqual(a, b);
            assert.strictEqual(b, c);
        });

        test('duplicate dependencies after normalization do not change the key', () => {
            const a = computeCacheKey({ dependencies: ['requests'], interpreterPath: interpreter });
            const b = computeCacheKey({ dependencies: ['requests', 'Requests'], interpreterPath: interpreter });
            const c = computeCacheKey({
                dependencies: ['requests', 'requests', 'requests'],
                interpreterPath: interpreter,
            });
            assert.strictEqual(a, b);
            assert.strictEqual(b, c);
        });

        test('empty dependency entries are dropped before hashing', () => {
            const a = computeCacheKey({ dependencies: ['requests'], interpreterPath: interpreter });
            const b = computeCacheKey({
                dependencies: ['requests', '', '   '],
                interpreterPath: interpreter,
            });
            assert.strictEqual(a, b);
        });

        test('adding a dependency changes the key', () => {
            const a = computeCacheKey({ dependencies: ['requests'], interpreterPath: interpreter });
            const b = computeCacheKey({ dependencies: ['requests', 'rich'], interpreterPath: interpreter });
            assert.notStrictEqual(a, b);
        });

        test('removing a dependency changes the key', () => {
            const a = computeCacheKey({ dependencies: ['requests', 'rich'], interpreterPath: interpreter });
            const b = computeCacheKey({ dependencies: ['requests'], interpreterPath: interpreter });
            assert.notStrictEqual(a, b);
        });

        test('changing a version pin changes the key', () => {
            const a = computeCacheKey({ dependencies: ['requests<3'], interpreterPath: interpreter });
            const b = computeCacheKey({ dependencies: ['requests<4'], interpreterPath: interpreter });
            assert.notStrictEqual(a, b);
        });

        test('changing the interpreter path changes the key', () => {
            const a = computeCacheKey({ dependencies: ['requests'], interpreterPath: '/usr/bin/python3' });
            const b = computeCacheKey({ dependencies: ['requests'], interpreterPath: '/opt/python/python3' });
            assert.notStrictEqual(a, b);
        });

        test('empty dependency list is valid and deterministic', () => {
            const a = computeCacheKey({ dependencies: [], interpreterPath: interpreter });
            const b = computeCacheKey({ dependencies: [], interpreterPath: interpreter });
            assert.strictEqual(a, b);
            assert.match(a, /^[0-9a-f]+$/);
            assert.strictEqual(a.length, CACHE_KEY_HEX_LENGTH);
        });

        test('on Windows, path case and separator style do not change the key', () => {
            isWindowsStub.restore();
            isWindowsStub = sinon.stub(platformUtils, 'isWindows').returns(true);
            const a = computeCacheKey({
                dependencies: ['requests'],
                interpreterPath: 'C:\\Python313\\python.exe',
            });
            const b = computeCacheKey({
                dependencies: ['requests'],
                interpreterPath: 'c:/python313/python.exe',
            });
            assert.strictEqual(a, b);
        });

        test('trailing whitespace in interpreter path produces a different key (pinned behavior)', () => {
            // Pinned: callers must hand us a trimmed path. We don't silently
            // trim — that would invalidate every cached env on upgrade.
            const a = computeCacheKey({ dependencies: ['requests'], interpreterPath: '/usr/bin/python3' });
            const b = computeCacheKey({ dependencies: ['requests'], interpreterPath: '/usr/bin/python3 ' });
            assert.notStrictEqual(a, b);
        });

        test('extras order and casing do not change the key', () => {
            // PEP 503 canonicalization is applied to each extra (lowercase,
            // [._-]+ → -), then they are deduped and sorted alphabetically
            // — same canonical form pip / uv use for the project name,
            // applied to each extra. Without this the cache would fragment
            // on a trivial copy-paste edit.
            const a = computeCacheKey({
                dependencies: ['requests[security,socks]'],
                interpreterPath: interpreter,
            });
            const b = computeCacheKey({
                dependencies: ['requests[socks,security]'],
                interpreterPath: interpreter,
            });
            const c = computeCacheKey({
                dependencies: ['requests[Socks,Security]'],
                interpreterPath: interpreter,
            });
            const d = computeCacheKey({
                dependencies: ['requests[socks_5,Security]'],
                interpreterPath: interpreter,
            });
            const dPrime = computeCacheKey({
                dependencies: ['requests[security,SOCKS-5]'],
                interpreterPath: interpreter,
            });
            assert.strictEqual(a, b);
            assert.strictEqual(b, c);
            assert.strictEqual(d, dPrime);
        });

        test('output is filesystem-safe (no special chars)', () => {
            const key = computeCacheKey({ dependencies: ['requests'], interpreterPath: interpreter });
            assert.doesNotMatch(key, /[/\\:*?"<>|]/, 'must not contain reserved filename characters');
        });
    });
});
