// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as tomljs from '@iarna/toml';
import * as fs from 'fs/promises';
import { Uri } from 'vscode';
import { traceVerbose, traceWarn } from '../logging';
import { PythonVersion } from '../pythonVersion';

/**
 * Parsed and validated PEP 723 `script` metadata block.
 *
 * See: https://packaging.python.org/en/latest/specifications/inline-script-metadata/
 */
export interface InlineScriptMetadata {
    /** Parsed value of `requires-python`, if present. */
    readonly requiresPython?: string;
    /** Parsed value of `dependencies`, if present. */
    readonly dependencies?: readonly string[];
    /** Parsed `[tool]` table, opaque to this parser. */
    readonly tool?: tomljs.JsonMap;
    /**
     * Character offsets of the `# /// script` … `# ///` block in the
     * (normalized — see notes on BOM and CRLF handling below) text that
     * was parsed: inclusive start of the `# /// script` line, exclusive
     * end immediately after the closing `# ///` line's terminating
     * newline (or end of string if there is no trailing newline).
     */
    readonly range: { readonly start: number; readonly end: number };
    /**
     * Character offsets of the same metadata block in the original source
     * text. Unlike {@link range}, these include a leading BOM and preserve
     * CRLF, so they can be compared with TextDocument change offsets.
     *
     * Optional to keep manually constructed metadata compatible; parser
     * results always supply it.
     */
    readonly sourceRange?: { readonly start: number; readonly end: number };
}

/**
 * Maximum bytes read from the head of a file when looking for inline
 * script metadata. PEP 723 blocks live at the top of files, so reading
 * the first chunk is sufficient. Callers that need to handle scripts
 * with very large leading shebang / comment blocks should know that
 * anything past this byte boundary is invisible to the detector.
 */
export const MAX_HEADER_BYTES = 8 * 1024;

/**
 * Canonical block regex from the PEP 723 spec, translated to JavaScript
 * (Python's `(?P<name>...)` becomes `(?<name>...)` in JS). The flag
 * combination `gm` is required so `^` / `$` anchor on line boundaries
 * and so `String.prototype.matchAll` can iterate every candidate block.
 *
 * Important: this regex assumes line endings have already been
 * normalized to `\n`. In Python's `re` module `.` matches `\r`, but in
 * JavaScript it does not, so a literal CRLF file would behave
 * inconsistently against this pattern. `readInlineScriptMetadata`
 * normalizes line endings before applying the regex.
 *
 * The pattern is consumed exclusively via `text.matchAll(BLOCK_RE)`,
 * which constructs a fresh iterator each call and does NOT mutate the
 * regex's `lastIndex`. Do not call `BLOCK_RE.exec` directly — that
 * would reintroduce the stateful-lastIndex footgun.
 */
const BLOCK_RE = /^# \/\/\/ (?<type>[a-zA-Z0-9-]+)$\s(?<content>(^#(| .*)$\s)+)^# \/\/\/$/gm;

/**
 * Parse PEP 723 `script` metadata from script source text.
 *
 * Returns:
 *  - the parsed metadata if the text contains exactly one well-formed
 *    `script` block;
 *  - `undefined` if there is no `script` block, if there are multiple
 *    `script` blocks (per spec this MUST error), or if the block's
 *    TOML payload is malformed.
 *
 * Encoding: input is processed as UTF-8 text. The `# -*- coding: ... -*-`
 * declaration is not honored (the spec permits but does not require it).
 */
