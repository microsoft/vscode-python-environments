export type PythonReleaseLevel = 'alpha' | 'beta' | 'candidate' | 'final';

const VERSION_PATTERN =
    /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:(?:\.(alpha|beta|candidate|final)\.(\d+))|(?:(a|b|rc)(\d+)))?$/i;

const releaseLevelOrder: Record<PythonReleaseLevel, number> = {
    alpha: 0,
    beta: 1,
    candidate: 2,
    final: 3,
};

export class PythonVersion {
    /**
     * Creates a normalized Python release version.
     *
     * Missing minor and patch components are normalized to zero. Python
     * `sys.version_info` suffixes and compact prerelease suffixes are
     * normalized, so `3.14.0.beta.1` and `3.14.0b1` are both represented as
     * `3.14.0b1`.
     *
     * @param version A Python release version.
     */
    constructor(version: string) {
        const match = VERSION_PATTERN.exec(version.trim());
        if (!match) {
            throw new TypeError(`Invalid Python version: ${version}`);
        }

        this.major = parseNumericComponent(match[1], version);
        this.minor = parseNumericComponent(match[2], version);
        this.patch = parseNumericComponent(match[3], version);
        this.releaseLevel = normalizeReleaseLevel(match[4] ?? match[6]);
        this.releaseSerial = parseNumericComponent(match[5] ?? match[7], version);
    }

    readonly major: number;
    readonly minor: number;
    readonly patch: number;
    readonly releaseLevel: PythonReleaseLevel;
    readonly releaseSerial: number;

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
     * Compares this version with another normalized Python version.
     *
     * @param other The version to compare against.
     * @returns A negative number when this version is older, zero when both
     * versions are equal, and a positive number when this version is newer.
     */
    compareTo(other: PythonVersion): number {
        return (
            compareNumbers(this.major, other.major) ||
            compareNumbers(this.minor, other.minor) ||
            compareNumbers(this.patch, other.patch) ||
            compareNumbers(releaseLevelOrder[this.releaseLevel], releaseLevelOrder[other.releaseLevel]) ||
            compareNumbers(this.releaseSerial, other.releaseSerial)
        );
    }

    /** Returns the normalized Python version representation. */
    toString(): string {
        const release = `${this.major}.${this.minor}.${this.patch}`;
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
}

function parseNumericComponent(value: string | undefined, version: string): number {
    const parsed = Number(value ?? 0);
    if (!Number.isSafeInteger(parsed)) {
        throw new TypeError(`Invalid Python version: ${version}`);
    }
    return parsed;
}

function compareNumbers(left: number, right: number): number {
    return left === right ? 0 : left < right ? -1 : 1;
}

function normalizeReleaseLevel(value: string | undefined): PythonReleaseLevel {
    switch (value?.toLowerCase()) {
        case 'a':
        case 'alpha':
            return 'alpha';
        case 'b':
        case 'beta':
            return 'beta';
        case 'rc':
        case 'candidate':
            return 'candidate';
        default:
            return 'final';
    }
}
