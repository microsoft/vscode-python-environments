// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { checkDocsCoverage } = require('./verify-docs-coverage.cjs');

test('all exported symbols documented in the doc', () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-coverage-'));
    try {
        const srcDir = path.join(testRoot, 'src');
        const docsDir = path.join(testRoot, 'docs');
        fs.mkdirSync(srcDir, { recursive: true });
        fs.mkdirSync(docsDir, { recursive: true });

        fs.writeFileSync(
            path.join(srcDir, 'api.ts'),
            'export const API_VERSION = "1.0";\nexport namespace Api { export function call() {} }\n'
        );
        fs.writeFileSync(
            path.join(srcDir, 'types.ts'),
            'export interface Config { name: string; }\n'
        );
        fs.writeFileSync(
            path.join(srcDir, 'publicErrors.ts'),
            'export class CustomError extends Error {}\n'
        );
        fs.writeFileSync(
            path.join(docsDir, 'README.md'),
            'API_VERSION, Api, Config, CustomError'
        );

        const undocumented = checkDocsCoverage({ repoRoot: testRoot });
        assert.strictEqual(undocumented.length, 0, 'All symbols should be documented');
    } finally {
        fs.rmSync(testRoot, { recursive: true, force: true });
    }
});

test('undocumented symbols are detected', () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-coverage-'));
    try {
        const srcDir = path.join(testRoot, 'src');
        const docsDir = path.join(testRoot, 'docs');
        fs.mkdirSync(srcDir, { recursive: true });
        fs.mkdirSync(docsDir, { recursive: true });

        fs.writeFileSync(
            path.join(srcDir, 'api.ts'),
            'export const DOCUMENTED = "yes";\nexport const MISSING = "no";\n'
        );
        fs.writeFileSync(
            path.join(srcDir, 'types.ts'),
            ''
        );
        fs.writeFileSync(
            path.join(srcDir, 'publicErrors.ts'),
            ''
        );
        fs.writeFileSync(
            path.join(docsDir, 'README.md'),
            'DOCUMENTED'
        );

        const undocumented = checkDocsCoverage({ repoRoot: testRoot });
        assert.strictEqual(undocumented.length, 1, 'Should find one undocumented symbol');
        assert.strictEqual(undocumented[0].name, 'MISSING');
        assert.strictEqual(undocumented[0].file, 'src/api.ts');
    } finally {
        fs.rmSync(testRoot, { recursive: true, force: true });
    }
});

test('barrel re-exports are skipped', () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-coverage-'));
    try {
        const srcDir = path.join(testRoot, 'src');
        const docsDir = path.join(testRoot, 'docs');
        fs.mkdirSync(srcDir, { recursive: true });
        fs.mkdirSync(docsDir, { recursive: true });

        fs.writeFileSync(
            path.join(srcDir, 'api.ts'),
            'export * from "./types.js";\nexport type { SomeType } from "pkg";\n'
        );
        fs.writeFileSync(
            path.join(srcDir, 'types.ts'),
            ''
        );
        fs.writeFileSync(
            path.join(srcDir, 'publicErrors.ts'),
            ''
        );
        fs.writeFileSync(
            path.join(docsDir, 'README.md'),
            ''
        );

        const undocumented = checkDocsCoverage({ repoRoot: testRoot });
        assert.strictEqual(undocumented.length, 0, 'Barrel re-exports should not be checked');
    } finally {
        fs.rmSync(testRoot, { recursive: true, force: true });
    }
});

test('symbols across multiple files are all checked', () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-coverage-'));
    try {
        const srcDir = path.join(testRoot, 'src');
        const docsDir = path.join(testRoot, 'docs');
        fs.mkdirSync(srcDir, { recursive: true });
        fs.mkdirSync(docsDir, { recursive: true });

        fs.writeFileSync(
            path.join(srcDir, 'api.ts'),
            'export const Api = {};\n'
        );
        fs.writeFileSync(
            path.join(srcDir, 'types.ts'),
            'export interface Type1 {}\nexport type Type2 = string;\n'
        );
        fs.writeFileSync(
            path.join(srcDir, 'publicErrors.ts'),
            'export class Error1 extends Error {}\nexport function isError1(e: any): e is Error1 { return false; }\n'
        );
        fs.writeFileSync(
            path.join(docsDir, 'README.md'),
            'Api Type1 Type2 Error1 isError1'
        );

        const undocumented = checkDocsCoverage({ repoRoot: testRoot });
        assert.strictEqual(undocumented.length, 0, 'All 5 symbols should be documented');
    } finally {
        fs.rmSync(testRoot, { recursive: true, force: true });
    }
});

test('live smoke test: current repo passes', { timeout: 5000 }, () => {
    const repoRoot = path.resolve(__dirname, '../..');
    const undocumented = checkDocsCoverage({ repoRoot });
    assert.strictEqual(undocumented.length, 0, `Regression: undocumented symbols found:\n${undocumented.map(s => `  ${s.file}:${s.line} — ${s.name}`).join('\n')}`);
});
