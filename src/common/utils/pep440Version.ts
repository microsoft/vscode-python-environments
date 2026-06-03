/**
 * Represents a PEP 440 version.
 *
 * Format: [N!]N(.N)*[{a|b|rc}N][.postN][.devN][+local]
 * See https://peps.python.org/pep-0440/
 */

/** Normalized pre-release phase. */
export type PreReleasePhase = 'a' | 'b' | 'rc';

/** Raw pre-release labels accepted before normalization. */
type PreReleaseLabelInput = 'a' | 'alpha' | 'b' | 'beta' | 'c' | 'rc' | 'pre' | 'preview';

/**
 * PEP 440 version regex adapted from the Python `packaging` library.
 * Captures:
 *  1: epoch          (e.g. "2")
 *  2: release        (e.g. "1.2.3")
 *  3: pre-label      (a|b|c|rc|alpha|beta|pre|preview)
 *  4: pre-number
 *  5: implicit post  (e.g. "-1" form)
 *  6: post-label     (post|rev|r)
 *  7: post-number
 *  8: dev-label      (dev)
 *  9: dev-number
 * 10: local          (e.g. "ubuntu1")
 */
const PEP440_REGEX =
    /^v?(?:([0-9]+)!)?([0-9]+(?:\.[0-9]+)*)(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?([0-9]+)?)?(?:(?:-([0-9]+))|(?:[-_.]?(post|rev|r)[-_.]?([0-9]+)?))?(?:[-_.]?(dev)[-_.]?([0-9]+)?)?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?$/i;

function normalizePreLabel(label: PreReleaseLabelInput): PreReleasePhase {
    switch (label) {
        case 'a':
        case 'alpha':
            return 'a';
        case 'b':
        case 'beta':
            return 'b';
        case 'c':
        case 'rc':
        case 'pre':
        case 'preview':
            return 'rc';
    }
}

export class PEP440Version {
    /** Version epoch, defaults to 0. */
    public readonly epoch: number;
    /** Release segment numbers (e.g. [1, 2, 3] for "1.2.3"). */
    public readonly release: readonly number[];
    /** Pre-release phase: 'a', 'b', or 'rc', or undefined. */
    public readonly pre: PreReleasePhase | undefined;
    /** Pre-release number (e.g. 2 in "rc2"), or undefined if no pre-release. */
    public readonly preNumber: number | undefined;
    /** Post-release number, or undefined. */
    public readonly post: number | undefined;
    /** Dev release number, or undefined. */
    public readonly dev: number | undefined;
    /** Local version label (e.g. "ubuntu1"), or undefined. */
    public readonly local: string | undefined;

    /**
     * @param release Release segment numbers (e.g. `[1, 2, 3]`).
     * @param options Optional version segments. All inputs are normalized per PEP 440:
     *  - `pre`: alternate spellings (alpha, beta, c, preview, pre) are normalized to a/b/rc.
     *  - `preNumber`: defaults to 0 when `pre` is set.
     *  - `post`/`dev`: implicit number defaults to 0.
     *  - `local`: lowercased, separators (`-`, `_`) replaced with `.`.
     *  - `release`: trailing zero segments are trimmed (e.g. `[1, 0, 0]` → `[1]`).
     */
    constructor(
        release: readonly number[],
        options?: {
            epoch?: number;
            pre?: PreReleaseLabelInput;
            preNumber?: number;
            post?: number;
            dev?: number;
            local?: string;
        },
    ) {
        this.epoch = options?.epoch ?? 0;
        this.release = [...release];

        // Normalize pre-release label and default number to 0
        this.pre = options?.pre !== undefined ? normalizePreLabel(options.pre) : undefined;
        this.preNumber = options?.pre !== undefined ? (options?.preNumber ?? 0) : undefined;

        // Post and dev default to 0 when present (PEP 440: "1.0.post" == "1.0.post0")
        this.post = options?.post;
        this.dev = options?.dev;

        // Normalize local: lowercase, replace - and _ with .
        this.local = options?.local?.toLowerCase().replace(/[-_]/g, '.');
    }

    /** The major version number (first element of release). */
    public get major(): number {
        return this.release.length > 0 ? this.release[0] : 0;
    }

    /**
     * Parse a PEP 440 version string. Returns `undefined` if the string is not valid.
     */
    public static parse(input: string): PEP440Version | undefined {
        const match = PEP440_REGEX.exec(input.trim());
        if (!match) {
            return undefined;
        }

        const release = match[2].split('.').map((s) => parseInt(s, 10));

        let pre: PreReleaseLabelInput | undefined;
        let preNumber: number | undefined;
        if (match[3] !== undefined) {
            pre = match[3].toLowerCase() as PreReleaseLabelInput;
            preNumber = match[4] !== undefined ? parseInt(match[4], 10) : 0;
        }

        let post: number | undefined;
        if (match[5] !== undefined) {
            // Implicit post: "1.0-1" form
            post = parseInt(match[5], 10);
        } else if (match[6] !== undefined) {
            post = match[7] !== undefined ? parseInt(match[7], 10) : 0;
        }

        const dev = match[8] !== undefined ? (match[9] !== undefined ? parseInt(match[9], 10) : 0) : undefined;
        const local = match[10];

        return new PEP440Version(release, {
            epoch: match[1] !== undefined ? parseInt(match[1], 10) : undefined,
            pre,
            preNumber,
            post,
            dev,
            local,
        });
    }