export function readInlineScriptMetadata(scriptText: string): InlineScriptMetadata | undefined {
    if (!scriptText) {
        return undefined;
    }

    // Strip a single leading UTF-8 BOM (\uFEFF). Files saved as
    // "UTF-8 with BOM" on Windows have this; without stripping it the
    // first line becomes "\uFEFF# /// script" and the regex fails to
    // match.
    const bomOffset = scriptText.charCodeAt(0) === 0xfeff ? 1 : 0;
    const sourceText = scriptText.slice(bomOffset);
    let text = sourceText;

    // Normalize CRLF and lone CR to LF so the canonical regex (which
    // was authored assuming `.` matches `\r`, true in Python's re but
    // not in JavaScript) behaves consistently. The offsets in `range`
    // refer to this normalized text.
    text = text.replace(/\r\n?/g, '\n');

    // Collect ALL matches first so we can detect the "multiple script
    // blocks" error case the spec requires us to surface.
    //
    // `matchAll` constructs a fresh iterator and does not mutate the
    // shared `BLOCK_RE.lastIndex`, so this loop is re-entrant and safe
    // even if a caller (or an exception) ever interrupts a previous
    // pass.
    const scriptMatches: RegExpMatchArray[] = [];
    for (const m of text.matchAll(BLOCK_RE)) {
        // Per spec, tools MUST NOT read non-standardized block types.
        // The only standardized type today is `script`.
        if (m.groups?.type === 'script') {
            scriptMatches.push(m);
        }
    }

    if (scriptMatches.length === 0) {
        traceVerbose('inline script metadata: no `# /// script` block found');
        return undefined;
    }
    if (scriptMatches.length > 1) {
        traceWarn(
            `inline script metadata: ${scriptMatches.length} \`# /// script\` blocks found; per PEP 723 multiple blocks of the same type MUST be an error.`,
        );
        return undefined;
    }

    const match = scriptMatches[0];
    const rawContent = match.groups!.content;
    // `index` is always populated for matches produced by
    // `matchAll(regex)` when `regex` has the `g` flag, but the
    // TypeScript lib type still marks it optional. Pin it locally.
    const matchStart = match.index!;

    // Validate each content line and reconstruct the TOML payload,
    // applying the spec's content-extraction rule:
    //   if line[1] === ' ' drop 2 chars, else drop 1 char (the leading '#').
    // The canonical regex already restricts content lines to '#' or
    // '# <anything>', but we walk the lines explicitly here both for
    // safety against regex-engine quirks and to keep the
    // reconstruction logic obvious.
    const reconstructed: string[] = [];
    const contentLines = rawContent.split('\n');
    for (const line of contentLines) {
        if (line.length === 0) {
            // Final element after splitting on the trailing '\n' that
            // belongs to the last content line. Not a real line.
            continue;
        }
        if (line[0] !== '#') {
            traceWarn(`inline script metadata: invalid content line (must start with '#'): ${JSON.stringify(line)}`);
            return undefined;
        }
        if (line.length === 1) {
            // Bare '#': a blank content line within the block.
            reconstructed.push('');
            continue;
        }
        if (line[1] !== ' ') {
            // Per spec, content lines are exactly '#' or '# <text>'.
            // '##foo', '#\tfoo', '#foo' are not valid.
            traceWarn(`inline script metadata: invalid content line (expected '#' or '# '): ${JSON.stringify(line)}`);
            return undefined;
        }
        reconstructed.push(line.slice(2));
    }

    let parsed: tomljs.JsonMap;
    try {
        parsed = tomljs.parse(reconstructed.join('\n'));
    } catch (err) {
        traceWarn('inline script metadata: failed to parse TOML in `# /// script` block:', err);
        return undefined;
    }

    // Validate the small set of known fields. Unknown top-level keys
    // are tolerated — the spec reserves room for future tool tables
    // and we don't want to be brittle.
    let requiresPython: string | undefined;
    if (parsed['requires-python'] !== undefined) {
        if (typeof parsed['requires-python'] !== 'string') {
            traceWarn(
                `inline script metadata: 'requires-python' must be a string, got ${typeof parsed['requires-python']}`,
            );
            return undefined;
        }
        requiresPython = parsed['requires-python'];
    }

    let dependencies: readonly string[] | undefined;
    if (parsed.dependencies !== undefined) {
        if (!Array.isArray(parsed.dependencies)) {
            traceWarn('inline script metadata: `dependencies` must be an array of strings');
            return undefined;
        }
        for (const dep of parsed.dependencies) {
            if (typeof dep !== 'string') {
                traceWarn('inline script metadata: each entry in `dependencies` must be a string');
                return undefined;
            }
        }
        // Defensive copy + freeze so consumers can't mutate the cached
        // parse result.
        dependencies = Object.freeze((parsed.dependencies as string[]).slice());
    }

    let tool: tomljs.JsonMap | undefined;
    if (parsed.tool !== undefined) {
        if (typeof parsed.tool !== 'object' || Array.isArray(parsed.tool) || parsed.tool === null) {
            traceWarn('inline script metadata: `tool` must be a table');
            return undefined;
        }
        tool = parsed.tool as tomljs.JsonMap;
    }

    // Range end: position immediately AFTER the closing `# ///` line's
    // newline. The regex's `$` anchor stops before the newline, so we
    // step over it explicitly when present.
    let end = matchStart + match[0].length;
    if (text.charAt(end) === '\n') {
        end += 1;
    }

    return {
        requiresPython,
        dependencies,
        tool,
        range: { start: matchStart, end },
        sourceRange: {
            start: bomOffset + sourceOffsetForNormalizedOffset(sourceText, matchStart),
            end: bomOffset + sourceOffsetForNormalizedOffset(sourceText, end),
        },
    };
}

