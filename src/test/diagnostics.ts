import * as fs from 'fs';
import * as path from 'path';
import { version } from 'vscode';

/** Record that the extension-host test runner started, before loading test suites. */
export function mochaGlobalSetup(): void {
    const directory = process.env.VSCODE_TEST_DIAGNOSTICS_DIR;
    if (directory) {
        fs.writeFileSync(
            path.join(directory, 'test-runner-started.json'),
            JSON.stringify({ vscodeVersion: version, extensionHostArgs: process.argv }, undefined, 2),
        );
    }
}
