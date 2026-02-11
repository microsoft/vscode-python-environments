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
],
// Install the Python extension - needed for venv support
installExtensions: ['ms-python.python'],
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
],
installExtensions: ['ms-python.python'],
},
{
label: 'integrationTests',
files: 'out/test/integration/**/*.integration.test.js',
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
],
installExtensions: ['ms-python.python'],
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
