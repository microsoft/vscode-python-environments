// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Smoke Test Runner Entry Point
 *
 * This file is loaded by the VS Code Extension Host test runner.
 * It configures Mocha and runs all smoke tests.
 *
 * IMPORTANT: Smoke tests run INSIDE VS Code with REAL APIs.
 * They are NOT mocked like unit tests.
 */

import * as glob from 'glob';
import Mocha from 'mocha';
import * as path from 'path';

export async function run(): Promise<void> {
    // Set the environment variable so tests know they're running as smoke tests
    process.env.VSC_PYTHON_SMOKE_TEST = '1';

    const mocha = new Mocha({
        ui: 'tdd',
        color: true,
        timeout: 120_000, // 2 minutes - smoke tests can be slow
        retries: 1, // Retry once on failure to handle flakiness
        slow: 10_000, // Mark tests as slow if they take > 10s
    });

    const testsRoot = path.resolve(__dirname);

    // Find all .smoke.test.js files
    const files = glob.sync('**/*.smoke.test.js', { cwd: testsRoot });

    // Add files to the test suite
    for (const file of files) {
        mocha.addFile(path.resolve(testsRoot, file));
    }

    return new Promise((resolve, reject) => {
        try {
            mocha.run((failures: number) => {
                if (failures > 0) {
                    reject(new Error(`${failures} smoke tests failed`));
                } else {
                    resolve();
                }
            });
        } catch (err) {
            console.error('Error running smoke tests:', err);
            reject(err);
        }
    });
}