function sourceOffsetForNormalizedOffset(sourceText: string, normalizedOffset: number): number {
    let sourceOffset = 0;
    let currentNormalizedOffset = 0;
    while (currentNormalizedOffset < normalizedOffset && sourceOffset < sourceText.length) {
        if (sourceText.charCodeAt(sourceOffset) === 0x0d) {
            sourceOffset += sourceText.charCodeAt(sourceOffset + 1) === 0x0a ? 2 : 1;
        } else {
            sourceOffset += 1;
        }
        currentNormalizedOffset += 1;
    }
    return sourceOffset;
}

/**
 * Read PEP 723 metadata from a file. Reads only the first
 * `MAX_HEADER_BYTES` bytes of the file — PEP 723 blocks live at the
 * top of files, so reading the whole file would be wasteful when this
 * is invoked across many candidate `.py` files.
 *
 * Returns `undefined` for:
 *  - any URI scheme other than `file:` (notebook cells, untitled
 *    buffers, git: revisions, etc. are out of scope);
 *  - any I/O error (logged at `traceVerbose`);
 *  - any of the malformed-metadata cases handled by
 *    `readInlineScriptMetadata`.
 */
export async function readInlineScriptMetadataFromFile(uri: Uri): Promise<InlineScriptMetadata | undefined> {
    if (uri.scheme !== 'file') {
        traceVerbose(`inline script metadata: skipping non-file URI scheme '${uri.scheme}'`);
        return undefined;
    }

    let text: string;
    try {
        const handle = await fs.open(uri.fsPath, 'r');
        try {
            const buf = Buffer.alloc(MAX_HEADER_BYTES);
            const { bytesRead } = await handle.read(buf, 0, MAX_HEADER_BYTES, 0);
            text = buf.toString('utf-8', 0, bytesRead);
        } finally {
            await handle.close();
        }
    } catch (err) {
        traceVerbose(`inline script metadata: failed to read ${uri.fsPath}:`, err);
        return undefined;
    }

    return readInlineScriptMetadata(text);
}

/**
 * Test whether a Python `version` (e.g. "3.12.4") satisfies a PEP 440
 * version specifier (e.g. ">=3.11"). Implements the subset of PEP 440
 * needed by `requires-python`:
 *
 *  - operators `==`, `!=`, `>=`, `<=`, `>`, `<`, `~=`, `===`;
 *  - comma-separated clauses are AND-ed;
 *  - wildcard `==X.Y.*` (and the negated `!=X.Y.*`) is supported;
 *  - pre-release / dev / post / local version semantics are NOT
 *    modeled (script `requires-python` is almost always a simple
 *    lower bound; suffixes on the input version are truncated to
 *    the release segments).
 *
 * Returns `false` (and logs a `traceWarn`) on an unparseable
 * specifier — safer than defaulting to "any version goes".
 */
export function matchesPythonVersion(requiresPython: string, version: string): boolean {
    if (!requiresPython || !version) {
        return false;
    }
    const parsedVersion = PythonVersion.tryParse(version);
    if (!parsedVersion) {
        traceWarn(`inline script metadata: cannot parse Python version: ${JSON.stringify(version)}`);
        return false;
    }
    const result = parsedVersion.matchSpecifier(requiresPython);
    if (result === undefined) {
        traceWarn(`inline script metadata: invalid requires-python specifier: ${JSON.stringify(requiresPython)}`);
        return false;
    }
    return result;
}
