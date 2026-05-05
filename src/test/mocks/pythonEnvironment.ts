// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Uri } from 'vscode';
import { PythonEnvironment } from '../../api';
import { PythonEnvironmentImpl } from '../../internal.api';

/**
 * Options for {@link createMockPythonEnvironment}.
 */
export interface MockPythonEnvironmentOptions {
    /** Environment name, e.g. `myenv`. Defaults to `test-env`. */
    name?: string;
    /** Filesystem path for `environmentPath`, `displayPath`, and `sysPrefix`. */
    envPath: string;
    /** Version string. Defaults to `3.12.0`. */
    version?: string;
    /** Manager id. Defaults to `ms-python.python:conda`. */
    managerId?: string;
    /** Environment id. Defaults to `<name>-test`. */
    id?: string;
    /** Optional description. */
    description?: string;
    /** Optional display name. Defaults to `<name> (<version>)`. */
    displayName?: string;
    /** If true, includes an `activation` entry in `execInfo`. */
    hasActivation?: boolean;
}

/**
 * Create a minimal {@link PythonEnvironment} for use in unit tests.
 *
 * Shared across manager and view tests so they agree on the shape of a mock
 * environment. Only fields that tests commonly need are populated; extend this
 * helper if additional fields become required.
 */
export function createMockPythonEnvironment(options: MockPythonEnvironmentOptions): PythonEnvironment {
    const {
        name = 'test-env',
        envPath,
        version = '3.12.0',
        managerId = 'ms-python.python:conda',
        id = `${name}-test`,
        description,
        displayName = `${name} (${version})`,
        hasActivation = false,
    } = options;

    return new PythonEnvironmentImpl(
        { id, managerId },
        {
            name,
            displayName,
            displayPath: envPath,
            version,
            description,
            environmentPath: Uri.file(envPath),
            sysPrefix: envPath,
            execInfo: {
                run: { executable: 'python' },
                ...(hasActivation && {
                    activation: [{ executable: envPath.replace('python', 'activate') }],
                }),
            },
        },
    );
}

/**
 * Positional shorthand for {@link createMockPythonEnvironment} that always
 * creates a conda environment (`managerId` = `ms-python.python:conda`).
 * Used by conda manager unit tests. Prefer {@link createMockPythonEnvironment}
 * for new tests that need to customize additional fields or target a different
 * manager.
 */
export function makeMockCondaEnvironment(name: string, envPath: string, version: string = '3.12.0'): PythonEnvironment {
    return createMockPythonEnvironment({ name, envPath, version });
}
