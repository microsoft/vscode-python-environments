// Writes the VS Code test user-data settings.json to a short path under
// os.tmpdir(). Used by CI to seed `python.useEnvironmentsExtension=true`.
// `.vscode-test.mjs` MUST compute the same `userDataDir` so both sides agree.
//
// Why os.tmpdir(): macOS Unix-domain socket paths are capped at 103 chars.
// VS Code creates `<userDataDir>/<x.y>-main.sock`, so an in-workspace path
// like `/Users/runner/work/<repo>/<repo>/.vscode-test/user-data/...` overflows.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const userDataDir = path.join(os.tmpdir(), 'vsct-ud');
const userDir = path.join(userDataDir, 'User');
fs.mkdirSync(userDir, { recursive: true });
fs.writeFileSync(
    path.join(userDir, 'settings.json'),
    JSON.stringify({ 'python.useEnvironmentsExtension': true }) + '\n',
);
console.log(userDataDir);
