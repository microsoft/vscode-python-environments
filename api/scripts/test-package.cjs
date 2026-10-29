// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { fileURLToPath } = require('node:url');
const semver = require('semver');
const { validatePackedArtifact } = require('./check-extension-version.cjs');

const packageRoot = path.resolve(__dirname, '..');
const npmCli = process.env.npm_execpath;

if (!npmCli) {
    throw new Error('npm_execpath is unavailable. Run this validation through npm run test:package.');
}

function runNodeScript(script, args, cwd, captureOutput = false) {
    return execFileSync(process.execPath, [script, ...args], {
        cwd,
        encoding: 'utf8',
        stdio: captureOutput ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
}

const packOutput = runNodeScript(npmCli, ['pack', '--ignore-scripts', '--json'], packageRoot, true);
const packResult = JSON.parse(packOutput);
assert.strictEqual(packResult.length, 1, 'Expected npm pack to produce exactly one package');

const tarballPath = path.join(packageRoot, packResult[0].filename);
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'python-environments-api-'));

function canonicalPath(value) {
    return fs.realpathSync.native(path.resolve(value));
}

try {
    const packedManifest = validatePackedArtifact(tarballPath);
    const sourceManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    assert.strictEqual(packedManifest.minimumExtensionVersion, sourceManifest.minimumExtensionVersion);
    fs.writeFileSync(
        path.join(testRoot, 'package.json'),
        JSON.stringify({ name: 'python-environments-api-consumer', private: true }),
    );

    runNodeScript(
        npmCli,
        [
            'install',
            '--ignore-scripts',
            '--no-package-lock',
            '--no-save',
            tarballPath,
            '@types/node@^22.0.0',
            '@types/vscode@^1.99.0',
        ],
        testRoot,
    );

    const packageRequire = createRequire(path.join(packageRoot, 'package.json'));
    const typescriptCli = packageRequire.resolve('typescript/bin/tsc');
    const fixtureRoot = path.join(packageRoot, 'test');

    for (const consumer of [
        { name: 'modern', type: 'module' },
        { name: 'legacy', type: 'commonjs' },
    ]) {
        const consumerRoot = path.join(testRoot, consumer.name);
        fs.mkdirSync(consumerRoot);
        fs.copyFileSync(path.join(fixtureRoot, 'consumer.ts'), path.join(consumerRoot, 'consumer.ts'));
        fs.copyFileSync(path.join(fixtureRoot, 'runtime-check.cjs'), path.join(consumerRoot, 'runtime-check.cjs'));
        fs.copyFileSync(
            path.join(fixtureRoot, `tsconfig.${consumer.name}.json`),
            path.join(consumerRoot, 'tsconfig.json'),
        );
        fs.writeFileSync(
            path.join(consumerRoot, 'package.json'),
            JSON.stringify({ private: true, type: consumer.type }),
        );

        runNodeScript(typescriptCli, ['--project', path.join(consumerRoot, 'tsconfig.json')], packageRoot);
    }

    const installedPackageRoot = path.join(testRoot, 'node_modules', '@vscode', 'python-environments');
    const vscodeStubRoot = path.join(testRoot, 'node_modules', 'vscode');
    fs.mkdirSync(vscodeStubRoot, { recursive: true });
    fs.writeFileSync(path.join(vscodeStubRoot, 'package.json'), JSON.stringify({ main: 'index.js' }));
    fs.copyFileSync(path.join(fixtureRoot, 'vscode-stub.cjs'), path.join(vscodeStubRoot, 'index.js'));
    const installedPackageJson = JSON.parse(fs.readFileSync(path.join(installedPackageRoot, 'package.json'), 'utf8'));
    assert.strictEqual(installedPackageJson.main, './out/cjs/main.cjs');
    assert.strictEqual(installedPackageJson.types, './out/types/main.d.ts');
    assert.deepStrictEqual(installedPackageJson.exports, {
        import: {
            types: './out/types/main.d.ts',
            default: './out/esm/main.mjs',
        },
        require: {
            types: './out/types/main.d.ts',
            default: './out/cjs/main.cjs',
        },
    });

    for (const target of [
        installedPackageJson.main,
        installedPackageJson.types,
        installedPackageJson.exports.import.types,
        installedPackageJson.exports.import.default,
        installedPackageJson.exports.require.types,
        installedPackageJson.exports.require.default,
    ]) {
        assert.ok(fs.statSync(path.resolve(installedPackageRoot, target)).isFile(), `${target} must be a file`);
    }
    for (const runtimeOutput of ['esm', 'cjs']) {
        const runtimeOutputRoot = path.join(installedPackageRoot, 'out', runtimeOutput);
        const duplicateDeclarations = fs
            .readdirSync(runtimeOutputRoot, { recursive: true })
            .filter((entry) => entry.endsWith('.d.ts'));
        assert.deepStrictEqual(
            duplicateDeclarations,
            [],
            `${runtimeOutputRoot} must not contain declaration files: ${duplicateDeclarations.join(', ')}`,
        );
    }

    const requireFromConsumer = createRequire(path.join(testRoot, 'legacy', 'consumer.cjs'));
    const commonJsModule = requireFromConsumer('@vscode/python-environments');
    assert.strictEqual(
        typeof commonJsModule.PythonEnvironments.api,
        'function',
        'CommonJS consumers should load the package runtime facade',
    );
    assert.strictEqual(
        canonicalPath(requireFromConsumer.resolve('@vscode/python-environments')),
        canonicalPath(path.join(installedPackageRoot, installedPackageJson.exports.require.default)),
        'CommonJS consumers should resolve the packaged CommonJS entry point',
    );

    const esmModuleCheck = execFileSync(
        process.execPath,
        [
            '--input-type=module',
            '--eval',
            "const packageModule = await import('@vscode/python-environments'); if (typeof packageModule.PythonEnvironments.api !== 'function') process.exit(1); process.stdout.write(import.meta.resolve('@vscode/python-environments'));",
        ],
        {
            cwd: path.join(testRoot, 'modern'),
            encoding: 'utf8',
        },
    ).trim();
    assert.strictEqual(
        canonicalPath(fileURLToPath(esmModuleCheck)),
        canonicalPath(path.join(installedPackageRoot, installedPackageJson.exports.import.default)),
        'ES module consumers should load the packaged runtime facade',
    );
    const minimum = packedManifest.minimumExtensionVersion;
    const below = `${minimum}-rc.1`;
    const next = semver.inc(minimum, 'minor');
    const numericBelow = semver.minor(minimum) >= 10 ? `${semver.major(minimum)}.9.0` : below;
    const scenarios = [
        { version: minimum },
        { version: semver.inc(minimum, 'patch') },
        { version: `${minimum}+build.1` },
        { version: next },
        { version: `${next}-rc.1` },
        { version: below, error: 'requires version', incompatible: true },
        { version: numericBelow, error: 'requires version', incompatible: true },
        { version: 'not-a-version', error: 'Cannot verify', incompatible: true },
        { version: null, error: 'Cannot verify', incompatible: true },
        { error: 'Cannot verify', incompatible: true },
        { version: minimum, missing: true, error: 'not installed or is disabled' },
        { version: minimum, activationError: true, error: 'activation failed' },
        { version: minimum, noApi: true, error: 'did not expose its API' },
    ];
    for (const format of ['legacy', 'modern']) {
        for (const active of [false, true]) {
            for (const scenario of scenarios.filter((entry) => !active || !entry.activationError)) {
                execFileSync(process.execPath, [path.join(testRoot, format, 'runtime-check.cjs')], {
                    cwd: path.join(testRoot, format),
                    encoding: 'utf8',
                    stdio: 'inherit',
                    env: {
                        ...process.env,
                        API_TEST_FORMAT: format,
                        API_TEST_SCENARIO: JSON.stringify({ ...scenario, active, minimum }),
                    },
                });
            }
        }
    }
    process.stdout.write('Packed ESM/CommonJS compatibility and consumer checks passed.\n');
} finally {
    fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
