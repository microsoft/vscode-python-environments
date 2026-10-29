// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { copySources } = require('../scripts/copy-sources.cjs');
const {
    sharedSources,
    validateMinimumExtensionVersion,
    requestGitHub,
    getLatestStableRelease,
    assertLatestStable,
    verifySourceProvenance,
    validatePackedArtifact,
} = require('../scripts/check-extension-version.cjs');

const stable = { tag_name: 'v1.40.0', draft: false, prerelease: false };
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

test('minimum metadata rejects ranges, noncanonical versions, prereleases, and build metadata', () => {
    assert.equal(validateMinimumExtensionVersion({ minimumExtensionVersion: '1.40.0' }), '1.40.0');
    for (const version of [
        undefined,
        null,
        140,
        '',
        '^1.40.0',
        '>=1.40.0',
        'v1.40.0',
        '1.40',
        '01.40.0',
        '1.40.0-rc.1',
        '1.40.0+build',
    ]) {
        assert.throws(
            () => validateMinimumExtensionVersion({ minimumExtensionVersion: version }),
            /exact stable SemVer/,
        );
    }
});

test('staging regenerates the embedded floor after a manifest change and rejects invalid metadata', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'python-api-staging-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
    const packageRoot = path.join(root, 'api');
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(packageRoot, 'runtime'), { recursive: true });
    for (const source of sharedSources) {
        fs.writeFileSync(path.join(root, 'src', source), `${source}\n`);
    }
    fs.writeFileSync(path.join(packageRoot, 'runtime', 'main.ts'), 'npm wrapper\n');
    for (const version of ['1.40.0', '1.42.0']) {
        fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ minimumExtensionVersion: version }));
        copySources(packageRoot);
        assert.ok(
            fs
                .readFileSync(path.join(packageRoot, 'src', 'packageMetadata.ts'), 'utf8')
                .includes(JSON.stringify(version)),
        );
        assert.equal(fs.readFileSync(path.join(packageRoot, 'src', 'main.ts'), 'utf8'), 'npm wrapper\n');
        assert.equal(fs.readFileSync(path.join(packageRoot, 'src', 'api.ts'), 'utf8'), 'api.ts\n');
    }
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ minimumExtensionVersion: '^1.42.0' }));
    assert.throws(() => copySources(packageRoot), /exact stable SemVer/);
});

test('latest stable uses the release tag and rejects invalid release metadata', async () => {
    for (const tag of ['v1.40.0', '1.40.0']) {
        const release = await getLatestStableRelease({
            fetchImpl: async (url) => {
                assert.ok(url.endsWith('/releases/latest'));
                return response({ ...stable, tag_name: tag, target_commitish: 'main' });
            },
        });
        assert.equal(release.version, '1.40.0');
        assertLatestStable({ minimumExtensionVersion: '1.40.0' }, release);
        assert.throws(
            () => assertLatestStable({ minimumExtensionVersion: '1.38.0' }, release),
            /latest stable is 1.40.0/,
        );
        assert.throws(
            () => assertLatestStable({ minimumExtensionVersion: '1.42.0' }, release),
            /latest stable is 1.40.0/,
        );
    }
    for (const invalid of [
        { ...stable, draft: true },
        { ...stable, prerelease: true },
        {},
        { ...stable, tag_name: 'v1.41.0-rc.1' },
    ]) {
        await assert.rejects(getLatestStableRelease({ fetchImpl: async () => response(invalid) }));
    }
});

