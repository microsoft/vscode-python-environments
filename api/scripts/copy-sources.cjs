// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

// Repopulates the package's generated `src` sources from the single sources of
// truth in `../src`, the npm-only entry point, and the manifest compatibility floor.
// These files are gitignored and regenerated before TypeScript compilation.

const fs = require('node:fs');
const path = require('node:path');
const { sharedSources, validateMinimumExtensionVersion } = require('./check-extension-version.cjs');

/** Regenerates package sources and compatibility metadata from their maintained inputs. */
function copySources(packageRoot) {
    const repoRoot = path.resolve(packageRoot, '..');
    const srcDir = path.join(packageRoot, 'src');
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const minimumExtensionVersion = validateMinimumExtensionVersion(manifest);
    fs.mkdirSync(srcDir, { recursive: true });
    for (const source of sharedSources) {
        fs.copyFileSync(path.join(repoRoot, 'src', source), path.join(srcDir, source));
    }
    fs.copyFileSync(path.join(packageRoot, 'runtime', 'main.ts'), path.join(srcDir, 'main.ts'));
    fs.writeFileSync(
        path.join(srcDir, 'packageMetadata.ts'),
        `// Generated from api/package.json; do not edit.\nexport const minimumExtensionVersion = ${JSON.stringify(minimumExtensionVersion)};\n`,
    );
}

module.exports = { copySources };

if (require.main === module) {
    copySources(path.resolve(__dirname, '..'));
}
