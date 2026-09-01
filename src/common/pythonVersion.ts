type PythonReleaseLevel = 'alpha' | 'beta' | 'candidate' | 'final';

export class PythonVersion {
    private static readonly VERSION_PATTERN =
        /^(?<major>\d+)(?:\.(?<minor>\d+))?(?:\.(?<patch>\d+))?(?:(?:\.(?<longLevel>alpha|beta|candidate|final)\.(?<longSerial>\d+))|(?:(?<shortLevel>a|b|rc)(?<shortSerial>\d+)))?$/i;

    private static readonly WILDCARD_PATTERN = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?\.\*$/;

    private static readonly SPECIFIER_PATTERN = /^(===|~=|==|!=|>=|<=|>|<)\s*(.+)$/;

    private static readonly RELEASE_LEVEL_ALIASES: Readonly<Record<string, PythonReleaseLevel>> = {
        a: 'alpha',
        alpha: 'alpha',
        b: 'beta',
        beta: 'beta',
        rc: 'candidate',
        candidate: 'candidate',
        final: 'final',
    };

    private static readonly RELEASE_LEVEL_ORDER: Readonly<Record<PythonReleaseLevel, number>> = {
        alpha: 0,
        beta: 1,
        candidate: 2,
        final: 3,
    };

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
        const normalizedVersion = version.trim();
        const match = PythonVersion.VERSION_PATTERN.exec(normalizedVersion);
        if (!match) {
            throw new TypeError(`Invalid Python version: ${version}`);
        }

        const groups = match.groups!;
        this.original = normalizedVersion;
        this.releaseComponentCount = groups.patch !== undefined ? 3 : groups.minor !== undefined ? 2 : 1;
        this.major = parseNumericComponent(groups.major, version);
        this.minor = parseNumericComponent(groups.minor, version);
        this.patch = parseNumericComponent(groups.patch, version);
        this.releaseLevel = PythonVersion.normalizeReleaseLevel(groups.longLevel ?? groups.shortLevel);
        this.releaseSerial = parseNumericComponent(groups.longSerial ?? groups.shortSerial, version);
        if (this.releaseLevel === 'final' && this.releaseSerial !== 0) {
            throw new TypeError(`Invalid Python version: ${version}`);
        }
    }

    readonly major: number;
    readonly minor: number;
    readonly patch: number;
    readonly releaseLevel: PythonReleaseLevel;
    readonly releaseSerial: number;
    private readonly original: string;
    private readonly releaseComponentCount: number;

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
            this.compareReleaseTo(other) ||
            compareNumbers(
                PythonVersion.RELEASE_LEVEL_ORDER[this.releaseLevel],
                PythonVersion.RELEASE_LEVEL_ORDER[other.releaseLevel],
            ) ||
            compareNumbers(this.releaseSerial, other.releaseSerial)
        );
    }

    /**
     * Tests whether this version satisfies a Python version specifier.
     *
     * Supports `==`, `!=`, `>=`, `<=`, `>`, `<`, `~=`, and `===` operators,
     * comma-separated AND clauses, and terminal wildcards with `==` or `!=`.
     * Prerelease suffixes are ignored for ordered and release-equality
     * comparisons, matching the inline-script interpreter behavior.
     *
     * @param specifier A version specifier such as `>=3.11,<3.14` or `==3.12.*`.
     * @returns Whether every clause matches, or `undefined` when the specifier is invalid.
     */
    satisfies(specifier: unknown): boolean | undefined {
        if (typeof specifier !== 'string') {
            return undefined;
        }

        const clauses = specifier.split(',').map((clause) => clause.trim());
        if (clauses.some((clause) => clause.length === 0)) {
            return undefined;
        }

        let satisfiesAll = true;
        for (const clause of clauses) {
            const result = this.matchClause(clause);
            if (result === undefined) {
                return undefined;
            }
            satisfiesAll &&= result;
        }
        return satisfiesAll;
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

    private static normalizeReleaseLevel(value: string | undefined): PythonReleaseLevel {
        return value ? (PythonVersion.RELEASE_LEVEL_ALIASES[value.toLowerCase()] ?? 'final') : 'final';
    }

    private matchClause(clause: string): boolean | undefined {
        const match = PythonVersion.SPECIFIER_PATTERN.exec(clause);
        if (!match) {
            return undefined;
        }

        const operator = match[1];
        const expected = match[2].trim();
        if (operator === '===') {
            return expected ? this.original.replace(/^v/i, '') === expected.replace(/^v/i, '') : undefined;
        }
        if (expected.endsWith('.*')) {
            const wildcard = PythonVersion.parseWildcard(expected);
            if ((operator !== '==' && operator !== '!=') || !wildcard) {
                return undefined;
            }
            const matches = this.matchesReleaseComponents(wildcard);
            return operator === '==' ? matches : !matches;
        }

        const expectedVersion = PythonVersion.tryParse(expected);
        if (!expectedVersion || (operator === '~=' && expectedVersion.releaseComponentCount < 2)) {
            return undefined;
        }

        const comparison = this.compareReleaseTo(expectedVersion);
        switch (operator) {
            case '==':
                return comparison === 0;
            case '!=':
                return comparison !== 0;
            case '>=':
                return comparison >= 0;
            case '<=':
                return comparison <= 0;
            case '>':
                return comparison > 0;
            case '<':
                return comparison < 0;
            case '~=':
                return (
                    comparison >= 0 &&
                    this.matchesReleaseComponents(
                        expectedVersion.releasePrefix(expectedVersion.releaseComponentCount - 1),
                    )
                );
            default:
                return false;
        }
    }

    private compareReleaseTo(other: PythonVersion): number {
        return (
            compareNumbers(this.major, other.major) ||
            compareNumbers(this.minor, other.minor) ||
            compareNumbers(this.patch, other.patch)
        );
    }

    private releasePrefix(length: number): readonly number[] {
        return [this.major, this.minor, this.patch].slice(0, length);
    }

    private matchesReleaseComponents(expected: readonly number[]): boolean {
        return (
            expected[0] === this.major &&
            (expected.length < 2 || expected[1] === this.minor) &&
            (expected.length < 3 || expected[2] === this.patch)
        );
    }

    private static parseWildcard(wildcard: unknown): number[] | undefined {
        if (typeof wildcard !== 'string') {
            return undefined;
        }

        const match = PythonVersion.WILDCARD_PATTERN.exec(wildcard.trim());
        if (!match) {
            return undefined;
        }

        const components = match
            .slice(1)
            .filter((component): component is string => component !== undefined)
            .map(Number);
        return components.every(Number.isSafeInteger) ? components : undefined;
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
