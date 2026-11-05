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
    verifySourceProvenance,
    validatePackedArtifact,
} = require('../scripts/check-extension-version.cjs');

const stable = { tag_name: 'v1.40.0', draft: false, prerelease: false };
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const validator = path.join(__dirname, '..', 'scripts', 'check-extension-version.cjs');
const offlineGuard = `data:text/javascript,${encodeURIComponent(
    'globalThis.fetch = () => { throw new Error("Release metadata validation must not access the network"); };',
)}`;

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

test('ordinary release validation accepts the declared minimum without a network lookup', () => {
    const output = execFileSync(process.execPath, ['--import', offlineGuard, validator], { encoding: 'utf8' });
    assert.match(output, /Extension compatibility baseline verified: .* \(declared minimum\)/);
});

test('GitHub lookups retry network/server failures, rate limits, and fail closed after exhaustion', async () => {
    const waits = [];
    let attempts = 0;
    const result = await requestGitHub('https://github.com/microsoft/vscode-python-environments/releases/tag/v1.40.0', {
        fetchImpl: async () => {
            attempts += 1;
            if (attempts === 1) {
                throw new TypeError('network unavailable');
            }
            return attempts === 2 ? response({}, 503) : response(stable);
        },
        wait: async (delay) => waits.push(delay),
    });
    assert.deepEqual(await result.json(), stable);
    assert.deepEqual(waits, [1000, 2000]);
    for (const status of [429, 403]) {
        attempts = 0;
        await requestGitHub('https://github.com/microsoft/vscode-python-environments/releases/tag/v1.40.0', {
            fetchImpl: async () => (++attempts === 1 ? response({}, status, { 'retry-after': '1' }) : response(stable)),
            wait: async () => {},
        });
        assert.equal(attempts, 2);
    }
    attempts = 0;
    await assert.rejects(
        requestGitHub('https://github.com/microsoft/vscode-python-environments/releases/tag/v1.40.0', {
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
        requestGitHub('https://github.com/microsoft/vscode-python-environments/releases/tag/v1.40.0', {
            fetchImpl: async () => {
                attempts += 1;
                return response({}, 404);
            },
        }),
        /GitHub lookup failed \(404\)/,
    );
    assert.equal(attempts, 1);
});

test('release provenance pins the declared baseline and ignores only source trivia', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'python-api-provenance-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
    const packageRoot = path.join(root, 'api');
    const sha = 'a'.repeat(40);
    const tagSha = 'b'.repeat(40);
    const releasedSource =
        'export interface Api { id: string; }\nexport function createApi() { return { id: "value" }; }\nexport const pattern = /a b/;\nexport const message = `id ${1} a b`;\n';
    for (const directory of [path.join(root, 'src'), path.join(packageRoot, 'src')]) {
        fs.mkdirSync(directory, { recursive: true });
        for (const source of sharedSources) {
            fs.writeFileSync(path.join(directory, source), releasedSource.replace(/\n/g, '\r\n'));
        }
    }
    const options = {
        execFileSyncImpl: (command, args) => {
            assert.equal(command, 'git');
            assert.deepEqual(args.slice(-2), [`refs/tags/${stable.tag_name}`, `refs/tags/${stable.tag_name}^{}`]);
            return `${tagSha}\trefs/tags/${stable.tag_name}\n${sha}\trefs/tags/${stable.tag_name}^{}\n`;
        },
        fetchImpl: async (url, request) => {
            if (url === `https://github.com/microsoft/vscode-python-environments/releases/tag/${stable.tag_name}`) {
                assert.equal(request.method, 'HEAD');
                assert.equal(request.redirect, 'error');
                assert.equal(request.headers.Authorization, undefined);
                return new Response(null);
            }
            assert.ok(
                url.startsWith(`https://raw.githubusercontent.com/microsoft/vscode-python-environments/${sha}/src/`),
            );
            return new Response(releasedSource);
        },
    };
    const minimum = '1.40.0';
    await verifySourceProvenance(packageRoot, minimum, options);
    await verifySourceProvenance(packageRoot, minimum, {
        ...options,
        execFileSyncImpl: () => `${sha}\trefs/tags/${stable.tag_name}\n`,
    });
    for (const directory of [path.join(root, 'src'), path.join(packageRoot, 'src')]) {
        const file = path.join(directory, 'types.ts');
        fs.writeFileSync(
            file,
            releasedSource
                .replace(
                    'export interface Api { id: string; }',
                    '// Updated documentation\n\nexport interface Api {\n    id: string;\n}',
                )
                .replace(
                    'export function createApi() { return { id: "value" }; }',
                    'export function createApi() {\n    return { id: "value" };\n}',
                )
                .replace(/\n/g, '\r\n'),
        );
        await verifySourceProvenance(packageRoot, minimum, options);
        for (const changed of [
            releasedSource.replace('id: string', 'id: number'),
            releasedSource.replace('return {', 'return\n{'),
            releasedSource.replace('/a b/', '/a  b/'),
            releasedSource.replace('`id ${1} a b`', '`id ${1} a  b`'),
        ]) {
            fs.writeFileSync(file, changed);
            await assert.rejects(
                verifySourceProvenance(packageRoot, minimum, options),
                /differs from the declared baseline v1.40.0/,
            );
        }
        fs.writeFileSync(file, releasedSource);
    }
    await assert.rejects(
        verifySourceProvenance(packageRoot, minimum, {
            ...options,
            execFileSyncImpl: () => `${sha}\trefs/tags/unrelated\n`,
        }),
        /immutable release commit/,
    );
    await assert.rejects(
        verifySourceProvenance(packageRoot, minimum, {
            ...options,
            fetchImpl: async () => response({}, 404),
        }),
        /GitHub lookup failed \(404\)/,
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
            for (const args of [
                ['--artifact', artifact],
                ['--artifact-directory', root],
            ]) {
                const output = execFileSync(process.execPath, ['--import', offlineGuard, validator, ...args], {
                    encoding: 'utf8',
                });
                assert.match(output, /verified: 1.40.0 \(declared minimum\)/);
            }
        }
    }
});
