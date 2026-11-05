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

/** Reads public GitHub endpoints without credentials, retrying transient failures only. */
async function requestGitHub(resource, { fetchImpl = fetch, wait = sleep, method = 'GET', redirect = 'follow' } = {}) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        let response;
        try {
            response = await fetchImpl(resource, {
                method,
                redirect,
                headers: {
                    'User-Agent': 'python-environments-api-release-check',
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
            return response;
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

/** Checks shared API syntax against the declared release, ignoring comments and formatting. */
async function verifySourceProvenance(packageRoot, minimum, options = {}) {
    validateMinimumExtensionVersion({ minimumExtensionVersion: minimum });
    const tag = `v${minimum}`;
    await requestGitHub(`https://github.com/${repository}/releases/tag/${tag}`, {
        ...options,
        method: 'HEAD',
        redirect: 'error',
    });
    const tagRef = `refs/tags/${tag}`;
    const output = (options.execFileSyncImpl ?? execFileSync)(
        'git',
        ['ls-remote', '--tags', `https://github.com/${repository}.git`, tagRef, `${tagRef}^{}`],
        { encoding: 'utf8', timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    );
    const refs = new Map(
        output
            .trim()
            .split(/\r?\n/)
            .map((line) => {
                const [sha, ref] = line.split(/\s+/);
                return [ref, sha];
            }),
    );
    const commit = refs.get(`${tagRef}^{}`) ?? refs.get(tagRef);
    if (!/^[a-f0-9]{40}$/.test(commit)) {
        throw new Error(`Cannot resolve ${tag} to an immutable release commit.`);
    }
    const ts = require('typescript');
    const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
    const normalize = (contents, fileName) => {
        const source = ts.createSourceFile(fileName, contents, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
        if (source.parseDiagnostics.length) {
            throw new Error(`Cannot parse API source ${fileName} for comparison with ${tag}.`);
        }
        // Printing makes automatic semicolon insertion explicit; parsed tokens retain literal contents.
        const printed = ts.createSourceFile(
            fileName,
            printer.printFile(source),
            ts.ScriptTarget.Latest,
            false,
            ts.ScriptKind.TS,
        );
        const tokens = [];
        const visit = (node) => {
            const children = node.getChildren(printed);
            if (children.length) {
                children.forEach(visit);
            } else {
                tokens.push([node.kind, node.getText(printed)]);
            }
        };
        visit(printed);
        return JSON.stringify(tokens);
    };
    for (const source of sharedSources) {
        const remote = await requestGitHub(
            `https://raw.githubusercontent.com/${repository}/${commit}/src/${source}`,
            options,
        );
        const released = normalize(await remote.text(), source);
        for (const local of [path.join(packageRoot, '..', 'src', source), path.join(packageRoot, 'src', source)]) {
            if (normalize(fs.readFileSync(local, 'utf8'), source) !== released) {
                throw new Error(
                    `${local} differs from the declared baseline ${tag} (${commit}). Select a released extension containing these API sources and rebuild.`,
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
    const minimum = validateMinimumExtensionVersion(manifest);
    if (values.provenance) {
        await verifySourceProvenance(packageRoot, minimum);
    }
    process.stdout.write(`Extension compatibility baseline verified: ${minimum} (declared minimum).\n`);
}

module.exports = {
    sharedSources,
    validateMinimumExtensionVersion,
    requestGitHub,
    verifySourceProvenance,
    validatePackedArtifact,
};

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
