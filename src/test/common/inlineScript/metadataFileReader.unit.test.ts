// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import { MAX_HEADER_BYTES, readInlineScriptMetadataFromFile } from '../../../common/inlineScript/metadata';

suite('inline script metadata strict file reader', () => {
    const uri = Uri.file(path.join(process.cwd(), 'capability-fixtures', 'script.py'));

    teardown(() => sinon.restore());

    for (const code of ['EACCES', 'EIO', 'ENOENT', 'ENOTDIR', 'EISDIR']) {
        test(`strict and discovery modes handle ${code} independently`, async () => {
            const error = Object.assign(new Error(code), { code });
            sinon.stub(fs, 'open').rejects(error);
            assert.strictEqual(await readInlineScriptMetadataFromFile(uri), undefined);
            if (code === 'EACCES' || code === 'EIO') {
                await assert.rejects(readInlineScriptMetadataFromFile(uri, { strict: true }), (failure) => failure === error);
            } else {
                assert.strictEqual(await readInlineScriptMetadataFromFile(uri, { strict: true }), undefined);
            }
        });
    }

    function stubFile(text: string) {
        const read = sinon.stub().callsFake(async (buffer: Buffer, offset: number, length: number) => {
            const bytesRead = Buffer.from(text).copy(buffer, offset, 0, length);
            return { bytesRead, buffer };
        });
        const close = sinon.stub().resolves();
        sinon.stub(fs, 'open').resolves({ read, close } as unknown as fs.FileHandle);
        return { read, close };
    }

    for (const text of [
        'print("no metadata")',
        '# /// script\n# dependencies = [\n# ///\n',
        '# /// script\n# dependencies = "invalid"\n# ///\n',
        '# /// script\n# dependencies = []\n# ///\n# /// script\n# dependencies = []\n# ///\n',
    ]) {
        test(`strict mode rejects missing or invalid metadata: ${JSON.stringify(text)}`, async () => {
            const { close } = stubFile(text);
            assert.strictEqual(await readInlineScriptMetadataFromFile(uri, { strict: true }), undefined);
            assert.ok(close.calledOnce);
        });
    }

    test('strict mode rejects error diagnostics while discovery preserves its parsed block', async () => {
        stubFile('# /// script\n# dependencies = []\n# ///\n# /// script\n#bad\n');
        assert.ok(await readInlineScriptMetadataFromFile(uri));
        assert.strictEqual(await readInlineScriptMetadataFromFile(uri, { strict: true }), undefined);
    });

    test('strict mode shares the bounded read and parser with discovery', async () => {
        const { read, close } = stubFile('# /// script\n# dependencies = ["requests"]\n# ///\n' + 'x'.repeat(MAX_HEADER_BYTES * 2));
        const expected = await readInlineScriptMetadataFromFile(uri);
        assert.deepStrictEqual(await readInlineScriptMetadataFromFile(uri, { strict: true }), expected);
        assert.deepStrictEqual(expected?.dependencies, ['requests']);
        assert.ok(read.alwaysCalledWith(sinon.match.instanceOf(Buffer), 0, MAX_HEADER_BYTES, 0));
        assert.strictEqual(close.callCount, 2);
    });

    test('strict mode does not parse metadata beyond the header boundary', async () => {
        stubFile('# ' + 'x'.repeat(MAX_HEADER_BYTES) + '\n# /// script\n# dependencies = []\n# ///\n');
        assert.strictEqual(await readInlineScriptMetadataFromFile(uri, { strict: true }), undefined);
    });

    for (const operation of ['read', 'close'] as const) {
        test(`strict mode propagates ${operation} failures and always closes the handle`, async () => {
            const handle = stubFile('# /// script\n# dependencies = []\n# ///\n');
            const error = Object.assign(new Error(`${operation} failed`), { code: 'EIO' });
            handle[operation].rejects(error);
            await assert.rejects(readInlineScriptMetadataFromFile(uri, { strict: true }), (failure) => failure === error);
            assert.ok(handle.close.calledOnce);
            assert.strictEqual(await readInlineScriptMetadataFromFile(uri), undefined);
            assert.strictEqual(handle.close.callCount, 2);
        });
    }

    test('strict mode ignores non-file URIs without opening the filesystem', async () => {
        const open = sinon.stub(fs, 'open').rejects(new Error('Unexpected filesystem access'));
        assert.strictEqual(await readInlineScriptMetadataFromFile(Uri.parse('untitled:script.py'), { strict: true }), undefined);
        assert.ok(open.notCalled);
    });
});
