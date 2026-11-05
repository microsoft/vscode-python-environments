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
    validatePackedArtifact,
} = require('../scripts/check-extension-version.cjs');

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
