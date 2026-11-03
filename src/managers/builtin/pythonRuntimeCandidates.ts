// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { PythonVersion } from '../../common/pythonVersion';
import { PythonVersionSpecifier, splitClause } from '../../common/pythonVersionSpecifier';
import { extractLowerBoundVersion } from '../../common/inlineScript/interpreter';
import { PythonInstallationError, PythonInstallRequest } from './pythonInstallerTypes';
import { listPymanagerRuntimes, PymanagerRuntime } from './pymanagerPythonInstaller';

export type PythonRuntimeArchitecture = 'x64' | 'arm64' | 'ia32';

export interface PymanagerCandidate {
    readonly runtime: PymanagerRuntime;
    readonly version: PythonVersion;
    readonly architecture: PythonRuntimeArchitecture;
    readonly installTag: string;
}

const ARCHITECTURE_SUFFIXES: Readonly<Record<PythonRuntimeArchitecture, string>> = {
    x64: '64',
    arm64: 'arm64',
    ia32: '32',
};
const MAX_RELEASE_COMPONENT = 1000;
const MAX_HISTORY_QUERIES = 64;
const QUERY_BATCH_SIZE = 64;
const HISTORY_TIMEOUT_MS = 120_000;

/** Return the architecture of the extension host, not the PyManager executable or desktop client. */
export function getPythonRuntimeArchitecture(): PythonRuntimeArchitecture {
    switch (process.arch) {
        case 'x64':
        case 'arm64':
        case 'ia32':
            return process.arch;
        default:
            throw new PythonInstallationError('provider-unusable', `Unsupported Python runtime architecture: ${process.arch}`);
    }
}

/** Validate the request before querying a catalogue or prompting for installation. */
export function validatePythonInstallRequest(request: PythonInstallRequest): void {
    if (request.version !== undefined && !PythonVersion.tryParse(request.version)) {
        throw new PythonInstallationError('no-compatible-python', 'Invalid Python version selector.');
    }
    if (request.requiresPython !== undefined && !PythonVersionSpecifier.tryParse(request.requiresPython)) {
        throw new PythonInstallationError('no-compatible-python', 'Invalid requires-python constraint.');
    }
}

/** Test an actual interpreter release, never a PyManager slot ID or tag, against the request. */
export function matchesPythonInstallRequest(version: PythonVersion, request: PythonInstallRequest): boolean {
    const selector = request.version === undefined ? undefined : PythonVersion.tryParse(request.version);
    const specifier =
        request.requiresPython === undefined ? undefined : PythonVersionSpecifier.tryParse(request.requiresPython);
    if (
        version.major !== 3 ||
        (request.version !== undefined && !selector) ||
        (request.requiresPython !== undefined && !specifier) ||
        (selector && !version.matchesSelector(selector)) ||
        (specifier && !specifier.matches(version))
    ) {
        return false;
    }
    return (
        version.releaseLevel === 'final' ||
        specifier !== undefined ||
        (selector !== undefined && selector.releaseLevel !== 'final')
    );
}

/**
 * Prefer the existing inline-script download choices. A derived preference is not an
 * additional constraint: an unavailable lower bound may fall back to another compatible release.
 */
export function getPreferredPythonSelector(requiresPython: string | undefined): string | undefined {
    requiresPython = requiresPython?.trim();
    if (!requiresPython) {
        return undefined;
    }
    const specifier = PythonVersionSpecifier.tryParse(requiresPython);
    if (!specifier) {
        return undefined;
    }
    for (const text of requiresPython.split(',')) {
        const clause = splitClause(text);
        if (clause && ['>=', '==', '~='].includes(clause.operator)) {
            const version = PythonVersion.tryParse(clause.literal);
            if (version && version.releaseLevel !== 'final' && specifier.matches(version)) {
                return version.toString();
            }
        }
    }
    const lowerBound = extractLowerBoundVersion(requiresPython);
    const version = PythonVersion.tryParse(lowerBound);
    if (!version || version.major !== 3 || !specifier.matches(version)) {
        return undefined;
    }
    if (/^>=\s*[^,]+$/.test(requiresPython)) {
        return lowerBound;
    }
    if (/^==\s*[^,*]+$/.test(requiresPython)) {
        return version.toString();
    }
    return undefined;
}

