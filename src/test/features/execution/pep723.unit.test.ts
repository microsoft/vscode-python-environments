import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fse from 'fs-extra';
import { isPep723Script } from '../../../features/execution/pep723';

suite('isPep723Script Tests', () => {
    let readFileStub: sinon.SinonStub;

    setup(() => {
        readFileStub = sinon.stub(fse, 'readFile');
    });

    teardown(() => {
        sinon.restore();
    });

    test('should return true for a script with a PEP 723 marker at the top', async () => {
        const content = [
            '# /// script',
            '# requires-python = ">=3.11"',
            '# dependencies = ["requests"]',
            '# ///',
            '',
            'import requests',
            'print(requests.get("https://example.com").status_code)',
        ].join('\n');

        readFileStub.resolves(content);

        const result = await isPep723Script('/some/script.py');
        assert.strictEqual(result, true, 'Should detect the PEP 723 marker');
    });

    test('should return true when marker appears mid-file (non-standard but still matches)', async () => {
        const content = [
            '# Normal comment',
            '',
            '# /// script',
            '# requires-python = ">=3.9"',
            '# ///',
        ].join('\n');

        readFileStub.resolves(content);

        const result = await isPep723Script('/some/script.py');
        assert.strictEqual(result, true, 'Should detect the marker wherever it appears');
    });

    test('should return true when marker has trailing whitespace', async () => {
        const content = '# /// script   \nimport sys\n';

        readFileStub.resolves(content);

        const result = await isPep723Script('/some/script.py');
        assert.strictEqual(result, true, 'Should accept trailing whitespace after the marker');
    });

    test('should return false for a standard Python script with no PEP 723 block', async () => {
        const content = [
            '#!/usr/bin/env python3',
            '# Normal script',
            'import sys',
            'print(sys.version)',
        ].join('\n');

        readFileStub.resolves(content);

        const result = await isPep723Script('/some/script.py');
        assert.strictEqual(result, false, 'Should not detect PEP 723 in a regular script');
    });

    test('should return false for a comment that looks similar but is not the marker', async () => {
        const content = [
            '# // script',       // only two slashes
            '# //// script',     // four slashes
            '# ///script',       // no space between /// and script
            '# /// Script',      // wrong case
        ].join('\n');

        readFileStub.resolves(content);

        const result = await isPep723Script('/some/script.py');
        assert.strictEqual(result, false, 'Should not match near-miss patterns');
    });

    test('should return false when file cannot be read (graceful fallback)', async () => {
        readFileStub.rejects(new Error('ENOENT: no such file or directory'));

        const result = await isPep723Script('/nonexistent/script.py');
        assert.strictEqual(result, false, 'Should return false rather than throwing when file is unreadable');
    });

    test('should return false for an empty file', async () => {
        readFileStub.resolves('');

        const result = await isPep723Script('/some/empty.py');
        assert.strictEqual(result, false, 'Should return false for an empty file');
    });
});
