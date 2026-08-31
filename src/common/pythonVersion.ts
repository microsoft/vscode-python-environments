type PythonReleaseLevel = 'alpha' | 'beta' | 'candidate' | 'final';
type ComparisonOperator = '~=' | '==' | '!=' | '>=' | '<=' | '>' | '<';
type ParsedClause =
    | { readonly operator: '==='; readonly expected: string }
    | { readonly operator: '==' | '!='; readonly wildcard: readonly number[] }
    | { readonly operator: ComparisonOperator; readonly expected: PythonVersion };

export class PythonVersion {
    private static readonly VERSION_PATTERN =
        /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:(?:\.(alpha|beta|candidate|final)\.(\d+))|(?:(a|b|rc)(\d+)))?$/i;

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

        this.original = normalizedVersion;
        this.releaseComponentCount = match[3] !== undefined ? 3 : match[2] !== undefined ? 2 : 1;
        this.major = parseNumericComponent(match[1], version);
        this.minor = parseNumericComponent(match[2], version);
        this.patch = parseNumericComponent(match[3], version);
        this.releaseLevel = PythonVersion.normalizeReleaseLevel(match[4] ?? match[6]);
        this.releaseSerial = parseNumericComponent(match[5] ?? match[7], version);
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
     * Tests whether this version matches a release-prefix wildcard.
     *
     * @param wildcard A terminal wildcard such as `3.*`, `3.14.*`, or `3.14.0.*`.
     * @returns `true` when all components before the wildcard match, otherwise `false`.
     */
    satisfiesWildcard(wildcard: unknown): boolean {
        const expected = PythonVersion.parseWildcard(wildcard);
        return expected !== undefined && this.matchesReleaseComponents(expected);
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
     * @returns `true` when every clause matches; otherwise `false`.
     */
    satisfies(specifier: unknown): boolean {
        return this.matchSpecifier(specifier) ?? false;
    }

    /**
     * Evaluates a Python version specifier while distinguishing invalid syntax.
     *
     * @param specifier The specifier to evaluate.
     * @returns Whether this version matches, or `undefined` for an invalid specifier.
     */
    matchSpecifier(specifier: unknown): boolean | undefined {
        const clauses = PythonVersion.parseSpecifier(specifier);
        return clauses?.every((clause) => this.satisfiesClause(clause));
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

    private static parseSpecifier(specifier: unknown): readonly ParsedClause[] | undefined {
        if (typeof specifier !== 'string') {
            return undefined;
        }

        const clauses = specifier
            .split(',')
            .map((clause) => clause.trim())
            .filter((clause) => clause.length > 0);
        if (clauses.length === 0) {
            return undefined;
        }

        const parsed = clauses.map((clause) => PythonVersion.parseClause(clause));
        return parsed.every((clause): clause is ParsedClause => clause !== undefined) ? parsed : undefined;
    }

    private static parseClause(clause: string): ParsedClause | undefined {
        const match = PythonVersion.SPECIFIER_PATTERN.exec(clause);
        if (!match) {
            return undefined;
        }

        const operator = match[1];
        const expected = match[2].trim();
        if (operator === '===') {
            return expected.length > 0 ? { operator, expected } : undefined;
        }
        if (expected.endsWith('.*')) {
            const wildcard = PythonVersion.parseWildcard(expected);
            return (operator === '==' || operator === '!=') && wildcard ? { operator, wildcard } : undefined;
        }

        const expectedVersion = PythonVersion.tryParse(expected);
        if (!expectedVersion || (operator === '~=' && expectedVersion.releaseComponentCount < 2)) {
            return undefined;
        }
        return { operator: operator as ComparisonOperator, expected: expectedVersion };
    }

    private satisfiesClause(clause: ParsedClause): boolean {
        if (clause.operator === '===') {
            return this.original.replace(/^v/i, '') === clause.expected.replace(/^v/i, '');
        }
        if ('wildcard' in clause) {
            const matches = this.matchesReleaseComponents(clause.wildcard);
            return clause.operator === '==' ? matches : !matches;
        }

        const comparison = this.compareReleaseTo(clause.expected);
        switch (clause.operator) {
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
                        clause.expected.releaseComponents.slice(0, clause.expected.releaseComponentCount - 1),
                    )
                );
            default:
                return false;
        }
    }

    private compareReleaseTo(other: PythonVersion): number {
        for (let index = 0; index < this.releaseComponents.length; index++) {
            const comparison = compareNumbers(this.releaseComponents[index], other.releaseComponents[index]);
            if (comparison !== 0) {
                return comparison;
            }
        }
        return 0;
    }

    private get releaseComponents(): readonly number[] {
        return [this.major, this.minor, this.patch];
    }

    private matchesReleaseComponents(expected: readonly number[]): boolean {
        return expected.every((component, index) => component === this.releaseComponents[index]);
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
