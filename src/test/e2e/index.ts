// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * E2E Test Runner Entry Point
 *
 * This file is loaded by the VS Code Extension Host test runner.
 * It configures Mocha and runs all E2E tests.
 *
 * E2E tests differ from smoke tests:
 * - Smoke tests: Quick sanity checks (extension loads, commands exist)
 * - E2E tests: Full user workflows (create env, install packages, select interpreter)
 *
 * Both run in a REAL VS Code instance with REAL APIs.
 */

import * as glob from 'glob';
import Mocha from 'mocha';
import * as path from 'path';

export async function run(): Promise<void> {
    // Set the environment variable so tests know they're running as E2E tests
    process.env.VSC_PYTHON_E2E_TEST = '1';

    const mocha = new Mocha({
        ui: 'tdd',
        color: true,
        timeout: 180_000, // 3 minutes - E2E workflows can be slow
        retries: 1, // Retry once on failure
        slow: 30_000, // Mark tests as slow if they take > 30s
    });

    const testsRoot = path.resolve(__dirname);

    // Find all .e2e.test.js files
    const files = glob.sync('**/*.e2e.test.js', { cwd: testsRoot });

    // Add files to the test suite
    for (const file of files) {
        mocha.addFile(path.resolve(testsRoot, file));
    }

    return new Promise((resolve, reject) => {
        try {
            mocha.run((failures: number) => {
                if (failures > 0) {
                    reject(new Error(`${failures} E2E tests failed`));
                } else {
                    resolve();
                }
            });
        } catch (err) {
            console.error('Error running E2E tests:', err);
            reject(err);
        }
    });
}
