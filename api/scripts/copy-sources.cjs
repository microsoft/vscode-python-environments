// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

// Repopulates the package's generated `src` sources from the single sources of
// truth in `../src`. These files are gitignored and are removed by the
// `git clean -xfd .` step in `all:publish`, so they must be copied back before
// TypeScript can compile. Mirrors the copy step in build/azure-pipeline.npm.yml.

const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(packageRoot, '..');
const srcDir = path.join(packageRoot, 'src');

const sources = [
    { from: path.join(repoRoot, 'src', 'api.ts'), to: path.join(srcDir, 'main.ts') },
    { from: path.join(repoRoot, 'src', 'types.ts'), to: path.join(srcDir, 'types.ts') },
    { from: path.join(repoRoot, 'src', 'publicErrors.ts'), to: path.join(srcDir, 'publicErrors.ts') },
];

fs.mkdirSync(srcDir, { recursive: true });
for (const { from, to } of sources) {
    fs.copyFileSync(from, to);
}
