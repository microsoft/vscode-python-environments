import assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

// Path to the real script template, resolved from the compiled test location
// (out/test/features/creators/ → workspaceRoot/files/templates/...). We do NOT
// rely on `NEW_PROJECT_TEMPLATES_FOLDER` because it is anchored at
// `path.dirname(__dirname)` of the compiled `constants.js`, which resolves to
// `out/` in test mode and does not contain the bundled template tree.
const TEMPLATE_PATH = path.join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'files',
    'templates',
    'new723ScriptTemplate',
    'script.py',
);

suite('new723ScriptTemplate / NewScriptProject', () => {
    let tmpDir: string;

    setup(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'new-script-test-'));
    });

    teardown(async () => {
        await fs.remove(tmpDir);
    });

    test('Template file starts with a valid PEP 723 header (# /// script)', async () => {
        const contents = await fs.readFile(TEMPLATE_PATH, 'utf8');
        const firstNonBlankLine = contents.split(/\r?\n/).find((l) => l.trim().length > 0);

        assert.strictEqual(
            firstNonBlankLine,
            '# /// script',
            'Template must start with a valid PEP 723 `script` header line',
        );
    });
});
