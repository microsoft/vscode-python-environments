// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Test Initialization Utilities
 *
 * This module provides shared initialization code for smoke, E2E, and integration tests.
 * It follows patterns from the vscode-python extension to ensure reliable test setup.
 *
 * KEY PATTERN FROM VSCODE-PYTHON:
 * The Python extension sets configuration PROGRAMMATICALLY at test runtime,
 * not just via static settings.json files. This ensures:
 * - Settings are applied before extension activation
 * - No race conditions with file loading
 * - No conflicts with installed extensions' default values
 */

import * as vscode from 'vscode';
import { ENVS_EXTENSION_ID } from './constants';

// Mark that we're running in a CI test environment
process.env.VSC_PYTHON_CI_TEST = '1';

/**
 * Initialize the test environment by configuring required settings.
 *
 * CRITICAL: This must be called BEFORE the extension activates.
 * The ms-python.python extension may have useEnvironmentsExtension=false as default,
 * which would cause our extension to skip activation and return undefined.
 */
export async function initializeTestSettings(): Promise<void> {
    const pythonConfig = vscode.workspace.getConfiguration('python');

    // Enable our extension - this is required for activation to succeed
    // Without this, activate() returns undefined early
    await pythonConfig.update('useEnvironmentsExtension', true, vscode.ConfigurationTarget.Global);

    // Give VS Code a moment to process the settings change
    await sleep(100);
}

/**
 * Activate the extension and wait for it to be ready.
 *
 * Following the vscode-python pattern, we:
 * 1. Get the extension
 * 2. Call activate()
 * 3. Wait for the extension to be fully active
 *
 * @returns The extension's exported API
 * @throws Error if extension cannot be found or activated
 */
export async function activateExtension(): Promise<unknown> {
    const extension = vscode.extensions.getExtension(ENVS_EXTENSION_ID);

    if (!extension) {
        throw new Error(
            `Extension ${ENVS_EXTENSION_ID} not found. ` +
                'Ensure the extension is properly built and the ID matches package.json.',
        );
    }

    if (!extension.isActive) {
        await extension.activate();
    }

    // Wait for activation to complete
    const startTime = Date.now();
    const timeout = 60_000; // 60 seconds

    while (!extension.isActive) {
        if (Date.now() - startTime > timeout) {
            throw new Error(`Extension ${ENVS_EXTENSION_ID} did not activate within ${timeout}ms`);
        }
        await sleep(100);
    }

    const api = extension.exports;

    if (api === undefined) {
        throw new Error(
            'Extension activated but exports is undefined. ' +
                'This usually means python.useEnvironmentsExtension is not set to true. ' +
                'Ensure initializeTestSettings() was called before activateExtension().',
        );
    }

    return api;
}

/**
 * Full initialization sequence for tests.
 *
 * Call this in suiteSetup() before any tests run.
 *
 * @returns The extension's exported API
 */
export async function initialize(): Promise<unknown> {
    // IMPORTANT: Configure settings BEFORE activating the extension
    await initializeTestSettings();

    // Now activate and get the API
    return activateExtension();
}

/**
 * Close all active editors and windows.
 * Useful for cleanup between tests.
 */
export async function closeActiveWindows(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error("Command 'workbench.action.closeAllEditors' timed out"));
        }, 15_000);

        vscode.commands.executeCommand('workbench.action.closeAllEditors').then(
            () => {
                clearTimeout(timer);
                resolve();
            },
            (err) => {
                clearTimeout(timer);
                reject(err);
            },
        );
    });
}

/**
 * Sleep for a specified number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
