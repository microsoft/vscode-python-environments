type PythonReleaseLevel = 'alpha' | 'beta' | 'candidate' | 'final';

/** Release levels from oldest to newest; the index of a level is its rank. */
const RELEASE_LEVELS: readonly PythonReleaseLevel[] = ['alpha', 'beta', 'candidate', 'final'];

/**
 * Maps the abbreviated spellings onto the release level they name.
 *
 * Python reports `alpha`, `beta`, and `candidate`, while version strings
 * abbreviate them as `a`, `b`, and `rc`. A release candidate may also be
 * spelled `c`, `pre`, or `preview`.
 */
const RELEASE_LEVEL_ALIASES: Readonly<Record<string, PythonReleaseLevel>> = {
    a: 'alpha',
    b: 'beta',
    rc: 'candidate',
    c: 'candidate',
    pre: 'candidate',
    preview: 'candidate',
};

/**
 * Matches a release, optionally followed by a prerelease level and serial.
 *
 * Every spelling of a level is accepted in one alternation, so the dotted
 * `sys.version_info` form and the compact and separated forms differ only in
 * their optional `.`, `-`, or `_` separators. Longer spellings precede the
 * abbreviations they start with, so `alpha` wins over `a`.
 */
const VERSION_PATTERN =
    /^(?<major>\d+)(?:\.(?<minor>\d+))?(?:\.(?<patch>\d+))?(?:[._-]?(?<level>alpha|beta|candidate|final|preview|pre|rc|a|b|c)[._-]?(?<serial>\d+))?$/i;

/**
 * A Python interpreter release, such as `3.12.4` or `3.14.0rc1`.
 *
 * This models the versions Python reports for itself through
 * `sys.version_info`. It deliberately omits the PEP 440 packaging features
 * that interpreters never use, such as epochs, post releases, dev releases,
 * and local version labels; use a dedicated PEP 440 implementation for
 * package versions.
 */
export class PythonVersion {
    /**
     * Creates a normalized Python release version.
     *
     * Missing minor and patch components are normalized to zero. Every
     * spelling of a prerelease is normalized, so `3.14.0.beta.1`,
     * `3.14.0beta1`, `3.14.0-beta-1`, and `3.14.0b1` are all represented as
     * `3.14.0b1`.
     *
     * @param version A Python release version.
     * @throws TypeError When the version cannot be parsed.
     */
    constructor(version: string) {
        const source = version.trim();
        const groups = VERSION_PATTERN.exec(source)?.groups;
        if (!groups) {
            throw new TypeError(`Invalid Python version: ${version}`);
        }

        this.source = source;
        this.precision = groups.patch !== undefined ? 3 : groups.minor !== undefined ? 2 : 1;
        this.major = Number(groups.major);
        this.minor = Number(groups.minor ?? 0);
        this.patch = Number(groups.patch ?? 0);
        this.releaseLevel = toReleaseLevel(groups.level);
        this.releaseSerial = Number(groups.serial ?? 0);
        if (
            ![this.major, this.minor, this.patch, this.releaseSerial].every(Number.isSafeInteger) ||
            (this.releaseLevel === 'final' && this.releaseSerial !== 0)
        ) {
            throw new TypeError(`Invalid Python version: ${version}`);
        }
    }

    readonly major: number;
    readonly minor: number;
    readonly patch: number;
    readonly releaseLevel: PythonReleaseLevel;
    readonly releaseSerial: number;

    /**
     * How many release components were explicitly supplied: `1` for `3`, `2`
     * for `3.12`, and `3` for `3.12.1`. Omitted components are normalized to
     * zero, so this is the only record of how precisely the version was stated.
     */
    readonly precision: number;

    /** The trimmed version exactly as it was supplied, before normalization. */
    readonly source: string;

    /**
     * Attempts to parse a Python version without propagating malformed input errors.
     *
     * @param version The value to parse.
     * @returns A normalized version, or `undefined` when the value is unsupported.
     */
    static tryParse(version: unknown): PythonVersion | undefined {
        if (typeof version !== 'string') {
            return undefined;
        }

        try {
            return new PythonVersion(version);
        } catch {
            return undefined;
        }
    }

    /**
     * Compares this version with another Python version.
     *
     * Prereleases order before the final release of the same numeric release,
     * so `3.14.0rc1` is older than `3.14.0`.
     *
     * @param other The version to compare against.
     * @returns A negative number when this version is older, zero when both
     * versions are equal, and a positive number when this version is newer.
     */
    compareTo(other: PythonVersion): number {
        return (
            this.major - other.major ||
            this.minor - other.minor ||
            this.patch - other.patch ||
            RELEASE_LEVELS.indexOf(this.releaseLevel) - RELEASE_LEVELS.indexOf(other.releaseLevel) ||
            this.releaseSerial - other.releaseSerial
        );
    }

    /**
     * Tests whether this version is selected by a partially specified version.
     *
     * A selector that omits release components matches any version sharing the
     * components it does supply, so `3.12` selects `3.12.11`. A fully specified
     * or prerelease selector must match exactly, so `3.14.0rc1` does not select
     * `3.14.0`.
     *
     * @param selector The requested version.
     * @returns Whether this version satisfies the request.
     */
    matchesSelector(selector: PythonVersion): boolean {
        return selector.precision < 3 && selector.releaseLevel === 'final'
            ? this.matchesReleasePrefix(selector)
            : this.compareTo(selector) === 0;
    }

    /**
     * Reports whether this version shares the leading release components of
     * another version, ignoring any components beyond the compared count.
     *
     * @param other The version supplying the components to compare.
     * @param count How many leading components to compare, defaulting to the
     * number `other` explicitly supplied.
     */
    matchesReleasePrefix(other: PythonVersion, count: number = other.precision): boolean {
        return (
            (count < 1 || this.major === other.major) &&
            (count < 2 || this.minor === other.minor) &&
            (count < 3 || this.patch === other.patch)
        );
    }

    /** Returns the fully normalized version, such as `3.12.4` or `3.14.0rc1`. */
    toString(): string {
        const release = this.toReleaseString(3);
        switch (this.releaseLevel) {
            case 'alpha':
                return `${release}a${this.releaseSerial}`;
            case 'beta':
                return `${release}b${this.releaseSerial}`;
            case 'candidate':
                return `${release}rc${this.releaseSerial}`;
            case 'final':
                return release;
        }
    }

    /**
     * Returns the numeric release components without any prerelease suffix.
     *
     * @param count How many components to emit, defaulting to the number that
     * was explicitly supplied, so `3.12` renders as `3.12` rather than `3.12.0`.
     */
    toReleaseString(count: number = this.precision): string {
        return [this.major, this.minor, this.patch].slice(0, count).join('.');
    }
}

function toReleaseLevel(value: string | undefined): PythonReleaseLevel {
    if (!value) {
        return 'final';
    }
    const normalized = value.toLowerCase();
    return RELEASE_LEVEL_ALIASES[normalized] ?? RELEASE_LEVELS.find((level) => level === normalized) ?? 'final';
}
