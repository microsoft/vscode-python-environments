import * as fse from 'fs-extra';

/**
 * Checks if a Python script file uses PEP 723 inline script metadata.
 *
 * PEP 723 scripts declare their own Python version and dependency requirements
 * via a `# /// script` block and should be run with `uv run <script>` without
 * specifying a `--python` interpreter — uv resolves and manages the environment
 * itself based on the inline metadata.
 *
 * @param filePath - Absolute path to the Python script file to inspect.
 * @returns True if the file contains a PEP 723 `# /// script` opening marker,
 *          false if the marker is absent or the file cannot be read.
 */
export async function isPep723Script(filePath: string): Promise<boolean> {
    try {
        const content = await fse.readFile(filePath, 'utf-8');
        // A PEP 723 script tag opens with a line that is exactly `# /// script`
        // (optional trailing whitespace permitted).
        return /^# \/\/\/ script\s*$/m.test(content);
    } catch {
        return false;
    }
}
