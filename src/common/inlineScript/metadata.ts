// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as tomljs from '@iarna/toml';
import * as fs from 'fs/promises';
import { Uri } from 'vscode';
import { traceVerbose, traceWarn } from '../logging';
import { PythonVersion } from '../pythonVersion';
import { PythonVersionSpecifier } from '../pythonVersionSpecifier';

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

export type InlineScriptMetadataProblemCode =
    | 'unterminated-block'
    | 'multiple-blocks'
    | 'invalid-content-line'
    | 'invalid-block-marker'
    | 'invalid-toml'
    | 'invalid-field-type';

export interface InlineScriptMetadataProblem {
    readonly code: InlineScriptMetadataProblemCode;
    readonly severity: 'error' | 'warning';
    readonly sourceRange: { readonly start: number; readonly end: number };
    readonly detail?: string;
}

export type InlineScriptMetadataParseResult =
    | {
          readonly kind: 'valid';
          readonly metadata: InlineScriptMetadata;
          readonly problems: readonly InlineScriptMetadataProblem[];
      }
    | { readonly kind: 'none' }
    | { readonly kind: 'invalid'; readonly problems: readonly InlineScriptMetadataProblem[] };

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
 *
 * Deviation from the spec regex: `*` not `+`, because the prose spec
 * permits an empty block and takes precedence over the regex.
 */
const BLOCK_RE = /^# \/\/\/ (?<type>[a-zA-Z0-9-]+)$\s(?<content>(^#(| .*)$\s)*)^# \/\/\/$/gm;

const OPENER_SCAN_RE = /^# \/\/\/ (?<type>[a-zA-Z0-9-]+)(?<trailing>[ \t]*)$/gm;