/** Identify a standard CPython runtime without mistaking a tag or an active venv for a base version. */
export function getPymanagerRuntimeVersion(
    runtime: PymanagerRuntime,
    architecture: PythonRuntimeArchitecture = getPythonRuntimeArchitecture(),
): PythonVersion | undefined {
    const version = PythonVersion.tryParse(runtime.version);
    if (
        runtime.company.toLowerCase() !== 'pythoncore' ||
        !version ||
        version.major !== 3 ||
        runtime.executableArgs.length > 0 ||
        !/^\d+\.\d+(?:\.\d+(?:(?:a|b|rc)\d+)?)?(?:-dev)?-(?:64|32|arm64)$/i.test(runtime.tag)
    ) {
        return undefined;
    }
    const suffix = ARCHITECTURE_SUFFIXES[architecture];
    if (!runtime.tag.toLowerCase().endsWith(`-${suffix}`)) {
        return undefined;
    }
    return version;
}

/** Normalize only standard CPython builds with a concrete, advertised installation tag. */
export function toPymanagerCandidate(
    runtime: PymanagerRuntime,
    architecture: PythonRuntimeArchitecture = getPythonRuntimeArchitecture(),
): PymanagerCandidate | undefined {
    const version = getPymanagerRuntimeVersion(runtime, architecture);
    if (!version) {
        return undefined;
    }
    const suffix = ARCHITECTURE_SUFFIXES[architecture];
    const concrete = `${version.toString()}-${suffix}`;
    const tag = runtime.installTags.find((item) => item.toLowerCase() === concrete.toLowerCase());
    if (!tag) {
        return undefined;
    }
    return {
        runtime,
        version,
        architecture,
        installTag: `PythonCore\\${tag}`,
    };
}

/** Normalize and order eligible PyManager catalogue records without assuming their input order. */
export function getPymanagerCandidates(
    runtimes: readonly PymanagerRuntime[],
    architecture: PythonRuntimeArchitecture = getPythonRuntimeArchitecture(),
): PymanagerCandidate[] {
    return runtimes
        .map((runtime) => toPymanagerCandidate(runtime, architecture))
        .filter((candidate): candidate is PymanagerCandidate => candidate !== undefined)
        .sort((a, b) => b.version.compareTo(a.version));
}

/**
 * Resolve a compatible published runtime through PyManager's configured catalogue.
 *
 * Its list command deduplicates slots, and its range filters compare tags rather than actual
 * versions. Historical searches therefore submit bounded batches of exact tags which satisfy
 * our version predicate; only returned, independently validated catalogue records may be installed.
 */
