// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Integration Test Runner Entry Point
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