const CLOSER_LINE = '# ///';

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
 *
 * `source` is a human-readable label (normally the script's path) used
 * only to make the diagnostic log lines actionable. Parsing behaviour is
 * identical whether or not it is supplied.
 */
export function readInlineScriptMetadata(scriptText: string, source?: string): InlineScriptMetadata | undefined {
    const result = parseInlineScriptMetadata(scriptText, source);
    return result.kind === 'valid' ? result.metadata : undefined;
}

const NO_METADATA: InlineScriptMetadataParseResult = { kind: 'none' };

const OPENER_PREFIX = '# /// ';

/** As `readInlineScriptMetadata`, but reports why and where parsing failed. Offsets index the original `scriptText`. */
export function parseInlineScriptMetadata(scriptText: string, source?: string): InlineScriptMetadataParseResult {
    const where = source ? ` in ${source}` : '';
    if (!scriptText) {
        return NO_METADATA;
    }

    // Strip a single leading UTF-8 BOM (\uFEFF). Files saved as
    // "UTF-8 with BOM" on Windows have this; without stripping it the
    // first line becomes "\uFEFF# /// script" and the regex fails to
    // match.
    const bomOffset = scriptText.charCodeAt(0) === 0xfeff ? 1 : 0;
    const sourceText = scriptText.slice(bomOffset);

    // Normalize CRLF and lone CR to LF so the canonical regex (which
    // was authored assuming `.` matches `\r`, true in Python's re but
    // not in JavaScript) behaves consistently. The offsets in `range`
    // refer to this normalized text.
    const text = sourceText.replace(/\r\n?/g, '\n');

    const toSourceRange = (start: number, end: number): { start: number; end: number } => ({
        start: bomOffset + sourceOffsetForNormalizedOffset(sourceText, start),
        end: bomOffset + sourceOffsetForNormalizedOffset(sourceText, end),
    });

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

    const matchedRanges = scriptMatches.map((m) => ({ start: m.index!, end: m.index! + m[0].length }));
    const problems: InlineScriptMetadataProblem[] = [];
    const headerEnd = headerRegionEnd(text);
    for (const opener of findScriptOpeners(text)) {
        if (matchedRanges.some((r) => opener.offset >= r.start && opener.offset < r.end)) {
            continue;
        }
        const problem = diagnoseMalformedBlock(text, opener, toSourceRange, where);
        // Unclosed blocks are ignored per spec; only flag one in the leading
        // comment region, where it is a header being typed rather than an example.
        if (problem.code === 'unterminated-block' && opener.offset >= headerEnd) {
            continue;
        }
        problems.push(problem);
    }

    if (scriptMatches.length === 0) {
        if (problems.length === 0) {
            traceVerbose(`inline script metadata${where}: no \`# /// script\` block found`);
            return NO_METADATA;
        }
        return { kind: 'invalid', problems };
    }
    if (scriptMatches.length > 1) {
        traceWarn(
            `inline script metadata${where}: ${scriptMatches.length} \`# /// script\` blocks found; per PEP 723 multiple blocks of the same type MUST be an error.`,
        );
        for (const extra of scriptMatches.slice(1)) {
            const start = extra.index!;
            problems.push({
                code: 'multiple-blocks',
                severity: 'error',
                sourceRange: toSourceRange(start, lineEndOffset(text, start)),
                detail: String(scriptMatches.length),
            });
        }
        return { kind: 'invalid', problems };
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
    const reconstructedOrigins: number[] = [];
    const contentLines = rawContent.split('\n');
    // 1-based file line of the `# /// script` marker. Content lines start on
    // the next line, so content index `i` sits on `blockStartLine + 1 + i`.
    const blockStartLine = countLines(text, matchStart);
    let lineOffset = matchStart + OPENER_PREFIX.length + match.groups!.type.length + 1;
    for (const [index, line] of contentLines.entries()) {
        const lineStart = lineOffset;
        lineOffset += line.length + 1; // step over the '\n' that terminated this line
        if (line.length === 0) {
            // Final element after splitting on the trailing '\n' that
            // belongs to the last content line. Not a real line.
            continue;
        }
        if (line[0] !== '#') {
            traceWarn(
                `inline script metadata${where}: invalid content line ${blockStartLine + 1 + index} ` +
                    `(must start with '#'): ${JSON.stringify(line)}`,
            );
            problems.push({
                code: 'invalid-content-line',
                severity: 'error',
                sourceRange: toSourceRange(lineStart, lineStart + line.length),
                detail: line,
            });
            return { kind: 'invalid', problems };
        }
        if (line.length === 1) {
            // Bare '#': a blank content line within the block.
            reconstructed.push('');
            reconstructedOrigins.push(lineStart + 1);
            continue;
        }
        if (line[1] !== ' ') {
            // Per spec, content lines are exactly '#' or '# <text>'.
            // '##foo', '#\tfoo', '#foo' are not valid.
            traceWarn(
                `inline script metadata${where}: invalid content line ${blockStartLine + 1 + index} ` +
                    `(expected '#' or '# '): ${JSON.stringify(line)}`,
            );
            problems.push({
                code: 'invalid-content-line',
                severity: 'error',
                sourceRange: toSourceRange(lineStart, lineStart + line.length),
                detail: line,
            });
            return { kind: 'invalid', problems };
        }
        reconstructed.push(line.slice(2));
        reconstructedOrigins.push(lineStart + 2);
    }

    let parsed: tomljs.JsonMap;
    try {
        parsed = tomljs.parse(reconstructed.join('\n'));
    } catch (err) {
        // One actionable line: which file, which line of that file, and what is
        // wrong. The raw error's own "row N" is an index into the reconstructed
        // TOML, not the script, so it is translated here rather than shown. The
        // full error (with stack and excerpt) goes to the debug level for anyone
        // diagnosing the parser itself.
        const position = getTomlErrorPosition(err);
        const detail = describeTomlError(err);
        const at = position === undefined ? '' : ` (line ${blockStartLine + 1 + position.row})`;
        traceWarn(`inline script metadata${where}: invalid TOML in the \`# /// script\` block${at}: ${detail}`);
        traceVerbose(`inline script metadata${where}: TOML parse error detail:`, err);
        problems.push({
            code: 'invalid-toml',
            severity: 'error',
            sourceRange: tomlErrorSourceRange(text, reconstructedOrigins, position, matchStart, toSourceRange),
            detail,
        });
        return { kind: 'invalid', problems };
    }

    // Validate the small set of known fields. Unknown top-level keys
    // are tolerated — the spec reserves room for future tool tables
    // and we don't want to be brittle.
    const fieldRange = (key: string) =>
        findKeyRange(reconstructed, reconstructedOrigins, key, toSourceRange) ??
        toSourceRange(matchStart, lineEndOffset(text, matchStart));

    let requiresPython: string | undefined;
    if (parsed['requires-python'] !== undefined) {
        if (typeof parsed['requires-python'] !== 'string') {
            traceWarn(
                `inline script metadata${where}: 'requires-python' must be a string, got ${typeof parsed['requires-python']}`,
            );
            problems.push({
                code: 'invalid-field-type',
                severity: 'error',
                sourceRange: fieldRange('requires-python'),
                detail: 'requires-python',
            });
            return { kind: 'invalid', problems };
        }
        requiresPython = parsed['requires-python'];
    }

    let dependencies: readonly string[] | undefined;
    if (parsed.dependencies !== undefined) {
        if (!Array.isArray(parsed.dependencies)) {
            traceWarn(`inline script metadata${where}: \`dependencies\` must be an array of strings`);
            problems.push({
                code: 'invalid-field-type',
                severity: 'error',
                sourceRange: fieldRange('dependencies'),
                detail: 'dependencies',
            });
            return { kind: 'invalid', problems };
        }
        for (const dep of parsed.dependencies) {
            if (typeof dep !== 'string') {
                traceWarn(`inline script metadata${where}: each entry in \`dependencies\` must be a string`);
                problems.push({
                    code: 'invalid-field-type',
                    severity: 'error',
                    sourceRange: fieldRange('dependencies'),
                    detail: 'dependencies',
                });
                return { kind: 'invalid', problems };
            }
        }
        // Defensive copy + freeze so consumers can't mutate the cached
        // parse result.
        dependencies = Object.freeze((parsed.dependencies as string[]).slice());
    }

    let tool: tomljs.JsonMap | undefined;
    if (parsed.tool !== undefined) {
        if (typeof parsed.tool !== 'object' || Array.isArray(parsed.tool) || parsed.tool === null) {
            traceWarn(`inline script metadata${where}: \`tool\` must be a table`);
            problems.push({
                code: 'invalid-field-type',
                severity: 'error',
                sourceRange: fieldRange('tool'),
                detail: 'tool',
            });
            return { kind: 'invalid', problems };
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
        kind: 'valid',
        problems,
        metadata: {
            requiresPython,
            dependencies,
            tool,
            range: { start: matchStart, end },
            sourceRange: toSourceRange(matchStart, end),
        },
    };
}

/** 1-based line number of `offset` within LF-normalized `text`. */
function countLines(text: string, offset: number): number {
    let line = 1;
    for (let i = 0; i < offset && i < text.length; i += 1) {
        if (text.charCodeAt(i) === 0x0a) {
            line += 1;
        }
    }
    return line;
}

function lineEndOffset(text: string, offset: number): number {
    const eol = text.indexOf('\n', offset);
    return eol === -1 ? text.length : eol;
}

/** Offset at which the file's leading blank/comment region ends, i.e. where real code starts. */
function headerRegionEnd(text: string): number {
    let offset = 0;
    while (offset < text.length) {
        const lineEnd = lineEndOffset(text, offset);
        const trimmed = text.slice(offset, lineEnd).trim();
        if (trimmed.length > 0 && !trimmed.startsWith('#')) {
            return offset;
        }
        if (lineEnd >= text.length) {
            break;
        }
        offset = lineEnd + 1;
    }
    return text.length;
}

interface ScriptOpener {
    readonly offset: number;
    readonly lineEnd: number;
    readonly trailing: string;
}

function findScriptOpeners(text: string): ScriptOpener[] {
    const openers: ScriptOpener[] = [];
    for (const m of text.matchAll(OPENER_SCAN_RE)) {
        if (m.groups?.type !== 'script') {
            continue;
        }
        const offset = m.index!;
        openers.push({
            offset,
            lineEnd: offset + m[0].length,
            trailing: m.groups.trailing ?? '',
        });
    }
    return openers;
}

function diagnoseMalformedBlock(
    text: string,
    opener: ScriptOpener,
    toSourceRange: (start: number, end: number) => { start: number; end: number },
    where: string,
): InlineScriptMetadataProblem {
    const openerRange = toSourceRange(opener.offset, opener.lineEnd);

    if (opener.trailing.length > 0) {
        traceWarn(
            `inline script metadata${where}: the \`# /// script\` marker on line ${countLines(text, opener.offset)} has trailing whitespace`,
        );
        return {
            code: 'invalid-block-marker',
            severity: 'error',
            sourceRange: openerRange,
            detail: `${OPENER_PREFIX}script${opener.trailing}`,
        };
    }

    let offset = opener.lineEnd + 1; // first character of the line after the opener
    while (offset <= text.length) {
        const lineEnd = lineEndOffset(text, offset);
        const line = text.slice(offset, lineEnd);

        if (line === CLOSER_LINE) {
            break;
        }

        if (line !== line.trimEnd() && line.trimEnd() === CLOSER_LINE) {
            traceWarn(
                `inline script metadata${where}: the closing \`# ///\` marker on line ${countLines(text, offset)} has trailing whitespace`,
            );
            return {
                code: 'invalid-block-marker',
                severity: 'error',
                sourceRange: toSourceRange(offset, lineEnd),
                detail: line,
            };
        }

        if (!isValidContentLine(line)) {
            if (line.startsWith('#')) {
                traceWarn(
                    `inline script metadata${where}: invalid content line ${countLines(text, offset)} ` +
                        `(expected '#' or '# '): ${JSON.stringify(line)}`,
                );
                return {
                    code: 'invalid-content-line',
                    severity: 'error',
                    sourceRange: toSourceRange(offset, lineEnd),
                    detail: line,
                };
            }
            break;
        }

        if (lineEnd >= text.length) {
            break;
        }
        offset = lineEnd + 1;
    }

    traceWarn(
        `inline script metadata${where}: the \`# /// script\` block on line ${countLines(text, opener.offset)} is missing its closing \`# ///\` marker`,
    );
    return { code: 'unterminated-block', severity: 'warning', sourceRange: openerRange };
}

function isValidContentLine(line: string): boolean {
    if (line.length === 0 || line[0] !== '#') {
        return false;
    }
    return line.length === 1 || line[1] === ' ';
}

function getTomlErrorPosition(err: unknown): { row: number; column: number } | undefined {
    if (typeof err !== 'object' || err === null) {
        return undefined;
    }
    const { line, col } = err as { line?: unknown; col?: unknown };
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 0) {
        return undefined;
    }
    const column = typeof col === 'number' && Number.isInteger(col) && col >= 0 ? col : 0;
    return { row: line, column };
}

/** `@iarna/toml` reports `col` one past the offending character, and overshoots the line end entirely on end-of-line failures. */
function tomlErrorSourceRange(
    text: string,
    reconstructedOrigins: readonly number[],
    position: { row: number; column: number } | undefined,
    matchStart: number,
    toSourceRange: (start: number, end: number) => { start: number; end: number },
): { start: number; end: number } {
    if (position === undefined || position.row >= reconstructedOrigins.length) {
        return toSourceRange(matchStart, lineEndOffset(text, matchStart));
    }
    const origin = reconstructedOrigins[position.row];
    const lineEnd = lineEndOffset(text, origin);
    const offending = origin + Math.max(0, position.column - 1);
    const start = offending < lineEnd ? offending : origin;
    return toSourceRange(Math.min(start, lineEnd), lineEnd);
}

function findKeyRange(
    reconstructed: readonly string[],
    reconstructedOrigins: readonly number[],
    key: string,
    toSourceRange: (start: number, end: number) => { start: number; end: number },
): { start: number; end: number } | undefined {
    for (const [index, line] of reconstructed.entries()) {
        const leadingWhitespace = line.length - line.trimStart().length;
        const trimmed = line.slice(leadingWhitespace);
        if (!trimmed.startsWith(key)) {
            continue;
        }
        const after = trimmed.slice(key.length).trimStart();
        if (!after.startsWith('=')) {
            continue;
        }
        const origin = reconstructedOrigins[index];
        return toSourceRange(origin + leadingWhitespace, origin + line.length);
    }
    return undefined;
}

/**
 * Condense a TOML parse failure to a single clause. `@iarna/toml` messages are
 * multi-line ("Unterminated string at row 1, col 27, pos 26:" followed by an
 * excerpt and a caret) and their row/col index the reconstructed payload rather
 * than the script, so both the excerpt and the coordinates are dropped here; the
 * caller reports a real script line instead.
 */
function describeTomlError(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    const firstLine = message.split('\n')[0].trim();
    const withoutCoordinates = firstLine.replace(/\s*at row \d+, col \d+, pos \d+:?$/, '');
    const condensed = (withoutCoordinates || firstLine).replace(/:$/, '').trim();
    return condensed.length > 0 ? condensed : 'could not be parsed';
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

export function sliceHeaderBytes(text: string): string {
    const buffer = Buffer.from(text, 'utf-8');
    if (buffer.byteLength <= MAX_HEADER_BYTES) {
        return text;
    }
    return buffer.subarray(0, MAX_HEADER_BYTES).toString('utf-8');
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

    return readInlineScriptMetadata(text, uri.fsPath);
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
    const parsedSpecifier = PythonVersionSpecifier.tryParse(requiresPython);
    if (!parsedSpecifier) {
        traceWarn(`inline script metadata: invalid requires-python specifier: ${JSON.stringify(requiresPython)}`);
        return false;
    }
    return parsedSpecifier.matches(parsedVersion);
}
