import assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import path from 'path';
import * as sinon from 'sinon';
import * as platformUtils from '../../../common/utils/platformUtils';
import { ShellConstants } from '../../../features/common/shellConstants';
import { getShellActivationCommands } from '../../../managers/common/utils';

suite('getShellActivationCommands', () => {
    let isWindowsStub: sinon.SinonStub;
    let tmpDir: string;

    setup(async () => {
        isWindowsStub = sinon.stub(platformUtils, 'isWindows');
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'venv-test-'));
    });

    teardown(async () => {
        sinon.restore();
        await fs.remove(tmpDir);
    });

    suite('PowerShell activation includes Set-ExecutionPolicy', () => {
        test('Activate.ps1 (capitalized) includes Set-ExecutionPolicy before activation', async () => {
            isWindowsStub.returns(true);
            await fs.writeFile(path.join(tmpDir, 'Activate.ps1'), '');

            const result = await getShellActivationCommands(tmpDir);
            const pwshActivation = result.shellActivation.get(ShellConstants.PWSH);

            assert.ok(pwshActivation, 'PowerShell activation should be defined');
            assert.strictEqual(pwshActivation.length, 2, 'Should have 2 commands: Set-ExecutionPolicy + activate');

            // First command: Set-ExecutionPolicy
            assert.strictEqual(pwshActivation[0].executable, 'Set-ExecutionPolicy');
            assert.deepStrictEqual(pwshActivation[0].args, ['-Scope', 'Process', '-ExecutionPolicy', 'RemoteSigned']);

            // Second command: & Activate.ps1
            assert.strictEqual(pwshActivation[1].executable, '&');
            assert.ok(pwshActivation[1].args);
            assert.strictEqual(pwshActivation[1].args.length, 1);
            assert.ok(
                pwshActivation[1].args[0].endsWith('Activate.ps1'),
                `Expected path ending with Activate.ps1, got: ${pwshActivation[1].args[0]}`,
            );
        });

        test('activate.ps1 (lowercase) includes Set-ExecutionPolicy before activation', async () => {
            isWindowsStub.returns(true);
            // Only create lowercase variant
            await fs.writeFile(path.join(tmpDir, 'activate.ps1'), '');

            const result = await getShellActivationCommands(tmpDir);
            const pwshActivation = result.shellActivation.get(ShellConstants.PWSH);

            assert.ok(pwshActivation, 'PowerShell activation should be defined');
            assert.strictEqual(pwshActivation.length, 2, 'Should have 2 commands: Set-ExecutionPolicy + activate');

            assert.strictEqual(pwshActivation[0].executable, 'Set-ExecutionPolicy');
            assert.deepStrictEqual(pwshActivation[0].args, ['-Scope', 'Process', '-ExecutionPolicy', 'RemoteSigned']);

            assert.strictEqual(pwshActivation[1].executable, '&');
            assert.ok(pwshActivation[1].args);
        });

        test('Set-ExecutionPolicy uses Process scope (session-only, no system-wide changes)', async () => {
            isWindowsStub.returns(true);
            await fs.writeFile(path.join(tmpDir, 'Activate.ps1'), '');

            const result = await getShellActivationCommands(tmpDir);
            const pwshActivation = result.shellActivation.get(ShellConstants.PWSH);

            assert.ok(pwshActivation);
            const policyArgs = pwshActivation[0].args;
            assert.ok(policyArgs);
            const scopeIndex = policyArgs.indexOf('-Scope');
            assert.ok(scopeIndex >= 0, 'Should have -Scope parameter');
            assert.strictEqual(policyArgs[scopeIndex + 1], 'Process', 'Scope must be Process');
        });
    });

    suite('PowerShell activation on non-Windows omits Set-ExecutionPolicy', () => {
        test('Activate.ps1 (capitalized) on non-Windows has only the activation command', async () => {
            isWindowsStub.returns(false);
            await fs.writeFile(path.join(tmpDir, 'Activate.ps1'), '');

            const result = await getShellActivationCommands(tmpDir);
            const pwshActivation = result.shellActivation.get(ShellConstants.PWSH);

            assert.ok(pwshActivation, 'PowerShell activation should be defined');
            assert.strictEqual(pwshActivation.length, 1, 'Should have only 1 command: activate (no Set-ExecutionPolicy)');
            assert.strictEqual(pwshActivation[0].executable, '&');
            assert.ok(pwshActivation[0].args);
            assert.ok(
                pwshActivation[0].args[0].endsWith('Activate.ps1'),
                `Expected path ending with Activate.ps1, got: ${pwshActivation[0].args[0]}`,
            );
        });

        test('activate.ps1 (lowercase) on non-Windows has only the activation command', async () => {
            isWindowsStub.returns(false);
            await fs.writeFile(path.join(tmpDir, 'activate.ps1'), '');

            const result = await getShellActivationCommands(tmpDir);
            const pwshActivation = result.shellActivation.get(ShellConstants.PWSH);

            assert.ok(pwshActivation, 'PowerShell activation should be defined');
            assert.strictEqual(pwshActivation.length, 1, 'Should have only 1 command: activate (no Set-ExecutionPolicy)');
            assert.strictEqual(pwshActivation[0].executable, '&');
            assert.ok(pwshActivation[0].args);
            assert.ok(
                pwshActivation[0].args[0].toLowerCase().endsWith('activate.ps1'),
                `Expected path ending with activate.ps1, got: ${pwshActivation[0].args[0]}`,
            );
        });
    });

    suite('No PowerShell activation when Activate.ps1 is absent', () => {
        test('No pwsh activation when no ps1 file exists', async () => {
            isWindowsStub.returns(true);
            // Empty tmpDir — no ps1 files

            const result = await getShellActivationCommands(tmpDir);
            const pwshActivation = result.shellActivation.get(ShellConstants.PWSH);

            assert.strictEqual(pwshActivation, undefined, 'No PowerShell activation when no ps1 file exists');
        });
    });

    suite('Other shells are not affected by execution policy change', () => {
        test('Bash activation does not include Set-ExecutionPolicy', async () => {
            isWindowsStub.returns(false);

            const result = await getShellActivationCommands(tmpDir);
            const bashActivation = result.shellActivation.get(ShellConstants.BASH);

            assert.ok(bashActivation, 'Bash activation should be defined');
            assert.strictEqual(bashActivation.length, 1, 'Bash should have only 1 command');
            assert.strictEqual(bashActivation[0].executable, 'source');
        });

        test('CMD activation does not include Set-ExecutionPolicy', async () => {
            isWindowsStub.returns(true);
            await fs.writeFile(path.join(tmpDir, 'activate.bat'), '');

            const result = await getShellActivationCommands(tmpDir);
            const cmdActivation = result.shellActivation.get(ShellConstants.CMD);

            assert.ok(cmdActivation, 'CMD activation should be defined');
            assert.strictEqual(cmdActivation.length, 1, 'CMD should have only 1 command');
            assert.ok(cmdActivation[0].executable.endsWith('activate.bat'), 'CMD should use activate.bat');
        });
    });

    suite('Windows unknown shell fallback', () => {
        test('Windows unknown shell uses activate without Set-ExecutionPolicy', async () => {
            isWindowsStub.returns(true);

            const result = await getShellActivationCommands(tmpDir);
            const unknownActivation = result.shellActivation.get('unknown');

            assert.ok(unknownActivation, 'Unknown shell activation should be defined');
            assert.strictEqual(unknownActivation.length, 1);
            assert.ok(unknownActivation[0].executable.endsWith('activate'));
        });
    });
});
