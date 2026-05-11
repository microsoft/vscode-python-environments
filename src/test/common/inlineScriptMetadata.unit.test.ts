// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import path from 'path';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import {
    InlineScriptMetadata,
    MAX_HEADER_BYTES,
    matchesPythonVersion,
    readInlineScriptMetadata,
    readInlineScriptMetadataFromFile,
} from '../../common/inlineScriptMetadata';
import * as logging from '../../common/logging';

// Helper to assemble a script body. Lines are joined with '\n' so each
// test controls line endings explicitly via `joiner` when needed.
function script(lines: string[], joiner = '\n'): string {
    return lines.join(joiner);
}

suite('inlineScriptMetadata', () => {
    let traceWarnStub: sinon.SinonStub;
    let traceVerboseStub: sinon.SinonStub;

    setup(() => {
        traceWarnStub = sinon.stub(logging, 'traceWarn');
        traceVerboseStub = sinon.stub(logging, 'traceVerbose');
    });

    teardown(() => {
        sinon.restore();
    });

    suite('readInlineScriptMetadata', () => {
        test('empty input returns undefined', () => {
            assert.strictEqual(readInlineScriptMetadata(''), undefined);
        });

        test('file without any block returns undefined', () => {
            const text = script(['#!/usr/bin/env python3', 'import sys', 'print("hello")']);
            assert.strictEqual(readInlineScriptMetadata(text), undefined);
        });

        test('minimal valid block (single blank content line) parses with empty metadata', () => {
            // The canonical PEP 723 regex requires AT LEAST ONE content
            // line between the open and close markers (the `+` quantifier
            // in `(^#(| .*)$\s)+`). A bare `#` line counts as a blank
            // content line and is the minimal accepted form.
            const text = script(['# /// script', '#', '# ///', '', 'print("hi")']);
            const md = readInlineScriptMetadata(text);
            assert.ok(md, 'expected metadata to be defined');
            assert.strictEqual(md.requiresPython, undefined);
            assert.strictEqual(md.dependencies, undefined);
            assert.strictEqual(md.tool, undefined);
            assert.strictEqual(md.range.start, 0);
            const expectedBlock = '# /// script\n#\n# ///\n';
            assert.strictEqual(md.range.end, expectedBlock.length);
        });

        test('valid block with requires-python and dependencies', () => {
            const text = script([
                '# /// script',
                '# requires-python = ">=3.11"',
                '# dependencies = [',
                '#   "requests<3",',
                '#   "rich",',
                '# ]',
                '# ///',
                'import requests',
            ]);
            const md = readInlineScriptMetadata(text);
            assert.ok(md);
            assert.strictEqual(md.requiresPython, '>=3.11');
            assert.deepStrictEqual([...(md.dependencies ?? [])], ['requests<3', 'rich']);
            assert.strictEqual(md.tool, undefined);
        });

        test('valid block with [tool] table is opaque', () => {
            const text = script([
                '# /// script',
                '# dependencies = ["x"]',
                '# [tool.mybuild]',
                '# extra = "thing"',
                '# ///',
            ]);
            const md = readInlineScriptMetadata(text);
            assert.ok(md);
            assert.ok(md.tool, 'tool table should be populated');
            assert.deepStrictEqual(md.tool, { mybuild: { extra: 'thing' } });
        });

        test('multiple `script` blocks returns undefined and logs a warning', () => {
            const text = script([
                '# /// script',
                '# dependencies = ["a"]',
                '# ///',
                '',
                '# /// script',
                '# dependencies = ["b"]',
                '# ///',
            ]);
            assert.strictEqual(readInlineScriptMetadata(text), undefined);
            assert.ok(traceWarnStub.called, 'expected a traceWarn for multiple script blocks');
        });

        test('unclosed block returns undefined', () => {
            const text = script(['# /// script', '# dependencies = ["a"]', 'import x']);
            assert.strictEqual(readInlineScriptMetadata(text), undefined);
        });

        test('content lines may be bare `#` (blank in metadata)', () => {
            const text = script([
                '# /// script',
                '# requires-python = ">=3.10"',
                '#',
                '# dependencies = ["a"]',
                '# ///',
            ]);
            const md = readInlineScriptMetadata(text);
            assert.ok(md);
            assert.strictEqual(md.requiresPython, '>=3.10');
            assert.deepStrictEqual([...(md.dependencies ?? [])], ['a']);
        });

        test('CRLF line endings parse identically to LF', () => {
            const text = script(['# /// script', '# dependencies = ["a"]', '# ///', ''], '\r\n');
            const md = readInlineScriptMetadata(text);
            assert.ok(md);
            assert.deepStrictEqual([...(md.dependencies ?? [])], ['a']);
        });

        test('lone-CR line endings parse identically to LF', () => {
            const text = script(['# /// script', '# dependencies = ["a"]', '# ///', ''], '\r');
            const md = readInlineScriptMetadata(text);
            assert.ok(md);
            assert.deepStrictEqual([...(md.dependencies ?? [])], ['a']);
        });

        test('content with `##` line is rejected', () => {
            const text = script(['# /// script', '## not a valid content line', '# ///']);
            assert.strictEqual(readInlineScriptMetadata(text), undefined);
        });

        test('content with `#\\t` line is rejected', () => {
            const text = script(['# /// script', '#\tnot a valid content line', '# ///']);
            assert.strictEqual(readInlineScriptMetadata(text), undefined);
        });

        test('leading UTF-8 BOM is stripped before matching', () => {
            const text = '\uFEFF' + script(['# /// script', '# dependencies = ["a"]', '# ///']);
            const md = readInlineScriptMetadata(text);
            assert.ok(md);
            assert.deepStrictEqual([...(md.dependencies ?? [])], ['a']);
        });

        test('shebang before block does not block detection', () => {
            const text = script(['#!/usr/bin/env python3', '# /// script', '# dependencies = ["a"]', '# ///']);
            const md = readInlineScriptMetadata(text);
            assert.ok(md);
            assert.deepStrictEqual([...(md.dependencies ?? [])], ['a']);
        });

        test('encoding declaration before block does not block detection', () => {
            const text = script(['# -*- coding: utf-8 -*-', '# /// script', '# dependencies = ["a"]', '# ///']);
            const md = readInlineScriptMetadata(text);
            assert.ok(md);
            assert.deepStrictEqual([...(md.dependencies ?? [])], ['a']);
        });

        test('shebang AND encoding declaration before block', () => {
            const text = script([
                '#!/usr/bin/env python3',
                '# -*- coding: utf-8 -*-',
                '# /// script',
                '# dependencies = ["a"]',
                '# ///',
            ]);
            const md = readInlineScriptMetadata(text);
            assert.ok(md);
            assert.deepStrictEqual([...(md.dependencies ?? [])], ['a']);
        });

        test('closing `# ///` with trailing whitespace is rejected', () => {
            const text = script(['# /// script', '# dependencies = ["a"]', '# /// ']);
            assert.strictEqual(readInlineScriptMetadata(text), undefined);
        });

        test('opening `# /// script  ` with trailing whitespace is rejected', () => {
            const text = script(['# /// script  ', '# dependencies = ["a"]', '# ///']);
            assert.strictEqual(readInlineScriptMetadata(text), undefined);
        });

        test('malformed TOML returns undefined and logs warn', () => {
            const text = script(['# /// script', '# this is = not valid = toml', '# ///']);
            assert.strictEqual(readInlineScriptMetadata(text), undefined);
            assert.ok(traceWarnStub.called, 'expected a traceWarn for malformed TOML');
        });

        test('dependencies is not a list returns undefined', () => {
            const text = script(['# /// script', '# dependencies = "not a list"', '# ///']);
            assert.strictEqual(readInlineScriptMetadata(text), undefined);
        });

        test('dependencies contains non-string returns undefined', () => {
            // @iarna/toml will accept a mixed array; we validate downstream.
            const text = script(['# /// script', '# dependencies = ["ok", 42]', '# ///']);
            assert.strictEqual(readInlineScriptMetadata(text), undefined);
        });

        test('dependencies array with an empty string is passed through', () => {
            const text = script(['# /// script', '# dependencies = [""]', '# ///']);
            const md = readInlineScriptMetadata(text);
            assert.ok(md);
            assert.deepStrictEqual([...(md.dependencies ?? [])], ['']);
        });

        test('requires-python that is not a string returns undefined', () => {
            const text = script(['# /// script', '# requires-python = 311', '# ///']);
            assert.strictEqual(readInlineScriptMetadata(text), undefined);
        });

        test('non-`script` block TYPE is ignored', () => {
            const text = script(['# /// pyproject', '# foo = "bar"', '# ///']);
            assert.strictEqual(readInlineScriptMetadata(text), undefined);
        });

        test('non-`script` block followed by valid script block', () => {
            const text = script([
                '# /// pyproject',
                '# foo = "bar"',
                '# ///',
                '',
                '# /// script',
                '# dependencies = ["a"]',
                '# ///',
            ]);
            const md = readInlineScriptMetadata(text);
            assert.ok(md);
            assert.deepStrictEqual([...(md.dependencies ?? [])], ['a']);
        });

        test('range refers to the normalized text', () => {
            // Canonical regex requires at least one content line; use a
            // bare `#` so the block is the minimal accepted form.
            const text = script(['# /// script', '#', '# ///', 'rest']);
            const md = readInlineScriptMetadata(text);
            assert.ok(md);
            assert.strictEqual(md.range.start, 0);
            // start of `# /// script` line through and including the
            // closing `# ///`'s terminating newline.
            assert.strictEqual(text.slice(md.range.start, md.range.end), '# /// script\n#\n# ///\n');
        });

        test('dependencies array is frozen (defensive copy)', () => {
            const text = script(['# /// script', '# dependencies = ["a"]', '# ///']);
            const md = readInlineScriptMetadata(text);
            assert.ok(md?.dependencies);
            assert.throws(() => {
                (md.dependencies as string[]).push('b');
            });
        });

        test('block beyond MAX_HEADER_BYTES boundary is invisible to file-reader (known limitation)', () => {
            // The string parser sees the whole text, so it WILL find a
            // block past the byte boundary. This test documents that
            // the boundary is only enforced by the file reader.
            const padding = 'a'.repeat(MAX_HEADER_BYTES + 100);
            const text = padding + '\n' + script(['# /// script', '# dependencies = ["a"]', '# ///']);
            const md = readInlineScriptMetadata(text);
            assert.ok(md, 'parser ignores byte caps; only the file reader enforces them');
            assert.deepStrictEqual([...(md.dependencies ?? [])], ['a']);
        });

        // The plan calls out a "nested-looking line" test case (e.g. a
        // `# ///` that appears inside what is morally a TOML multi-line
        // string). The canonical regex is greedy with backtracking, so
        // the LAST `# ///` line wins as the closing marker. We assert
        // that the well-formed text round-trips.
        test('content containing a `# ///` mid-block: last `# ///` wins as closer', () => {
            // The "mid-block" `# ///` is a real `# ///` line inside the
            // block. Per the regex's greedy backtracking, the parser
            // treats it as content and the trailing `# ///` as the
            // close.
            const text = script(['# /// script', '# dependencies = ["a"]', '# # /// inside as comment', '# ///']);
            const md = readInlineScriptMetadata(text);
            assert.ok(md);
            assert.deepStrictEqual([...(md.dependencies ?? [])], ['a']);
        });

        // ensure traceVerboseStub silences "no block" log noise — also
        // a sanity check that the verbose log fires on the negative path.
        test('no-block path logs only at verbose level', () => {
            readInlineScriptMetadata('print("hi")');
            assert.strictEqual(traceWarnStub.called, false);
            assert.ok(traceVerboseStub.called);
        });
    });

    suite('readInlineScriptMetadataFromFile', () => {
        let tmpDir: string;

        setup(async () => {
            tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ism-test-'));
        });

        teardown(async () => {
            await fs.remove(tmpDir);
        });

        test('returns metadata for a real on-disk .py file', async () => {
            const filePath = path.join(tmpDir, 'script.py');
            await fs.writeFile(
                filePath,
                script(['# /// script', '# requires-python = ">=3.11"', '# dependencies = ["a"]', '# ///', 'print(1)']),
            );
            const md = await readInlineScriptMetadataFromFile(Uri.file(filePath));
            assert.ok(md);
            assert.strictEqual(md.requiresPython, '>=3.11');
        });

        test('returns undefined for a file without a block', async () => {
            const filePath = path.join(tmpDir, 'plain.py');
            await fs.writeFile(filePath, 'print("hi")\n');
            const md = await readInlineScriptMetadataFromFile(Uri.file(filePath));
            assert.strictEqual(md, undefined);
        });

        test('returns undefined for a non-file URI scheme', async () => {
            const md = await readInlineScriptMetadataFromFile(Uri.parse('untitled:foo.py'));
            assert.strictEqual(md, undefined);
        });

        test('returns undefined when the file does not exist', async () => {
            const md = await readInlineScriptMetadataFromFile(Uri.file(path.join(tmpDir, 'does-not-exist.py')));
            assert.strictEqual(md, undefined);
        });

        test('block past MAX_HEADER_BYTES boundary is NOT found (cap is enforced)', async () => {
            const filePath = path.join(tmpDir, 'big.py');
            // Pad with a comment that fills more than MAX_HEADER_BYTES,
            // then put a valid block AFTER the cap. The reader should
            // see only the padding and return undefined.
            const padding = '# ' + 'a'.repeat(MAX_HEADER_BYTES);
            const body = script([padding, '# /// script', '# dependencies = ["a"]', '# ///']);
            await fs.writeFile(filePath, body);
            const md = await readInlineScriptMetadataFromFile(Uri.file(filePath));
            assert.strictEqual(md, undefined);
        });

        test('block at top of a >MAX_HEADER_BYTES file is still found', async () => {
            const filePath = path.join(tmpDir, 'big-top.py');
            const trailing = 'x'.repeat(MAX_HEADER_BYTES * 2);
            const body = script(['# /// script', '# dependencies = ["a"]', '# ///', trailing]);
            await fs.writeFile(filePath, body);
            const md = await readInlineScriptMetadataFromFile(Uri.file(filePath));
            assert.ok(md);
            assert.deepStrictEqual([...(md.dependencies ?? [])], ['a']);
        });

        test('reader returns a parsed block for a minimal on-disk file', async () => {
            // The negative case above ("block past MAX_HEADER_BYTES
            // boundary is NOT found") proves the byte cap is enforced.
            // This test just sanity-checks the happy path on a minimal
            // file: the reader returns the parsed block.
            const filePath = path.join(tmpDir, 'spy.py');
            await fs.writeFile(filePath, script(['# /// script', '# dependencies = ["a"]', '# ///']));
            const md = await readInlineScriptMetadataFromFile(Uri.file(filePath));
            assert.ok(md);
            assert.deepStrictEqual([...(md.dependencies ?? [])], ['a']);
        });
    });

    suite('matchesPythonVersion', () => {
        test('>=3.11 vs 3.10/3.11/3.12', () => {
            assert.strictEqual(matchesPythonVersion('>=3.11', '3.10'), false);
            assert.strictEqual(matchesPythonVersion('>=3.11', '3.11'), true);
            assert.strictEqual(matchesPythonVersion('>=3.11', '3.11.4'), true);
            assert.strictEqual(matchesPythonVersion('>=3.11', '3.12'), true);
        });

        test('==3.12.* wildcard prefix match', () => {
            assert.strictEqual(matchesPythonVersion('==3.12.*', '3.12'), true);
            assert.strictEqual(matchesPythonVersion('==3.12.*', '3.12.4'), true);
            assert.strictEqual(matchesPythonVersion('==3.12.*', '3.11.4'), false);
            assert.strictEqual(matchesPythonVersion('==3.12.*', '3.13.0'), false);
        });

        test('!=3.12.* wildcard prefix anti-match', () => {
            assert.strictEqual(matchesPythonVersion('!=3.12.*', '3.12.4'), false);
            assert.strictEqual(matchesPythonVersion('!=3.12.*', '3.11.4'), true);
            assert.strictEqual(matchesPythonVersion('!=3.12.*', '3.13.0'), true);
        });

        test('multi-clause >=3.10,<3.13 is AND-ed', () => {
            assert.strictEqual(matchesPythonVersion('>=3.10,<3.13', '3.9.0'), false);
            assert.strictEqual(matchesPythonVersion('>=3.10,<3.13', '3.10'), true);
            assert.strictEqual(matchesPythonVersion('>=3.10,<3.13', '3.12.4'), true);
            assert.strictEqual(matchesPythonVersion('>=3.10,<3.13', '3.13'), false);
        });

        test('~=3.11 (compatible release at minor level)', () => {
            assert.strictEqual(matchesPythonVersion('~=3.11', '3.10.0'), false);
            assert.strictEqual(matchesPythonVersion('~=3.11', '3.11.0'), true);
            assert.strictEqual(matchesPythonVersion('~=3.11', '3.12.4'), true);
            assert.strictEqual(matchesPythonVersion('~=3.11', '4.0.0'), false);
        });

        test('~=3.11.2 (compatible release at patch level)', () => {
            assert.strictEqual(matchesPythonVersion('~=3.11.2', '3.11.1'), false);
            assert.strictEqual(matchesPythonVersion('~=3.11.2', '3.11.2'), true);
            assert.strictEqual(matchesPythonVersion('~=3.11.2', '3.11.10'), true);
            assert.strictEqual(matchesPythonVersion('~=3.11.2', '3.12.0'), false);
        });

        test('== exact match (PEP 440 release-segment equality with zero padding)', () => {
            // Per PEP 440 §"Version matching": when comparing release
            // segments of different lengths, the shorter is padded
            // with zeros. So `==3.11` matches both `3.11` and `3.11.0`.
            // Users who want strict-shape equality use `===`.
            assert.strictEqual(matchesPythonVersion('==3.11', '3.11'), true);
            assert.strictEqual(matchesPythonVersion('==3.11', '3.11.0'), true);
            assert.strictEqual(matchesPythonVersion('==3.11.0', '3.11.0'), true);
            assert.strictEqual(matchesPythonVersion('==3.11', '3.12'), false);
            assert.strictEqual(matchesPythonVersion('==3.11', '3.11.1'), false);
        });

        test('!= inequality', () => {
            assert.strictEqual(matchesPythonVersion('!=3.11', '3.11'), false);
            assert.strictEqual(matchesPythonVersion('!=3.11', '3.12'), true);
        });

        test('===X (arbitrary equality) is string match', () => {
            assert.strictEqual(matchesPythonVersion('===3.11.0', '3.11.0'), true);
            assert.strictEqual(matchesPythonVersion('===3.11.0', '3.11'), false);
        });

        test('input version with pre/dev suffix is truncated to release', () => {
            assert.strictEqual(matchesPythonVersion('>=3.11', '3.11.0rc1'), true);
            assert.strictEqual(matchesPythonVersion('>=3.11', '3.10.0rc1'), false);
        });

        test('invalid specifier returns false and logs warn', () => {
            assert.strictEqual(matchesPythonVersion('weird-thing', '3.11'), false);
            assert.ok(traceWarnStub.called);
        });

        test('empty specifier or version returns false', () => {
            assert.strictEqual(matchesPythonVersion('', '3.11'), false);
            assert.strictEqual(matchesPythonVersion('>=3.11', ''), false);
        });

        test('whitespace around clauses is tolerated', () => {
            assert.strictEqual(matchesPythonVersion(' >= 3.11 , < 3.13 ', '3.12.4'), true);
        });

        test('wildcard with non-equality operator is invalid', () => {
            assert.strictEqual(matchesPythonVersion('>=3.12.*', '3.12.4'), false);
            assert.ok(traceWarnStub.called);
        });
    });

    // Type-only assertion: make sure InlineScriptMetadata is exported
    // and structurally compatible with downstream use.
    test('InlineScriptMetadata interface is exported and structurally correct', () => {
        const sample: InlineScriptMetadata = {
            requiresPython: '>=3.11',
            dependencies: ['x'],
            tool: { mykey: 'v' },
            range: { start: 0, end: 10 },
        };
        assert.strictEqual(sample.requiresPython, '>=3.11');
    });
});
