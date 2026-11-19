import { defineConfig } from '@vscode/test-cli';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Keep this path short: macOS caps Unix-domain socket paths at 103 chars and
// VS Code creates `<userDataDir>/<x.y>-main.sock`. An in-workspace location
// (e.g. /Users/runner/work/<repo>/<repo>/.vscode-test/user-data) overflows.
const userDataDir = path.join(os.tmpdir(), 'vsct-ud');
const inlineScriptsEnabledUserDataDir = path.join(os.tmpdir(), 'vsct-is-ud');
const inlineScriptsExperimentUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsct-is-exp-'));
const diagnosticsDir = process.env.VSCODE_TEST_DIAGNOSTICS_DIR;
const diagnosticArgs = diagnosticsDir
    ? [`--logsPath=${path.join(diagnosticsDir, 'vscode')}`, '--verbose']
    : [];
const diagnosticMocha = diagnosticsDir
    ? { require: [path.resolve('out', 'test', 'diagnostics.js')] }
    : {};

// Seed explicit user values so tests are deterministic even when VS Code applies
// experimentation defaults. The environments extension must activate, while the
// inline-script preview stays off unless a dedicated test host opts in.
function writeUserSettings(targetUserDataDir, settings) {
    const userDir = path.join(targetUserDataDir, 'User');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(
        path.join(userDir, 'settings.json'),
        JSON.stringify({
            'python.useEnvironmentsExtension': true,
            ...settings,
        }) + '\n',
    );
}

writeUserSettings(userDataDir, { 'python-envs.inlineScripts.enabled': false });
writeUserSettings(inlineScriptsEnabledUserDataDir, { 'python-envs.inlineScripts.enabled': true });
writeUserSettings(inlineScriptsExperimentUserDataDir, {
    'experiments.override./pythonenvs/config.python-envs.inlineScripts.enabled': true,
    // Keep the override late enough to reproduce activation before VS Code applies the experimental default.
    'experiments.overrideDelay': 30_000,
});

export default defineConfig([
    {
        label: 'smokeTests',
        files: 'out/test/smoke/**/*.smoke.test.js',
        mocha: {
            ...diagnosticMocha,
            ui: 'tdd',
            timeout: 120000,
        },
        env: {
            VSC_PYTHON_SMOKE_TEST: '1',
        },
        launchArgs: [
            ...diagnosticArgs,
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
        label: 'smokeTestsInlineScriptsEnabled',
        files: 'out/test/smoke/inlineScriptsEnabled.smoke.test.js',
        mocha: {
            ...diagnosticMocha,
            ui: 'tdd',
            timeout: 120000,
        },
        env: {
            VSC_PYTHON_SMOKE_TEST: '1',
            VSC_PYTHON_INLINE_SCRIPTS_ENABLED_SMOKE_TEST: '1',
        },
        launchArgs: [
            ...diagnosticArgs,
            `--user-data-dir=${inlineScriptsEnabledUserDataDir}`,
            '--disable-workspace-trust',
        ],
    },
    {
        label: 'smokeTestsInlineScriptsExperimentEnabled',
        files: 'out/test/smoke/inlineScriptsExperimentEnabled.smoke.test.js',
        mocha: {
            ...diagnosticMocha,
            ui: 'tdd',
            timeout: 120000,
        },
        env: {
            VSC_PYTHON_SMOKE_TEST: '1',
            VSC_PYTHON_INLINE_SCRIPTS_EXPERIMENT_SMOKE_TEST: '1',
        },
        launchArgs: [
            ...diagnosticArgs,
            `--user-data-dir=${inlineScriptsExperimentUserDataDir}`,
            '--disable-workspace-trust',
        ],
    },
    {
        label: 'e2eTests',
        files: 'out/test/e2e/**/*.e2e.test.js',
        mocha: {
            ...diagnosticMocha,
            ui: 'tdd',
            timeout: 180000,
        },
        env: {
            VSC_PYTHON_E2E_TEST: '1',
        },
        launchArgs: [
            ...diagnosticArgs,
            `--user-data-dir=${userDataDir}`,
            '--disable-workspace-trust',
        ],
        // ms-python.python is installed via CLI flag (--install-extensions) for
        // the native Python tools (pet binary). We use inspect() for
        // useEnvironmentsExtension check, so Python extension's default is ignored.
    },
    {
        label: 'integrationTests',
        files: 'out/test/integration/*.integration.test.js',
        workspaceFolder: 'src/test/integration/test-workspace/project-a',
        mocha: {
            ...diagnosticMocha,
            ui: 'tdd',
            timeout: 60000,
        },
        env: {
            VSC_PYTHON_INTEGRATION_TEST: '1',
        },
        launchArgs: [
            ...diagnosticArgs,
            `--user-data-dir=${userDataDir}`,
            '--disable-workspace-trust',
        ],
        // ms-python.python is installed via CLI flag (--install-extensions) for
        // the native Python tools (pet binary). We use inspect() for
        // useEnvironmentsExtension check, so Python extension's default is ignored.
    },
    {
        label: 'integrationTestsMultiRoot',
        files: 'out/test/integration/multiroot/*.integration.test.js',
        workspaceFolder: 'src/test/integration/test-workspace/integration-tests.code-workspace',
        mocha: {
            ...diagnosticMocha,
            ui: 'tdd',
            timeout: 60000,
            retries: 1,
        },
        env: {
            VSC_PYTHON_INTEGRATION_TEST: '1',
        },
        launchArgs: [
            ...diagnosticArgs,
            `--user-data-dir=${userDataDir}`,
            '--disable-workspace-trust',
        ],
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
