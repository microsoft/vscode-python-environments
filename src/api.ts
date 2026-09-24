// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { extensions } from 'vscode';
import type { PythonEnvironmentApi } from './types.js';

/*
 * Do not introduce any breaking changes to this API.
 * This is the public API for other extensions to interact with the Python Environments extension.
 *
 * This module is a small public runtime/package facade: it re-exports all public type contracts
 * from `./types` and the concrete error/guard from `./publicErrors`, and hosts the runtime surface
 * (`EXTENSION_ID` and `PythonEnvironments.api()`).
 */

export * from './types.js';
export * from './publicErrors.js';

export const EXTENSION_ID = 'ms-python.vscode-python-envs';

export namespace PythonEnvironments {
    /**
     * Returns the API exposed by the Python Environments extension in VS Code.
     */
    export async function api(): Promise<PythonEnvironmentApi> {
        const extension = extensions.getExtension<PythonEnvironmentApi | undefined>(EXTENSION_ID);
        if (extension === undefined) {
            throw new Error(`Python Environments extension (${EXTENSION_ID}) is not installed or is disabled`);
        }
        if (!extension.isActive) {
            await extension.activate();
        }
        const api = extension.exports;
        if (!api) {
            throw new Error(
                `Python Environments extension (${EXTENSION_ID}) did not expose its API. Ensure "python.useEnvironmentsExtension" is enabled and reload the window.`,
            );
        }
        return api;
    }
}
