// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Integration Test Runner Entry Point
 *
 * Integration tests verify that multiple components work together correctly.
 * They run in a REAL VS Code instance but focus on component interactions
 * rather than full user workflows (that's E2E).
 *
 * Integration tests differ from:
 * - Unit tests: Use real VS Code APIs, not mocks
 * - E2E tests: Test component interactions, not complete workflows
 * - Smoke tests: More thorough than quick sanity checks
 */

import * as glob from 'glob';
import Mocha from 'mocha';
import * as path from 'path';

export async function run(): Promise<void> {
    // Set environment variable for test type detection
    process.env.VSC_PYTHON_INTEGRATION_TEST = '1';

    const mocha = new Mocha({
        ui: 'tdd',
        color: true,
        timeout: 120_000, // 2 minutes
        retries: 1,
        slow: 15_000, // Mark as slow if > 15s
    });

    const testsRoot = path.resolve(__dirname);

    // Find all .integration.test.js files
    const files = glob.sync('**/*.integration.test.js', { cwd: testsRoot });

    for (const file of files) {
        mocha.addFile(path.resolve(testsRoot, file));
    }

    return new Promise((resolve, reject) => {
        try {
            mocha.run((failures: number) => {
                if (failures > 0) {
                    reject(new Error(`${failures} integration tests failed`));
                } else {
                    resolve();
                }
            });
        } catch (err) {
            console.error('Error running integration tests:', err);
            reject(err);
        }
    });
}
