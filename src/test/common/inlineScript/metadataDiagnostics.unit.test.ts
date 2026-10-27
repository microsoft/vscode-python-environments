// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as sinon from 'sinon';
import {
    InlineScriptMetadataParseResult,
    InlineScriptMetadataProblem,
    InlineScriptMetadataProblemCode,
    MAX_HEADER_BYTES,
    parseInlineScriptMetadata,
    readInlineScriptMetadata,
    sliceHeaderBytes,
} from '../../../common/inlineScript/metadata';
import * as logging from '../../../common/logging';

const VARIANTS: ReadonlyArray<{ name: string; build: (lines: string[]) => string }> = [
    { name: 'LF', build: (lines) => lines.join('\n') },
    { name: 'CRLF', build: (lines) => lines.join('\r\n') },
    { name: 'BOM + LF', build: (lines) => `\uFEFF${lines.join('\n')}` },
    { name: 'BOM + CRLF', build: (lines) => `\uFEFF${lines.join('\r\n')}` },
];

function underlined(source: string, problem: InlineScriptMetadataProblem): string {
    return source.slice(problem.sourceRange.start, problem.sourceRange.end);
}

function problems(result: InlineScriptMetadataParseResult): readonly InlineScriptMetadataProblem[] {
    return result.kind === 'none' ? [] : result.problems;
}

function onlyProblem(result: InlineScriptMetadataParseResult): InlineScriptMetadataProblem {
    const found = problems(result);
    assert.strictEqual(found.length, 1, `expected exactly one problem, got: ${found.map((p) => p.code).join(', ')}`);
    return found[0];
}

function assertProblemAcrossVariants(
    lines: string[],
    code: InlineScriptMetadataProblemCode,
    expectedText: string,
): void {
    for (const variant of VARIANTS) {
        const source = variant.build(lines);
        const result = parseInlineScriptMetadata(source);
        assert.strictEqual(result.kind, 'invalid', `[${variant.name}] expected an invalid result`);
        const problem = onlyProblem(result);
        assert.strictEqual(problem.code, code, `[${variant.name}] wrong problem code`);
        assert.strictEqual(underlined(source, problem), expectedText, `[${variant.name}] wrong underlined text`);
        assert.strictEqual(
            readInlineScriptMetadata(source),
            undefined,
            `[${variant.name}] wrapper should be undefined`,
        );
    }
}

