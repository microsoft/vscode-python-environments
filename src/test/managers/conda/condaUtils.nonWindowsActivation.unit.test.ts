import assert from 'assert';
import { ShellConstants } from '../../../features/common/shellConstants';
import { nonWindowsGenerateConfig } from '../../../managers/conda/condaUtils';

/**
 * Tests for nonWindowsGenerateConfig - Non-Windows shell activation commands.
 *
 * Key behavior tested:
 * - Bash/ZSH use conda.sh + conda activate when condaShPath is available
 * - SH uses dot (.) instead of source for POSIX compliance
 * - Bash/ZSH fall back to source <activate> <env> when condaShPath is unavailable
 * - SH falls back to . <activate> <env> when condaShPath is unavailable
 * - Fish uses conda.fish + conda activate when condaFishPath is available
 * - Fish fallback uses bare `conda` if conda init fish was run, else full conda path
 * - PowerShell uses & conda-hook.ps1 + conda activate when condaPs1Path is available
 * - PowerShell fallback uses bare `conda` if conda init pwsh was run, else full conda path
 */
suite('Conda Utils - nonWindowsGenerateConfig', () => {
    const sourceInitPath = '/home/user/miniforge3/bin/activate';
    const envIdentifier = 'myenv';
    const condaPath = '/home/user/miniforge3/bin/conda';
    const condaDeactivate = { executable: 'conda', args: ['deactivate'] };

    suite('Bash-like shell activation', () => {
        test('Uses source conda.sh + conda activate when condaShPath is provided', () => {
            const condaShPath = '/home/user/miniforge3/etc/profile.d/conda.sh';
            const result = nonWindowsGenerateConfig(
                sourceInitPath,
                envIdentifier,
                condaDeactivate,
                condaPath,
                condaShPath,
            );

            for (const shell of [ShellConstants.BASH, ShellConstants.ZSH, ShellConstants.GITBASH]) {
                const activation = result.shellActivation.get(shell);
                assert.ok(activation, `${shell} activation should be defined`);
                assert.strictEqual(activation.length, 2, `${shell} should have 2 commands`);
                assert.strictEqual(activation[0].executable, 'source');
                assert.deepStrictEqual(activation[0].args, [condaShPath]);
                assert.strictEqual(activation[1].executable, 'conda');
                assert.deepStrictEqual(activation[1].args, ['activate', envIdentifier]);
            }
        });

        test('SH uses dot instead of source with conda.sh', () => {
            const condaShPath = '/home/user/miniforge3/etc/profile.d/conda.sh';
            const result = nonWindowsGenerateConfig(
                sourceInitPath,
                envIdentifier,
                condaDeactivate,
                condaPath,
                condaShPath,
            );

            const activation = result.shellActivation.get(ShellConstants.SH);
            assert.ok(activation, 'SH activation should be defined');
            assert.strictEqual(activation.length, 2, 'SH should have 2 commands');
            assert.strictEqual(activation[0].executable, '.', 'SH should use dot instead of source');
            assert.deepStrictEqual(activation[0].args, [condaShPath]);
            assert.strictEqual(activation[1].executable, 'conda');
            assert.deepStrictEqual(activation[1].args, ['activate', envIdentifier]);
        });

        test('Falls back to source activate when condaShPath is not provided', () => {
            const result = nonWindowsGenerateConfig(sourceInitPath, envIdentifier, condaDeactivate, condaPath);

            for (const shell of [ShellConstants.BASH, ShellConstants.ZSH, ShellConstants.GITBASH]) {
                const activation = result.shellActivation.get(shell);
                assert.ok(activation, `${shell} activation should be defined`);
                assert.strictEqual(activation.length, 1, `${shell} should have 1 command`);
                assert.strictEqual(activation[0].executable, 'source');
                assert.deepStrictEqual(activation[0].args, [sourceInitPath, envIdentifier]);
            }
        });

        test('SH falls back to dot activate when condaShPath is not provided', () => {
            const result = nonWindowsGenerateConfig(sourceInitPath, envIdentifier, condaDeactivate, condaPath);

            const activation = result.shellActivation.get(ShellConstants.SH);
            assert.ok(activation, 'SH activation should be defined');
            assert.strictEqual(activation.length, 1, 'SH should have 1 command');
            assert.strictEqual(activation[0].executable, '.', 'SH should use dot instead of source');
            assert.deepStrictEqual(activation[0].args, [sourceInitPath, envIdentifier]);
        });
    });

    suite('Fish shell activation', () => {
        test('Uses source conda.fish + conda activate when condaFishPath is provided', () => {
            const condaFishPath = '/home/user/miniforge3/etc/fish/conf.d/conda.fish';
            const result = nonWindowsGenerateConfig(
                sourceInitPath,
                envIdentifier,
                condaDeactivate,
                condaPath,
                undefined,
                condaFishPath,
            );

            const activation = result.shellActivation.get(ShellConstants.FISH);
            assert.ok(activation, 'Fish activation should be defined');
            assert.strictEqual(activation.length, 2, 'Should have 2 commands: source conda.fish + conda activate');
            assert.strictEqual(activation[0].executable, 'source');
            assert.deepStrictEqual(activation[0].args, [condaFishPath]);
            assert.strictEqual(activation[1].executable, 'conda');
            assert.deepStrictEqual(activation[1].args, ['activate', envIdentifier]);
        });

        test('Uses bare conda when conda init fish was run and condaFishPath not found', () => {
            const result = nonWindowsGenerateConfig(
                sourceInitPath,
                envIdentifier,
                condaDeactivate,
                condaPath,
                undefined,
                undefined,
                undefined,
                { fish: true },
            );

            const activation = result.shellActivation.get(ShellConstants.FISH);
            assert.ok(activation, 'Fish activation should be defined');
            assert.strictEqual(activation.length, 1);
            assert.strictEqual(activation[0].executable, 'conda');
            assert.deepStrictEqual(activation[0].args, ['activate', envIdentifier]);
        });

        test('Uses full conda path when conda init fish was NOT run and condaFishPath not found', () => {
            const result = nonWindowsGenerateConfig(
                sourceInitPath,
                envIdentifier,
                condaDeactivate,
                condaPath,
                undefined,
                undefined,
                undefined,
                { fish: false },
            );

            const activation = result.shellActivation.get(ShellConstants.FISH);
            assert.ok(activation, 'Fish activation should be defined');
            assert.strictEqual(activation.length, 1);
            assert.strictEqual(activation[0].executable, condaPath);
            assert.deepStrictEqual(activation[0].args, ['activate', envIdentifier]);
        });

        test('Uses full conda path when shellInitStatus is undefined and condaFishPath not found', () => {
            const result = nonWindowsGenerateConfig(sourceInitPath, envIdentifier, condaDeactivate, condaPath);

            const activation = result.shellActivation.get(ShellConstants.FISH);
            assert.ok(activation, 'Fish activation should be defined');
            assert.strictEqual(activation.length, 1);
            assert.strictEqual(activation[0].executable, condaPath);
            assert.deepStrictEqual(activation[0].args, ['activate', envIdentifier]);
        });
    });

    suite('PowerShell activation', () => {
        test('Uses & conda-hook.ps1 + conda activate when condaPs1Path is provided', () => {
            const condaPs1Path = '/home/user/miniforge3/shell/condabin/conda-hook.ps1';
            const result = nonWindowsGenerateConfig(
                sourceInitPath,
                envIdentifier,
                condaDeactivate,
                condaPath,
                undefined,
                undefined,
                condaPs1Path,
            );

            const activation = result.shellActivation.get(ShellConstants.PWSH);
            assert.ok(activation, 'PowerShell activation should be defined');
            assert.strictEqual(activation.length, 2, 'Should have 2 commands');
            assert.strictEqual(activation[0].executable, '&');
            assert.deepStrictEqual(activation[0].args, [condaPs1Path]);
            assert.strictEqual(activation[1].executable, 'conda');
            assert.deepStrictEqual(activation[1].args, ['activate', envIdentifier]);
        });

        test('Uses bare conda when conda init pwsh was run and condaPs1Path not found', () => {
            const result = nonWindowsGenerateConfig(
                sourceInitPath,
                envIdentifier,
                condaDeactivate,
                condaPath,
                undefined,
                undefined,
                undefined,
                { pwsh: true },
            );

            const activation = result.shellActivation.get(ShellConstants.PWSH);
            assert.ok(activation, 'PowerShell activation should be defined');
            assert.strictEqual(activation.length, 1);
            assert.strictEqual(activation[0].executable, 'conda');
            assert.deepStrictEqual(activation[0].args, ['activate', envIdentifier]);
        });

        test('Uses full conda path when conda init pwsh was NOT run and condaPs1Path not found', () => {
            const result = nonWindowsGenerateConfig(sourceInitPath, envIdentifier, condaDeactivate, condaPath);

            const activation = result.shellActivation.get(ShellConstants.PWSH);
            assert.ok(activation, 'PowerShell activation should be defined');
            assert.strictEqual(activation.length, 1);
            assert.strictEqual(activation[0].executable, condaPath);
            assert.deepStrictEqual(activation[0].args, ['activate', envIdentifier]);
        });
    });

    suite('Deactivation commands', () => {
        test('All shells use conda deactivate', () => {
            const result = nonWindowsGenerateConfig(sourceInitPath, envIdentifier, condaDeactivate, condaPath);

            for (const shell of [
                ShellConstants.BASH,
                ShellConstants.ZSH,
                ShellConstants.SH,
                ShellConstants.GITBASH,
                ShellConstants.FISH,
                ShellConstants.PWSH,
            ]) {
                const deactivation = result.shellDeactivation.get(shell);
                assert.ok(deactivation, `${shell} deactivation should be defined`);
                assert.strictEqual(deactivation.length, 1, `${shell} should have 1 deactivation command`);
                assert.strictEqual(deactivation[0].executable, 'conda');
                assert.deepStrictEqual(deactivation[0].args, ['deactivate']);
            }
        });
    });

    suite('All scripts provided', () => {
        test('Each shell gets its specific activation when all scripts available', () => {
            const condaShPath = '/home/user/miniforge3/etc/profile.d/conda.sh';
            const condaFishPath = '/home/user/miniforge3/etc/fish/conf.d/conda.fish';
            const condaPs1Path = '/home/user/miniforge3/shell/condabin/conda-hook.ps1';

            const result = nonWindowsGenerateConfig(
                sourceInitPath,
                envIdentifier,
                condaDeactivate,
                condaPath,
                condaShPath,
                condaFishPath,
                condaPs1Path,
            );

            // Bash uses conda.sh
            const bashActivation = result.shellActivation.get(ShellConstants.BASH);
            assert.ok(bashActivation);
            assert.strictEqual(bashActivation[0].executable, 'source');
            assert.deepStrictEqual(bashActivation[0].args, [condaShPath]);

            // Fish uses conda.fish
            const fishActivation = result.shellActivation.get(ShellConstants.FISH);
            assert.ok(fishActivation);
            assert.strictEqual(fishActivation[0].executable, 'source');
            assert.deepStrictEqual(fishActivation[0].args, [condaFishPath]);

            // PowerShell uses & conda-hook.ps1
            const pwshActivation = result.shellActivation.get(ShellConstants.PWSH);
            assert.ok(pwshActivation);
            assert.strictEqual(pwshActivation[0].executable, '&');
            assert.deepStrictEqual(pwshActivation[0].args, [condaPs1Path]);
        });
    });
});