    /** The minor version number (second element of release), or 0 if absent. */
    public get minor(): number {
        return this.release.length > 1 ? this.release[1] : 0;
    }

    /** The micro/patch version number (third element of release), or 0 if absent. */
    public get micro(): number {
        return this.release.length > 2 ? this.release[2] : 0;
    }

    /**
     * Returns a short display string: "X.Y.Z" if micro is present, otherwise "X.Y.x".
     * Parses `input` first; returns it unchanged if not a valid version.
     */
    public static shortenVersionString(input: string): string {
        const v = PEP440Version.parse(input);
        if (!v) {
            return input;
        }
        return v.release.length >= 3 ? `${v.major}.${v.minor}.${v.micro}` : `${v.major}.${v.minor}.x`;
    }

    /** Whether this version is a pre-release (has pre or dev segment). */
    public get isPreRelease(): boolean {
        return this.pre !== undefined || this.dev !== undefined;
    }

    /** Whether this version is a post-release. */
    public get isPostRelease(): boolean {
        return this.post !== undefined;
    }

    /** Whether this version is a dev release. */
    public get isDevRelease(): boolean {
        return this.dev !== undefined;
    }

    /** Whether this version has a local segment. */
    public get isLocal(): boolean {
        return this.local !== undefined;
    }

    /** Returns the normalized PEP 440 string representation. */
    public toString(): string {
        const parts: string[] = [];

        if (this.epoch !== 0) {
            parts.push(`${this.epoch}!`);
        }

        parts.push(this.release.join('.'));

        if (this.pre !== undefined) {
            parts.push(`${this.pre}${this.preNumber ?? 0}`);
        }

        if (this.post !== undefined) {
            parts.push(`.post${this.post}`);
        }

        if (this.dev !== undefined) {
            parts.push(`.dev${this.dev}`);
        }

        if (this.local !== undefined) {
            parts.push(`+${this.local}`);
        }

        return parts.join('');
    }

    /**
     * Compare two versions. Returns negative if `a < b`,
     * 0 if equal, positive if `a > b`.
     *
     * Local versions are not considered in ordering per PEP 440.
     *
     * PEP 440 ordering: .devN < aN < bN < rcN < (final) < .postN
     */
    public static compare(a: PEP440Version, b: PEP440Version): number {
        // 1. Epoch
        if (a.epoch !== b.epoch) {
            return a.epoch - b.epoch;
        }

        // 2. Release segments (compare element-by-element, pad shorter with 0)
        const maxLen = Math.max(a.release.length, b.release.length);
        for (let i = 0; i < maxLen; i++) {
            const av = i < a.release.length ? a.release[i] : 0;
            const bv = i < b.release.length ? b.release[i] : 0;
            if (av !== bv) {
                return av - bv;
            }
        }

        // 3. Pre/dev/post sort key comparison
        //    Sort key is [prePhase, preNum, post, dev] where:
        //      - prePhase: a=-3, b=-2, rc=-1, absent=0
        //      - preNum: number or 0
        //      - post: number if present, -1 if absent
        //      - dev: number if present, Infinity if absent (final sorts after dev)
        const aKey = PEP440Version.sortKey(a);
        const bKey = PEP440Version.sortKey(b);
        for (let i = 0; i < aKey.length; i++) {
            if (aKey[i] !== bKey[i]) {
                return aKey[i] < bKey[i] ? -1 : 1;
            }
        }

        return 0;
    }

    private static readonly PRE_PHASE_ORDER: Record<PreReleasePhase, number> = { a: -3, b: -2, rc: -1 };

    private static sortKey(v: PEP440Version): [number, number, number, number] {
        // Special case from Python `packaging`: dev-only releases (no pre, no post)
        // must sort before all pre-releases. Without this, 1.0.dev0 would sort
        // after 1.0a0 because "no pre" normally sorts after all pre phases.
        let prePhase: number;
        if (v.pre === undefined && v.post === undefined && v.dev !== undefined) {
            prePhase = -Infinity;
        } else {
            prePhase = v.pre !== undefined ? PEP440Version.PRE_PHASE_ORDER[v.pre] : 0;
        }
        const preNum = v.preNumber ?? 0;
        const post = v.post ?? -1;
        const dev = v.dev ?? Infinity;
        return [prePhase, preNum, post, dev];
    }
}
