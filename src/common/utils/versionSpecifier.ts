/**
 * PEP 440 version specifiers and constraints.
 *
 * A `VersionSpecifier` represents a single clause like `>=1.2.3` or `==1.2.*`.
 * A `VersionConstraint` represents a comma-separated set like `>=1.2,<2.0`.
 *
 * See https://peps.python.org/pep-0440/#version-specifiers
 */

import { PEP440Version } from './pep440Version';

/** Operators supported by PEP 440 version specifiers. */
export type VersionOp = '==' | '!=' | '<=' | '>=' | '<' | '>' | '~=' | '===';

const VALID_OPS: readonly VersionOp[] = ['===', '~=', '==', '!=', '<=', '>=', '<', '>'];

/**
 * Regex to parse a single specifier clause.
 * Match the operator first (longest-match order), then optional whitespace,
 * then the version (with optional trailing `.*` wildcard).
 */
const SPECIFIER_REGEX = new RegExp(
    `^(${VALID_OPS.join('|')})\\s*` +
        `(v?(?:[0-9]+!)?[0-9]+(?:\\.[0-9]+)*` +
        `(?:[-_.]?(?:a|b|c|rc|alpha|beta|pre|preview)[-_.]?[0-9]*)?` +
        `(?:(?:-[0-9]+)|(?:[-_.]?(?:post|rev|r)[-_.]?[0-9]*))?` +
        `(?:[-_.]?dev[-_.]?[0-9]*)?` +
        `(?:\\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?)` +
        `(\\.\\*)?$`,
    'i',
);

/**
 * A single version specifier clause (e.g. `>=1.2.3` or `==1.2.*`).
 */
export class VersionSpecifier {
    /** The comparison operator. */
    public readonly op: VersionOp;
    /** The version to compare against. */
    public readonly version: PEP440Version;
    /** Whether the specifier uses a wildcard (only valid with `==` and `!=`). */
    public readonly wildcard: boolean;

    constructor(op: VersionOp, version: PEP440Version, wildcard: boolean = false) {
        this.op = op;
        this.version = version;
        this.wildcard = wildcard;
    }

    /**
     * Parse a single specifier clause like `>=1.2.3` or `==1.2.*`.
     * Returns `undefined` if the string is not valid.
     */
    public static parse(input: string): VersionSpecifier | undefined {
        const match = SPECIFIER_REGEX.exec(input.trim());
        if (!match) {
            return undefined;
        }

        const op = match[1] as VersionOp;
        const versionStr = match[2];
        const wildcard = match[3] === '.*';

        // Wildcards are only valid with == and !=
        if (wildcard && op !== '==' && op !== '!=') {
            return undefined;
        }

        const version = PEP440Version.parse(versionStr);
        if (!version) {
            return undefined;
        }

        return new VersionSpecifier(op, version, wildcard);
    }

    /**
     * Check whether a candidate version satisfies this specifier.
     */
    public contains(candidate: PEP440Version): boolean {
        switch (this.op) {
            case '==':
                return this.wildcard
                    ? this.prefixMatch(candidate)
                    : PEP440Version.compare(candidate, this.version) === 0;
            case '!=':
                return this.wildcard
                    ? !this.prefixMatch(candidate)
                    : PEP440Version.compare(candidate, this.version) !== 0;
            case '<':
                return PEP440Version.compare(candidate, this.version) < 0;
            case '<=':
                return PEP440Version.compare(candidate, this.version) <= 0;
            case '>':
                return PEP440Version.compare(candidate, this.version) > 0;
            case '>=':
                return PEP440Version.compare(candidate, this.version) >= 0;
            case '~=':
                return this.compatibleMatch(candidate);
            case '===':
                return candidate.toString() === this.version.toString();
        }
    }

    /**
     * Prefix match for wildcard specifiers (`==1.2.*`).
     * Checks that the candidate's release starts with the specifier's release segments
     * and the epoch matches.
     */
    private prefixMatch(candidate: PEP440Version): boolean {
        if (candidate.epoch !== this.version.epoch) {
            return false;
        }
        const prefix = this.version.release;
        if (candidate.release.length < prefix.length) {
            return false;
        }
        for (let i = 0; i < prefix.length; i++) {
            if (candidate.release[i] !== prefix[i]) {
                return false;
            }
        }
        return true;
    }

    /**
     * Compatible release match (`~=`).
     * `~=X.Y.Z` is equivalent to `>=X.Y.Z, ==X.Y.*`.
     * `~=X.Y` is equivalent to `>=X.Y, ==X.*`.
     */
    private compatibleMatch(candidate: PEP440Version): boolean {
        // Must be >= the specified version
        if (PEP440Version.compare(candidate, this.version) < 0) {
            return false;
        }
        // Must share the same prefix (all segments except the last)
        const release = this.version.release;
        const prefix = release.slice(0, release.length - 1);
        if (candidate.epoch !== this.version.epoch) {
            return false;
        }
        for (let i = 0; i < prefix.length; i++) {
            const cv = i < candidate.release.length ? candidate.release[i] : 0;
            if (cv !== prefix[i]) {
                return false;
            }
        }
        return true;
    }

    /** Returns the string representation (e.g. `>=1.2.3`, `==1.2.*`). */
    public toString(): string {
        const suffix = this.wildcard ? '.*' : '';
        return `${this.op}${this.version}${suffix}`;
    }
}

/**
 * A set of version specifier clauses joined by commas (e.g. `>=1.2,<2.0`).
 * A candidate version must satisfy **all** clauses.
 */
export class VersionConstraint {
    public readonly specifiers: readonly VersionSpecifier[];

    constructor(specifiers: readonly VersionSpecifier[]) {
        this.specifiers = specifiers;
    }

    /**
     * Parse a comma-separated version constraint string like `>=1.2,<2.0`.
     * Returns `undefined` if any clause is invalid.
     */
    public static parse(input: string): VersionConstraint | undefined {
        const parts = input.split(',').map((s) => s.trim());
        if (parts.length === 0 || (parts.length === 1 && parts[0] === '')) {
            return undefined;
        }

        const specifiers: VersionSpecifier[] = [];
        for (const part of parts) {
            const spec = VersionSpecifier.parse(part);
            if (!spec) {
                return undefined;
            }
            specifiers.push(spec);
        }

        return new VersionConstraint(specifiers);
    }

    /**
     * Check whether a candidate version satisfies all specifiers in this constraint.
     */
    public contains(candidate: PEP440Version): boolean {
        return this.specifiers.every((s) => s.contains(candidate));
    }

    /** Returns the comma-separated string representation. */
    public toString(): string {
        return this.specifiers.map((s) => s.toString()).join(',');
    }
}
