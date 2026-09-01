import { PythonVersion } from './pythonVersion';

/**
 * A single parsed clause of a version specifier.
 *
 * Clauses are parsed before any of them is evaluated so that operator syntax
 * is validated in one place and the prerelease rule can be applied to the
 * specifier as a whole.
 */
interface VersionClause {
    /** Tests a version against this clause alone, ignoring prerelease exclusion. */
    readonly matches: (version: PythonVersion) => boolean;
    /** Whether this clause explicitly names a prerelease. */
    readonly allowsPrereleases: boolean;
}

/**
 * Splits a specifier clause into its operator and version literal.
 *
 * A leading `v` on the literal is dropped, since PEP 440 permits it on a
 * specifier but a Python release version never carries one.
 *
 * @param clause A single clause such as `>=3.11` or `==3.12.*`.
 * @returns The clause parts, or `undefined` when the clause is malformed.
 */
export function splitClause(clause: string): { readonly operator: string; readonly literal: string } | undefined {
    const match = PythonVersionSpecifier.CLAUSE_PATTERN.exec(clause.trim());
    if (!match) {
        return undefined;
    }

    const literal = match[2].trim().replace(/^v/i, '');
    return literal ? { operator: match[1], literal } : undefined;
}

/** The operators that accept any version and are decided purely by ordering. */
const COMPARISONS: Readonly<Record<string, (comparison: number) => boolean>> = {
    '==': (comparison) => comparison === 0,
    '!=': (comparison) => comparison !== 0,
    '>=': (comparison) => comparison >= 0,
    '<=': (comparison) => comparison <= 0,
    '>': (comparison) => comparison > 0,
    '<': (comparison) => comparison < 0,
};

/**
 * A parsed Python version specifier such as `>=3.11,<3.14` or `==3.12.*`.
 *
 * Supports the `==`, `!=`, `>=`, `<=`, `>`, `<`, `~=`, and `===` operators,
 * comma-separated AND clauses, and terminal wildcards with `==` or `!=`.
 *
 * This models specifiers over Python *interpreter* releases. It deliberately
 * omits the PEP 440 packaging features that interpreters never use, such as
 * epochs, post releases, dev releases, and local version labels; use a
 * dedicated PEP 440 implementation for package requirements.
 */
export class PythonVersionSpecifier {
    static readonly CLAUSE_PATTERN = /^(===|~=|==|!=|>=|<=|>|<)\s*(.+)$/;

    private constructor(private readonly clauses: readonly VersionClause[]) {}

    /**
     * Parses a version specifier.
     *
     * @param specifier A specifier such as `>=3.11,<3.14`.
     * @returns The parsed specifier, or `undefined` when it is malformed.
     */
    static tryParse(specifier: unknown): PythonVersionSpecifier | undefined {
        if (typeof specifier !== 'string') {
            return undefined;
        }

        const clauses: VersionClause[] = [];
        for (const text of specifier.split(',')) {
            const clause = parseClause(text.trim());
            if (!clause) {
                return undefined;
            }
            clauses.push(clause);
        }
        return new PythonVersionSpecifier(clauses);
    }

    /**
     * Tests whether a version satisfies every clause of this specifier.
     *
     * A prerelease only satisfies a specifier that itself names a prerelease,
     * so `3.14.0rc1` does not satisfy `>=3.11` but does satisfy `>=3.14.0rc1`.
     *
     * @param version The version to test.
     */
    matches(version: PythonVersion): boolean {
        if (!this.clauses.every((clause) => clause.matches(version))) {
            return false;
        }
        return version.releaseLevel === 'final' || this.clauses.some((clause) => clause.allowsPrereleases);
    }
}

/** Parses and validates a single clause such as `>=3.11` or `==3.12.*`. */
function parseClause(clause: string): VersionClause | undefined {
    const parts = splitClause(clause);
    if (!parts) {
        return undefined;
    }

    const { operator, literal } = parts;

    // Arbitrary equality compares the versions as written rather than as parsed.
    if (operator === '===') {
        return {
            matches: (version) => version.source === literal,
            allowsPrereleases: PythonVersion.tryParse(literal)?.releaseLevel !== 'final',
        };
    }

    // A wildcard compares only the release components preceding the `.*`, which
    // is meaningless for the ordered operators and for a prerelease prefix.
    if (literal.endsWith('.*')) {
        if (operator !== '==' && operator !== '!=') {
            return undefined;
        }
        const prefix = PythonVersion.tryParse(literal.slice(0, -2));
        if (!prefix || prefix.releaseLevel !== 'final') {
            return undefined;
        }
        const negated = operator === '!=';
        return { matches: (version) => version.matchesReleasePrefix(prefix) !== negated, allowsPrereleases: false };
    }

    const bound = PythonVersion.tryParse(literal);
    if (!bound) {
        return undefined;
    }
    const allowsPrereleases = bound.releaseLevel !== 'final';

    // A compatible release is a lower bound that may not advance the component
    // before the last one supplied, so `~=3.11.2` allows 3.11.10 but not 3.12.
    if (operator === '~=') {
        return bound.precision >= 2
            ? {
                  matches: (version) =>
                      version.compareTo(bound) >= 0 && version.matchesReleasePrefix(bound, bound.precision - 1),
                  allowsPrereleases,
              }
            : undefined;
    }

    const comparison = COMPARISONS[operator];
    return comparison ? { matches: (version) => comparison(version.compareTo(bound)), allowsPrereleases } : undefined;
}
