// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const semver = require('semver');

const sharedSources = ['api.ts', 'types.ts', 'publicErrors.ts', 'capabilities.ts', 'legacyCapabilities.ts'];

/** Returns the manifest's canonical stable SemVer floor, rejecting ranges and prerelease versions. */
function validateMinimumExtensionVersion(manifest) {
    const version = manifest?.minimumExtensionVersion;
    if (
        typeof version !== 'string' ||
        semver.valid(version) !== version ||
        semver.prerelease(version) !== null ||
        semver.parse(version).build.length !== 0
    ) {
        throw new Error(
            'minimumExtensionVersion must be an exact stable SemVer without a leading v, range, prerelease, or build metadata.',
        );
    }
    return version;
}

/** Checks the packed manifest and both compiled metadata modules without executing package code. */
function validatePackedArtifact(artifact) {
    const read = (entry) =>
        execFileSync('tar', ['-xOf', path.resolve(artifact), `package/${entry}`], { encoding: 'utf8' });
    const manifest = JSON.parse(read('package.json'));
    const minimum = validateMinimumExtensionVersion(manifest);
    for (const [entry, pattern] of [
        ['out/esm/packageMetadata.js', /^export const minimumExtensionVersion = ("[^"\r\n]+");$/m],
        ['out/cjs/packageMetadata.js', /^exports.minimumExtensionVersion = ("[^"\r\n]+");$/m],
    ]) {
        const match = pattern.exec(read(entry).replace(/\r\n/g, '\n'));
        if (!match || JSON.parse(match[1]) !== minimum) {
            throw new Error(
                `${entry} does not match the packed minimumExtensionVersion. Rebuild and retest the package.`,
            );
        }
    }
    return manifest;
}

function main() {
    const { values } = parseArgs({
        options: {
            artifact: { type: 'string' },
            'artifact-directory': { type: 'string' },
        },
    });
    if (values.artifact && values['artifact-directory']) {
        throw new Error('Specify either --artifact or --artifact-directory, not both.');
    }
    let artifact = values.artifact;
    if (values['artifact-directory']) {
        const directory = path.resolve(values['artifact-directory']);
        const tarballs = fs.readdirSync(directory).filter((entry) => entry.endsWith('.tgz'));
        if (tarballs.length !== 1) {
            throw new Error(`Expected exactly one package tarball in ${directory}; found ${tarballs.length}.`);
        }
        artifact = path.join(directory, tarballs[0]);
    }
    const packageRoot = path.resolve(__dirname, '..');
    const manifest = artifact
        ? validatePackedArtifact(artifact)
        : JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const minimum = validateMinimumExtensionVersion(manifest);
    process.stdout.write(`Extension compatibility baseline verified: ${minimum} (declared minimum).\n`);
}

module.exports = {
    sharedSources,
    validateMinimumExtensionVersion,
    validatePackedArtifact,
};

if (require.main === module) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}