export async function resolvePymanagerCandidate(
    executable: string,
    request: PythonInstallRequest,
    architecture: PythonRuntimeArchitecture = getPythonRuntimeArchitecture(),
): Promise<PymanagerCandidate | undefined> {
    validatePythonInstallRequest(request);
    const suffix = ARCHITECTURE_SUFFIXES[architecture];
    const selector = PythonVersion.tryParse(request.version);
    const preference = request.version === undefined
        ? PythonVersion.tryParse(getPreferredPythonSelector(request.requiresPython))
        : undefined;
    const specifier = request.requiresPython ? PythonVersionSpecifier.tryParse(request.requiresPython) : undefined;
    let queries = 0;
    const started = Date.now();

    const query = async (selectors: readonly string[]): Promise<PymanagerCandidate[]> => {
        if (++queries > MAX_HISTORY_QUERIES || Date.now() - started > HISTORY_TIMEOUT_MS) {
            throw new PythonInstallationError(
                'catalogue-failed',
                'The historical Python catalogue lookup exceeded its bounded search budget.',
            );
        }
        return getPymanagerCandidates(
            await listPymanagerRuntimes(executable, { online: true, selectors }),
            architecture,
        );
    };
    const compatible = (candidate: PymanagerCandidate) => matchesPythonInstallRequest(candidate.version, request);

    if (selector && (selector.precision === 3 || selector.releaseLevel !== 'final')) {
        const candidates = await query([`PythonCore\\${selector.toString()}-${suffix}`]);
        return candidates.find(compatible);
    }

    if (preference) {
        const tag = preference.releaseLevel === 'final' ? preference.toReleaseString() : preference.toString();
        const candidates = await query([`PythonCore\\${tag}-${suffix}`]);
        const preferred = candidates.find((candidate) =>
            candidate.version.matchesSelector(preference) && compatible(candidate));
        if (preferred) {
            return preferred;
        }
    }

    const initialSelectors = selector
        ? [`PythonCore\\${selector.toReleaseString()}-${suffix}`]
        : [];
    const catalogue = await query(initialSelectors);
    const families = new Map<string, PymanagerCandidate>();
    for (const candidate of catalogue) {
        const key = `${candidate.version.major}.${candidate.version.minor}`;
        const previous = families.get(key);
        if (!previous || previous.version.compareTo(candidate.version) < 0) {
            families.set(key, candidate);
        }
    }
    const allowsPrereleases =
        (selector?.releaseLevel !== undefined && selector.releaseLevel !== 'final') ||
        (request.requiresPython?.split(',').some((clause) => {
            const parts = splitClause(clause);
            const bound = PythonVersion.tryParse(parts?.literal);
            return bound !== undefined && bound.releaseLevel !== 'final';
        }) ?? false);
    const clauseVersions = request.requiresPython?.split(',').flatMap((text) => {
        const clause = splitClause(text);
        const version = PythonVersion.tryParse(clause?.literal);
        return version ? [version] : [];
    }) ?? [];

    for (const latest of families.values()) {
        if (compatible(latest)) {
            return latest;
        }
        if (latest.version.patch > MAX_RELEASE_COMPONENT) {
            throw new PythonInstallationError('catalogue-failed', 'The Python catalogue has an unsupported release range.');
        }
        const release = (patch: number) => `${latest.version.major}.${latest.version.minor}.${patch}`;
        const matches = (version: PythonVersion) =>
            version.compareTo(latest.version) <= 0 && matchesPythonInstallRequest(version, request);
        const finalTags: string[] = [];
        for (let patch = latest.version.patch; patch >= 0; patch -= 1) {
            const version = new PythonVersion(release(patch));
            if (matches(version)) {
                finalTags.push(`PythonCore\\${version.toString()}-${suffix}`);
            }
        }
        let best: PymanagerCandidate | undefined;
        for (let index = 0; index < finalTags.length; index += QUERY_BATCH_SIZE) {
            const candidates = await query(finalTags.slice(index, index + QUERY_BATCH_SIZE));
            best = candidates.find(compatible);
            if (best) {
                break;
            }
        }
        if (!allowsPrereleases) {
            if (best) {
                return best;
            }
            continue;
        }

        // A prerelease of a newer patch sorts above an older final release.
        for (let patch = latest.version.patch; patch >= (best?.version.patch ?? 0); patch -= 1) {
            for (const phase of ['rc', 'b', 'a']) {
                const prefix = `${release(patch)}${phase}`;
                const serials = new Set([0, 1]);
                for (const bound of clauseVersions) {
                    serials.add(bound.releaseSerial);
                    if (bound.releaseSerial > 0) {
                        serials.add(bound.releaseSerial - 1);
                    }
                    if (bound.releaseSerial < Number.MAX_SAFE_INTEGER) {
                        serials.add(bound.releaseSerial + 1);
                    }
                }
                const mayMatch = [...serials].some((serial) => {
                    const version = new PythonVersion(`${prefix}${serial}`);
                    return matches(version) && (!best || version.compareTo(best.version) > 0);
                });
                if (!mayMatch) {
                    continue;
                }
                const prefixCandidates = await query([`PythonCore\\${prefix}-${suffix}`]);
                const newest = prefixCandidates.find((candidate) =>
                    candidate.version.major === latest.version.major &&
                    candidate.version.minor === latest.version.minor &&
                    candidate.version.patch === patch &&
                    candidate.version.releaseLevel === new PythonVersion(`${prefix}0`).releaseLevel,
                );
                if (!newest) {
                    continue;
                }
                if (compatible(newest) && (!best || newest.version.compareTo(best.version) > 0)) {
                    best = newest;
                    continue;
                }
                if (newest.version.releaseSerial > MAX_RELEASE_COMPONENT) {
                    throw new PythonInstallationError('catalogue-failed', 'The Python catalogue has an unsupported prerelease range.');
                }
                const tags: string[] = [];
                for (let serial = newest.version.releaseSerial - 1; serial >= 0; serial -= 1) {
                    const version = new PythonVersion(`${prefix}${serial}`);
                    if (matches(version) && (!best || version.compareTo(best.version) > 0)) {
                        tags.push(`PythonCore\\${version.toString()}-${suffix}`);
                    }
                }
                for (let index = 0; index < tags.length; index += QUERY_BATCH_SIZE) {
                    const candidates = await query(tags.slice(index, index + QUERY_BATCH_SIZE));
                    const matched = candidates.find(compatible);
                    if (matched) {
                        best = matched;
                        break;
                    }
                }
            }
        }
        if (best && (!specifier || specifier.matches(best.version))) {
            return best;
        }
    }
    return undefined;
}
