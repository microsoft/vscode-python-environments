import { defineConfig } from '@vscode/test-cli';
import * as path from 'path';

// Explicit user data directory - ensures VS Code reads our settings.json
const userDataDir = path.resolve('.vscode-test/user-data');

export default defineConfig([
    {
        label: 'smokeTests',
        files: 'out/test/smoke/**/*.smoke.test.js',
        mocha: {
            ui: 'tdd',
            timeout: 120000,
            retries: 1,
        },
        env: {
            VSC_PYTHON_SMOKE_TEST: '1',
        },
        launchArgs: [
            `--user-data-dir=${userDataDir}`,
            // Don't open any folder with Python files to prevent premature activation
            '--disable-workspace-trust',
        ],
        // NOTE: Do NOT install ms-python.python for smoke tests!
        // It defines python.useEnvironmentsExtension=false by default, which
        // causes our extension to skip activation. Smoke tests only verify
        // our extension works - we don't need the Python extension.
    },
    {
        label: 'e2eTests',
        files: 'out/test/e2e/**/*.e2e.test.js',
        mocha: {
            ui: 'tdd',
            timeout: 180000,
            retries: 1,
        },
        env: {
            VSC_PYTHON_E2E_TEST: '1',
        },
        launchArgs: [
            `--user-data-dir=${userDataDir}`,
            '--disable-workspace-trust',
        ],
        // ms-python.python is installed via CLI flag (--install-extensions) for
        // the native Python tools (pet binary). We use inspect() for
        // useEnvironmentsExtension check, so Python extension's default is ignored.
    },
    {
        label: 'integrationTests',
        files: 'out/test/integration/**/*.integration.test.js',
        workspaceFolder: 'src/test/integration/test-workspace/integration-tests.code-workspace',
        mocha: {
            ui: 'tdd',
            timeout: 60000,
            retries: 1,
        },
        env: {
            VSC_PYTHON_INTEGRATION_TEST: '1',
        },
        launchArgs: [
            `--user-data-dir=${userDataDir}`,
            '--disable-workspace-trust',
        ],
        // ms-python.python is installed via CLI flag (--install-extensions) for
        // the native Python tools (pet binary). We use inspect() for
        // useEnvironmentsExtension check, so Python extension's default is ignored.
    },
    {
        label: 'extensionTests',
        files: 'out/test/**/*.test.js',
        mocha: {
            ui: 'tdd',
            timeout: 60000,
        },
    },
]);
