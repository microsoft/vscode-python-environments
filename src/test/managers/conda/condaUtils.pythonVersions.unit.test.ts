// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'node:assert';
import { Uri } from 'vscode';
import { PythonEnvironment } from '../../../api';
import { getPythonVersionsForCreation } from '../../../managers/conda/condaUtils';

function makeEnvironment(version: string): PythonEnvironment {
    return {
        envId: { id: version, managerId: 'ms-python.python:system' },
        name: version,
        displayName: version,
        displayPath: version,
        version,
        environmentPath: Uri.file(version),
        execInfo: { run: { executable: version } },
        sysPrefix: version,
    };
}

suite('getPythonVersionsForCreation', () => {
    test('normalizes, deduplicates, and sorts valid interpreter versions', () => {
        const versions = getPythonVersionsForCreation([
            makeEnvironment('3.9.20'),
            makeEnvironment('3.14.0rc1'),
            makeEnvironment('3.12.8.final.0'),
            makeEnvironment('3.12.8'),
            makeEnvironment('not-a-version'),
        ]);

        assert.deepStrictEqual(versions, ['3.14.0rc1', '3.12.8', '3.9.20']);
    });
});
