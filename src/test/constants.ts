import * as path from 'path';

export const EXTENSION_ROOT = path.dirname(path.dirname(__dirname));
export const EXTENSION_TEST_ROOT = path.join(EXTENSION_ROOT, 'src', 'test');

// Extension identifiers
export const ENVS_EXTENSION_ID = 'ms-python.vscode-python-envs';

// Test type detection via environment variables
// These are set by the test runner scripts before launching tests
export const IS_SMOKE_TEST = process.env.VSC_PYTHON_SMOKE_TEST === '1';
export const IS_E2E_TEST = process.env.VSC_PYTHON_E2E_TEST === '1';
export const IS_INTEGRATION_TEST = process.env.VSC_PYTHON_INTEGRATION_TEST === '1';

// Test timeouts (in milliseconds)
export const MAX_EXTENSION_ACTIVATION_TIME = 60_000; // 60 seconds for extension activation
export const TEST_TIMEOUT = 30_000; // 30 seconds default test timeout
export const TEST_RETRYCOUNT = 3; // Number of retries for flaky tests

/**
 * Detect if running in a multi-root workspace.
 * Returns false during smoke tests (don't want multi-root complexity).
 */
export function isMultiRootTest(): boolean {
    if (IS_SMOKE_TEST) {
        return false;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const vscode = require('vscode');
        return Array.isArray(vscode.workspace.workspaceFolders) && vscode.workspace.workspaceFolders.length > 1;
    } catch {
        return false;
    }
}
