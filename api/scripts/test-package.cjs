// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { fileURLToPath } = require('node:url');

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

try {
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

    const typescriptCli = path.join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    const fixtureRoot = path.join(packageRoot, 'test');

    for (const consumer of [
        { name: 'modern', type: 'module' },
        { name: 'legacy', type: 'commonjs' },
    ]) {
        const consumerRoot = path.join(testRoot, consumer.name);
        fs.mkdirSync(consumerRoot);
        fs.copyFileSync(path.join(fixtureRoot, 'consumer.ts'), path.join(consumerRoot, 'consumer.ts'));
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

    const requireFromConsumer = createRequire(path.join(testRoot, 'legacy', 'consumer.cjs'));
    assert.strictEqual(
        requireFromConsumer.resolve('@vscode/python-environments'),
        path.join(testRoot, 'node_modules', '@vscode', 'python-environments', 'out', 'cjs', 'main.cjs'),
        'CommonJS consumers should resolve the packaged CommonJS entry point',
    );

    const esmEntryPoint = execFileSync(
        process.execPath,
        [
            '--input-type=module',
            '--eval',
            "console.log(import.meta.resolve('@vscode/python-environments'))",
        ],
        {
            cwd: path.join(testRoot, 'modern'),
            encoding: 'utf8',
        },
    ).trim();
    assert.strictEqual(
        fileURLToPath(esmEntryPoint),
        path.join(testRoot, 'node_modules', '@vscode', 'python-environments', 'out', 'esm', 'main.mjs'),
        'ES module consumers should resolve the packaged ES module entry point',
    );
} finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
}