test('GitHub lookups retry network/server failures, rate limits, and fail closed after exhaustion', async () => {
    const waits = [];
    let attempts = 0;
    const result = await requestGitHub('releases/latest', {
        fetchImpl: async () => {
            attempts += 1;
            if (attempts === 1) {
                throw new TypeError('network unavailable');
            }
            return attempts === 2 ? response({}, 503) : response(stable);
        },
        wait: async (delay) => waits.push(delay),
    });
    assert.deepEqual(result, stable);
    assert.deepEqual(waits, [1000, 2000]);
    for (const status of [429, 403]) {
        attempts = 0;
        await requestGitHub('releases/latest', {
            fetchImpl: async () => (++attempts === 1 ? response({}, status, { 'retry-after': '1' }) : response(stable)),
            wait: async () => {},
        });
        assert.equal(attempts, 2);
    }
    attempts = 0;
    await assert.rejects(
        requestGitHub('releases/latest', {
            fetchImpl: async () => {
                attempts += 1;
                return response({}, 503);
            },
            wait: async () => {},
        }),
        /GitHub lookup failed \(503\)/,
    );
    assert.equal(attempts, 3);
    attempts = 0;
    await assert.rejects(
        requestGitHub('releases/latest', {
            fetchImpl: async () => {
                attempts += 1;
                return response({}, 404);
            },
        }),
        /GitHub lookup failed \(404\)/,
    );
    assert.equal(attempts, 1);
});

test('provenance follows annotated tags to an immutable commit and checks original and staged sources', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'python-api-provenance-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
    const packageRoot = path.join(root, 'api');
    const sha = 'a'.repeat(40);
    const tagSha = 'b'.repeat(40);
    for (const directory of [path.join(root, 'src'), path.join(packageRoot, 'src')]) {
        fs.mkdirSync(directory, { recursive: true });
        for (const source of sharedSources) {
            fs.writeFileSync(path.join(directory, source), `${source}\r\n`);
        }
    }
    const options = {
        fetchImpl: async (url) => {
            if (url.includes('/git/ref/tags/')) {
                return response({ object: { type: 'tag', sha: tagSha } });
            }
            if (url.endsWith(`/git/tags/${tagSha}`)) {
                return response({ object: { type: 'commit', sha } });
            }
            assert.equal(new URL(url).searchParams.get('ref'), sha);
            const source = new URL(url).pathname.split('/').pop();
            return response({ encoding: 'base64', content: Buffer.from(`${source}\n`).toString('base64') });
        },
    };
    const release = { tag: stable.tag_name };
    await verifySourceProvenance(packageRoot, release, options);
    for (const directory of [path.join(root, 'src'), path.join(packageRoot, 'src')]) {
        const file = path.join(directory, 'types.ts');
        fs.writeFileSync(file, 'unreleased contract\n');
        await assert.rejects(verifySourceProvenance(packageRoot, release, options), /differs from v1.40.0/);
        fs.writeFileSync(file, 'types.ts\n');
    }
    await assert.rejects(
        verifySourceProvenance(packageRoot, release, {
            fetchImpl: async () => response({ object: { type: 'tree', sha } }),
        }),
        /immutable release commit/,
    );
});

test('packed artifact validation detects a manifest/compiled-floor mismatch in either runtime format', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'python-api-artifact-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
    const packageRoot = path.join(root, 'package');
    fs.mkdirSync(path.join(packageRoot, 'out', 'esm'), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, 'out', 'cjs'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ minimumExtensionVersion: '1.40.0' }));
    const artifact = path.join(root, 'test.tgz');
    for (const mismatch of [undefined, 'esm', 'cjs']) {
        for (const format of ['esm', 'cjs']) {
            const version = mismatch === format ? '1.38.0' : '1.40.0';
            const prefix = format === 'esm' ? 'export const ' : 'exports.';
            fs.writeFileSync(
                path.join(packageRoot, 'out', format, 'packageMetadata.js'),
                `${prefix}minimumExtensionVersion = ${JSON.stringify(version)};\n`,
            );
        }
        execFileSync('tar', ['-czf', artifact, '-C', root, 'package']);
        if (mismatch) {
            assert.throws(() => validatePackedArtifact(artifact), /does not match the packed minimumExtensionVersion/);
        } else {
            assert.equal(validatePackedArtifact(artifact).minimumExtensionVersion, '1.40.0');
        }
    }
});
