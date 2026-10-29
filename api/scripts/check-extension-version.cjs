// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { setTimeout: sleep } = require('node:timers/promises');
const semver = require('semver');

const repository = 'microsoft/vscode-python-environments';
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

/** Reads public repository metadata with bounded retries for transient failures only. */
async function requestGitHub(resource, { fetchImpl = fetch, token = process.env.GITHUB_TOKEN, wait = sleep } = {}) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        let response;
        try {
            response = await fetchImpl(`https://api.github.com/repos/${repository}/${resource}`, {
                headers: {
                    Accept: 'application/vnd.github+json',
                    'User-Agent': 'python-environments-api-release-check',
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                signal: AbortSignal.timeout(15000),
            });
        } catch (error) {
            if (
                attempt === 2 ||
                !(error instanceof TypeError || error.name === 'AbortError' || error.name === 'TimeoutError')
            ) {
                throw error;
            }
            await wait(1000 * 2 ** attempt);
            continue;
        }
        if (response.ok) {
            return response.json();
        }
        const retryable =
            response.status === 429 ||
            response.status >= 500 ||
            (response.status === 403 &&
                (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')));
        if (!retryable || attempt === 2) {
            throw new Error(
                `GitHub lookup failed (${response.status}) for ${resource}. Retry the check after resolving the lookup failure.`,
            );
        }
        const retryAfter = Number(response.headers.get('retry-after'));
        await wait(Math.min(10000, Math.max(1000 * 2 ** attempt, retryAfter * 1000 || 0)));
    }
}

/** Resolves GitHub's designated latest stable release, not the development manifest or preview channel. */
async function getLatestStableRelease(options) {
    const release = await requestGitHub('releases/latest', options);
    if (release?.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string') {
        throw new Error('GitHub did not return a valid latest stable extension release.');
    }
    const version = validateMinimumExtensionVersion({ minimumExtensionVersion: release.tag_name.replace(/^v/, '') });
    return {
        version,
        tag: release.tag_name,
        url: `https://github.com/${repository}/releases/tag/${encodeURIComponent(release.tag_name)}`,
    };
}

/** Enforces the new-npm-release policy without modifying already-published package metadata. */
function assertLatestStable(manifest, release) {
    const minimum = validateMinimumExtensionVersion(manifest);
    if (minimum !== release.version) {
        throw new Error(
            `minimumExtensionVersion is ${minimum}; latest stable is ${release.version} (${release.url}). Update api/package.json, rebuild, and rerun validation.`,
        );
    }
}

/** Rejects unreleased shared API sources, including stale staged copies, at packaging time. */
async function verifySourceProvenance(packageRoot, release, options) {
    let object = (await requestGitHub(`git/ref/tags/${encodeURIComponent(release.tag)}`, options)).object;
    for (let depth = 0; object?.type === 'tag' && depth < 5; depth += 1) {
        object = (await requestGitHub(`git/tags/${object.sha}`, options)).object;
    }
    if (object?.type !== 'commit' || !/^[a-f0-9]{40}$/.test(object.sha)) {
        throw new Error(`Cannot resolve ${release.tag} to an immutable release commit.`);
    }
    const normalize = (contents) => contents.replace(/\r\n/g, '\n');
    for (const source of sharedSources) {
        const remote = await requestGitHub(`contents/src/${source}?ref=${object.sha}`, options);
        if (remote.encoding !== 'base64' || typeof remote.content !== 'string') {
            throw new Error(`Cannot read released API source src/${source} at ${object.sha}.`);
        }
        const released = normalize(Buffer.from(remote.content, 'base64').toString('utf8'));
        for (const local of [path.join(packageRoot, '..', 'src', source), path.join(packageRoot, 'src', source)]) {
            if (normalize(fs.readFileSync(local, 'utf8')) !== released) {
                throw new Error(
                    `${local} differs from ${release.tag} (${object.sha}). Publish the stable extension containing these API sources, then update the npm baseline and rebuild.`,
                );
            }
        }
    }
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

async function main() {
    const { values } = parseArgs({
        options: {
            provenance: { type: 'boolean', default: false },
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
    validateMinimumExtensionVersion(manifest);
    const release = await getLatestStableRelease();
    assertLatestStable(manifest, release);
    if (values.provenance) {
        await verifySourceProvenance(packageRoot, release);
    }
    process.stdout.write(`Extension compatibility baseline verified: ${release.version} (${release.url}).\n`);
}

module.exports = {
    sharedSources,
    validateMinimumExtensionVersion,
    requestGitHub,
    getLatestStableRelease,
    assertLatestStable,
    verifySourceProvenance,
    validatePackedArtifact,
};

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
