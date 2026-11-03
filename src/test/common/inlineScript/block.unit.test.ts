// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import { findInlineScriptBlock } from '../../../common/inlineScript/block';
import { getInlineScriptSourceHash } from '../../../common/inlineScript/metadata';

suite('Inline script live block', () => {
    const block = '# /// script\n# dependencies = ["requests"]\n# ///';

    test('recognizes valid, empty, incomplete, and malformed blocks without parsing', () => {
        for (const text of [block, '# /// script\n# ///', '# /// script', `${block}\n# /// script`, '# /// script \n#bad']) {
            const found = findInlineScriptBlock(text);
            assert.ok(found, text);
            assert.strictEqual(found.start, 0);
            assert.ok(found.end >= found.start);
        }
    });

    test('does not recognize ordinary files, mentions, or other block types', () => {
        for (const text of ['', 'print("hello")', '# mentions # /// script', '# /// pyproject\n# ///', '# /// scripting']) {
            assert.strictEqual(findInlineScriptBlock(text), undefined, text);
        }
    });

    test('excludes Python code and the closing marker newline from the hash', () => {
        const expected = getInlineScriptSourceHash(block);
        assert.match(expected!, /^[a-f0-9]{64}$/);
        assert.strictEqual(getInlineScriptSourceHash(`${block}\nprint("first")`), expected);
        assert.strictEqual(getInlineScriptSourceHash(`${block}\nprint("second")\n`), expected);
        assert.strictEqual(getInlineScriptSourceHash(`#!/usr/bin/env python\n\n${block}`), expected);
        assert.strictEqual(getInlineScriptSourceHash(`${block}\n# ordinary comment`), expected);
    });

    test('fingerprints raw metadata changes rather than semantic dependency identity', () => {
        const expected = getInlineScriptSourceHash(block);
        for (const edited of [
            block.replace('requests', 'Requests'),
            block.replace(' = ', '='),
            block.replace('# dependencies', '# additional comment\n# dependencies'),
            block.replace('"requests"', '"requests'),
            block.slice(0, block.lastIndexOf('# ///')),
        ]) {
            assert.notStrictEqual(getInlineScriptSourceHash(edited), expected);
        }
    });

    test('keeps the first anchor but withholds the fingerprint for multiple blocks', () => {
        const original = findInlineScriptBlock(block)!;
        const multiple = findInlineScriptBlock(`${block}\nprint("body")\n${block}`)!;
        assert.strictEqual(multiple.start, original.start);
        assert.strictEqual(multiple.end, original.end);
        assert.strictEqual(getInlineScriptSourceHash(`${block}\nprint("body")\n${block}`), undefined);
    });

    test('preserves the source span across BOM, CRLF, and lone CR', () => {
        const expectedHash = getInlineScriptSourceHash(block);
        for (const newline of ['\n', '\r\n', '\r']) {
            const sourceBlock = block.replace(/\n/g, newline);
            const source = `\uFEFF${sourceBlock}${newline}print("body")`;
            const found = findInlineScriptBlock(source)!;
            assert.strictEqual(found.start, 1);
            assert.strictEqual(source.slice(found.start, found.end), sourceBlock);
            assert.strictEqual(getInlineScriptSourceHash(source), expectedHash);
        }
    });

    test('normalizes mixed line endings for editor and disk fingerprint comparison', () => {
        const mixed = '# /// script\r\n# dependencies = ["requests"]\n# ///';
        assert.strictEqual(getInlineScriptSourceHash(mixed), getInlineScriptSourceHash(block));
    });

    test('recognizes malformed content before a closing marker', () => {
        const source = '# /// script\nnot_a_comment\n# ///\nprint("body")';
        const found = findInlineScriptBlock(source)!;
        assert.strictEqual(source.slice(found.start, found.end), '# /// script\nnot_a_comment\n# ///');
    });

    test('includes embedded closing markers followed by further comment content', () => {
        const source = '# /// script\n# [tool.example]\n# value = """\n# ///\n# text\n# """\n# ///\nprint("body")';
        const hash = getInlineScriptSourceHash(source);
        assert.ok(hash);
        assert.notStrictEqual(
            getInlineScriptSourceHash(source.replace('# text', '# edited text')),
            hash,
        );
    });

    test('does not omit dependencies between embedded closing and opening markers', () => {
        const source = [
            '# /// script',
            '# note = """',
            '# ///',
            '# """',
            '# dependencies = ["requests"]',
            '# other = """',
            '# /// script',
            '# """',
            '# ///',
        ].join('\n');
        assert.notStrictEqual(
            getInlineScriptSourceHash(source),
            getInlineScriptSourceHash(source.replace('requests', 'httpx')),
        );
    });

    test('does not ignore a BOM inserted before a non-leading marker', () => {
        const source = `# prefix\n${block}`;
        assert.notStrictEqual(
            getInlineScriptSourceHash(source),
            getInlineScriptSourceHash(source.replace('# /// script', '\uFEFF# /// script')),
        );
    });

    test('withholds a fingerprint when a preceding non-script block consumes the script marker', () => {
        assert.ok(getInlineScriptSourceHash(`# note\n${block}`));
        assert.ok(findInlineScriptBlock(`# /// other\n${block}`), 'the setup action still needs an anchor');
        assert.strictEqual(getInlineScriptSourceHash(`# /// other\n${block}`), undefined);
    });

    test('does not fingerprint ignored unfinished metadata examples in the Python body', () => {
        const source = `${block}\n\n"""\n# /// script\n# dependencies = ["example"]\n"""\nprint("body")`;
        assert.strictEqual(getInlineScriptSourceHash(source), getInlineScriptSourceHash(block));
        assert.strictEqual(getInlineScriptSourceHash(source.replace('"body"', '"changed"')), getInlineScriptSourceHash(block));
    });

    test('fingerprinting does not parse TOML', () => {
        assert.ok(getInlineScriptSourceHash('# /// script\n# dependencies = [\n# ///'));
    });
});