suite('inlineScriptMetadata diagnostics', () => {
    setup(() => {
        sinon.stub(logging, 'traceWarn');
        sinon.stub(logging, 'traceVerbose');
    });

    teardown(() => {
        sinon.restore();
    });

    suite('malformed vs. absent', () => {
        test('empty input reports no block', () => {
            assert.strictEqual(parseInlineScriptMetadata('').kind, 'none');
        });

        test('ordinary Python reports no block', () => {
            const text = ['#!/usr/bin/env python3', 'import sys', 'print("hello")'].join('\n');
            assert.strictEqual(parseInlineScriptMetadata(text).kind, 'none');
        });

        test('a comment that merely mentions the marker is not a block', () => {
            const text = ['# see the `# /// script` docs', 'print("hi")'].join('\n');
            assert.strictEqual(parseInlineScriptMetadata(text).kind, 'none');
        });

        test('a non-script block type is left alone', () => {
            const text = ['# /// pyproject', '# x = 1'].join('\n');
            assert.strictEqual(parseInlineScriptMetadata(text).kind, 'none');
        });

        test('a well-formed block is valid with no problems', () => {
            const text = ['# /// script', '# dependencies = ["requests"]', '# ///', 'print("hi")'].join('\n');
            const result = parseInlineScriptMetadata(text);
            assert.strictEqual(result.kind, 'parsed');
            assert.deepStrictEqual(problems(result), []);
        });

        test('a missing closing marker is reported rather than silently ignored', () => {
            const text = ['# /// script', '# dependencies = ["requests"]', 'print("hi")'].join('\n');
            const result = parseInlineScriptMetadata(text);
            assert.strictEqual(result.kind, 'invalid');
            assert.strictEqual(onlyProblem(result).code, 'unterminated-block');
        });
    });

    suite('problem ranges across BOM and CRLF', () => {
        test('unterminated block underlines the opening marker', () => {
            assertProblemAcrossVariants(
                ['# /// script', '# dependencies = ["requests"]', 'print("hi")'],
                'unterminated-block',
                '# /// script',
            );
        });

        test('unterminated block after leading content still underlines its own marker', () => {
            assertProblemAcrossVariants(
                ['#!/usr/bin/env python3', '# a comment', '', '# /// script', '# dependencies = []', 'print("hi")'],
                'unterminated-block',
                '# /// script',
            );
        });

        test('unterminated block at end of file with no trailing newline', () => {
            assertProblemAcrossVariants(['# /// script', '# x = 1'], 'unterminated-block', '# /// script');
        });

        test('an empty block is valid per the prose spec, not a problem', () => {
            for (const variant of VARIANTS) {
                const source = variant.build(['# /// script', '# ///', 'print("hi")']);
                const result = parseInlineScriptMetadata(source);
                assert.strictEqual(result.kind, 'parsed', `[${variant.name}] expected a valid result`);
                assert.deepStrictEqual(problems(result), [], `[${variant.name}] expected no problems`);
            }
        });

        test('opening marker with trailing whitespace underlines the whole marker', () => {
            assertProblemAcrossVariants(['# /// script ', '# x = 1', '# ///'], 'invalid-block-marker', '# /// script ');
        });

        test('closing marker with trailing whitespace underlines the closer', () => {
            assertProblemAcrossVariants(
                ['# /// script', '# x = 1', '# /// ', 'print("hi")'],
                'invalid-block-marker',
                '# /// ',
            );
        });

        test('invalid content line underlines that line', () => {
            assertProblemAcrossVariants(
                ['# /// script', '# x = 1', '#no-space-after-hash', '# ///'],
                'invalid-content-line',
                '#no-space-after-hash',
            );
        });

        test('multiple blocks underline the redundant marker, not the first', () => {
            for (const variant of VARIANTS) {
                const source = variant.build([
                    '# /// script',
                    '# dependencies = ["a"]',
                    '# ///',
                    'print("hi")',
                    '# /// script',
                    '# dependencies = ["b"]',
                    '# ///',
                ]);
                const result = parseInlineScriptMetadata(source);
                assert.strictEqual(result.kind, 'invalid', `[${variant.name}] expected invalid`);
                const problem = onlyProblem(result);
                assert.strictEqual(problem.code, 'multiple-blocks');
                assert.strictEqual(underlined(source, problem), '# /// script');
                assert.ok(
                    problem.sourceRange.start > source.indexOf('print'),
                    `[${variant.name}] should anchor on the SECOND block`,
                );
            }
        });
    });

    suite('TOML errors', () => {
        test('column information underlines the offending text, not the whole block', () => {
            for (const variant of VARIANTS) {
                const source = variant.build(['# /// script', '# requires-python = >=3.11', '# ///']);
                const result = parseInlineScriptMetadata(source);
                assert.strictEqual(result.kind, 'invalid', `[${variant.name}] expected invalid`);
                const problem = onlyProblem(result);
                assert.strictEqual(problem.code, 'invalid-toml');
                assert.strictEqual(underlined(source, problem), '>=3.11', `[${variant.name}] wrong underlined text`);
            }
        });

        test('an end-of-line failure underlines the whole line rather than collapsing to nothing', () => {
            for (const variant of VARIANTS) {
                const source = variant.build(['# /// script', '# dependencies = ["requests', '# ///']);
                const result = parseInlineScriptMetadata(source);
                assert.strictEqual(result.kind, 'invalid', `[${variant.name}] expected invalid`);
                const problem = onlyProblem(result);
                assert.strictEqual(problem.code, 'invalid-toml');
                assert.strictEqual(
                    underlined(source, problem),
                    'dependencies = ["requests',
                    `[${variant.name}] wrong underlined text`,
                );
            }
        });

        test('error on a later line maps to that line', () => {
            for (const variant of VARIANTS) {
                const source = variant.build([
                    '# /// script',
                    '# requires-python = ">=3.11"',
                    '# dependencies = ["ok"]',
                    '# broken = ',
                    '# ///',
                ]);
                const result = parseInlineScriptMetadata(source);
                assert.strictEqual(result.kind, 'invalid', `[${variant.name}] expected invalid`);
                const problem = onlyProblem(result);
                assert.strictEqual(problem.code, 'invalid-toml');
                const lineStart = source.indexOf('# broken = ');
                assert.ok(
                    problem.sourceRange.start >= lineStart &&
                        problem.sourceRange.start <= lineStart + '# broken = '.length,
                    `[${variant.name}] expected range on the broken line, got ${problem.sourceRange.start} vs ${lineStart}`,
                );
            }
        });

        test('detail carries the raw parser message without coordinates', () => {
            const source = ['# /// script', '# dependencies = ["requests', '# ///'].join('\n');
            const problem = onlyProblem(parseInlineScriptMetadata(source));
            assert.strictEqual(problem.detail, 'Unterminated string');
            assert.ok(
                !/row \d+, col \d+/.test(problem.detail!),
                `detail should not leak payload coordinates: ${problem.detail}`,
            );
        });

        test('a non-comment line before an existing closer is bad content, not a missing marker', () => {
            assertProblemAcrossVariants(
                ['# /// script', '# requires-python = ">=3.11"', 'not_a_comment = 1', '# ///'],
                'invalid-content-line',
                'not_a_comment = 1',
            );
        });

        test('a blank line before an existing closer is bad content, not a missing marker', () => {
            for (const variant of VARIANTS) {
                const source = variant.build([
                    '# /// script',
                    '# requires-python = ">=3.11"',
                    '',
                    '# dependencies = []',
                    '# ///',
                ]);
                const problem = onlyProblem(parseInlineScriptMetadata(source));
                assert.strictEqual(problem.code, 'invalid-content-line', `[${variant.name}] wrong problem code`);
                assert.strictEqual(problem.severity, 'error', `[${variant.name}] wrong severity`);
                assert.strictEqual(problem.detail, '', `[${variant.name}] expected the blank line as detail`);
            }
        });

        test('a non-comment line with no closer ahead stays a missing-marker warning', () => {
            assertProblemAcrossVariants(
                ['# /// script', '# requires-python = ">=3.11"', 'not_a_comment = 1'],
                'unterminated-block',
                '# /// script',
            );
        });

        test('a closer belonging to a later block does not absolve an unclosed one', () => {
            for (const variant of VARIANTS) {
                const source = variant.build([
                    '# /// script',
                    '# x = 1',
                    'code = 1',
                    '# /// script',
                    '# y = 2',
                    '# ///',
                ]);
                const problem = onlyProblem(parseInlineScriptMetadata(source));
                assert.strictEqual(problem.code, 'unterminated-block', `[${variant.name}] wrong problem code`);
                assert.strictEqual(underlined(source, problem), '# /// script', `[${variant.name}] wrong range`);
            }
        });
    });

    suite('field types', () => {
        test('requires-python of the wrong type underlines its key line', () => {
            assertProblemAcrossVariants(
                ['# /// script', '# requires-python = 3.11', '# ///'],
                'invalid-field-type',
                '# requires-python = 3.11'.slice(2),
            );
        });

        test('dependencies of the wrong type underlines its key line', () => {
            assertProblemAcrossVariants(
                ['# /// script', '# dependencies = "requests"', '# ///'],
                'invalid-field-type',
                'dependencies = "requests"',
            );
        });

        test('a mixed-type dependencies array is rejected by the TOML parser itself', () => {
            const source = ['# /// script', '# dependencies = ["ok", 3]', '# ///'].join('\n');
            const problem = onlyProblem(parseInlineScriptMetadata(source));
            assert.strictEqual(problem.code, 'invalid-toml');
        });

        test('tool of the wrong type is reported', () => {
            const source = ['# /// script', '# tool = "uv"', '# ///'].join('\n');
            const problem = onlyProblem(parseInlineScriptMetadata(source));
            assert.strictEqual(problem.code, 'invalid-field-type');
            assert.strictEqual(problem.detail, 'tool');
        });

        test('a similarly-named key does not steal the range', () => {
            const source = ['# /// script', '# dependencies-extra = "x"', '# dependencies = "requests"', '# ///'].join(
                '\n',
            );
            const problem = onlyProblem(parseInlineScriptMetadata(source));
            assert.strictEqual(underlined(source, problem), 'dependencies = "requests"');
        });
    });

    suite('valid metadata alongside a broken block', () => {
        test('a stray opener after a valid block is reported without withholding metadata', () => {
            const source = [
                '# /// script',
                '# dependencies = ["requests"]',
                '# ///',
                '',
                '# /// script',
                '# dependencies = ["oops"]',
            ].join('\n');
            const result = parseInlineScriptMetadata(source);
            assert.strictEqual(result.kind, 'parsed');
            assert.deepStrictEqual(result.kind === 'parsed' ? result.metadata.dependencies : undefined, ['requests']);
            const problem = onlyProblem(result);
            assert.strictEqual(problem.code, 'unterminated-block');
            assert.strictEqual(problem.severity, 'warning');
            assert.ok(readInlineScriptMetadata(source), 'wrapper should still return the valid metadata');
        });

        test('parsed metadata can still carry error-severity problems', () => {
            const source = ['# /// script', '# x = 1', '# ///', '', '# /// script', '#bad'].join('\n');
            const result = parseInlineScriptMetadata(source);
            assert.strictEqual(result.kind, 'parsed', 'metadata is usable even though the file has an error');
            const problem = onlyProblem(result);
            assert.strictEqual(problem.code, 'invalid-content-line');
            assert.strictEqual(problem.severity, 'error');
            assert.ok(readInlineScriptMetadata(source), 'the wrapper still yields metadata');
        });

        test('a malformed example below real code stays silent, closer or not', () => {
            const source = ['print("x")', '"""', '# /// script', '# deps = []', 'prose line', '# ///', '"""'].join(
                '\n',
            );
            const result = parseInlineScriptMetadata(source);
            assert.strictEqual(result.kind, 'none');
            assert.deepStrictEqual(problems(result), []);
        });

        test('an unclosed block below real code is ignored, as the spec requires', () => {
            const source = ['"""', '# /// script', '# dependencies = ["docs"]', '"""', 'print("hi")'].join('\n');
            const result = parseInlineScriptMetadata(source);
            assert.strictEqual(result.kind, 'none');
            assert.deepStrictEqual(problems(result), []);
        });

        test('a marker quoted inside a valid block is not a second block', () => {
            const source = ['# /// script', '# # /// script', '# dependencies = []', '# ///'].join('\n');
            const result = parseInlineScriptMetadata(source);
            assert.strictEqual(result.kind, 'parsed');
            assert.deepStrictEqual(problems(result), []);
        });
    });

    suite('severity', () => {
        test('spec violations are errors and mid-edit states are warnings', () => {
            const cases: ReadonlyArray<[string[], InlineScriptMetadataProblemCode, 'error' | 'warning']> = [
                [['# /// script', '# x = 1'], 'unterminated-block', 'warning'],
                [['# /// script', '#bad', '# ///'], 'invalid-content-line', 'error'],
                [['# /// script ', '# x = 1', '# ///'], 'invalid-block-marker', 'error'],
                [['# /// script', '# x = ', '# ///'], 'invalid-toml', 'error'],
                [['# /// script', '# tool = "uv"', '# ///'], 'invalid-field-type', 'error'],
            ];
            for (const [lines, code, severity] of cases) {
                const problem = onlyProblem(parseInlineScriptMetadata(lines.join('\n')));
                assert.strictEqual(problem.code, code, `wrong code for ${JSON.stringify(lines)}`);
                assert.strictEqual(problem.severity, severity, `wrong severity for ${code}`);
            }
        });
    });

    suite('sliceHeaderBytes', () => {
        test('short text is returned unchanged', () => {
            const text = '# /// script\n# ///\n';
            assert.strictEqual(sliceHeaderBytes(text), text);
        });

        test('text is clipped to the same byte budget the file reader uses', () => {
            const text = 'x'.repeat(MAX_HEADER_BYTES + 100);
            assert.strictEqual(Buffer.byteLength(sliceHeaderBytes(text), 'utf-8'), MAX_HEADER_BYTES);
        });

        test('clipping is by bytes, so multi-byte characters count for more than one', () => {
            const text = 'é'.repeat(MAX_HEADER_BYTES);
            assert.strictEqual(sliceHeaderBytes(text).length, MAX_HEADER_BYTES / 2);
        });

        test('a block beyond the budget is invisible, matching the on-disk reader', () => {
            const padding = `${'# padding\n'.repeat(Math.ceil(MAX_HEADER_BYTES / 10))}`;
            const text = `${padding}# /// script\n# dependencies = []\n# ///\n`;
            assert.strictEqual(parseInlineScriptMetadata(sliceHeaderBytes(text)).kind, 'none');
        });
    });
});
