import assert from 'assert';
import * as sinon from 'sinon';
import { ShellConstants } from '../../../features/common/shellConstants';
import * as condaSourcingUtils from '../../../managers/conda/condaSourcingUtils';
import { windowsExceptionGenerateConfig } from '../../../managers/conda/condaUtils';

/**
 * Tests for windowsExceptionGenerateConfig - Windows shell activation commands.
 *
 * Key behavior tested:
 * - Git Bash uses conda.sh (initialization script) + conda activate when condaShPath is available
 * - Git Bash falls back to source <activate-script> <env> when condaShPath is not available
 * - PowerShell uses ps1 hook + conda activate
 * - CMD uses activate.bat + conda activate
 */
suite('Conda Utils - windowsExceptionGenerateConfig', () => {
    let getCondaHookPs1PathStub: sinon.SinonStub;

    setup(() => {
        // Mock getCondaHookPs1Path to avoid filesystem access
        getCondaHookPs1PathStub = sinon.stub(condaSourcingUtils, 'getCondaHookPs1Path');
    });

    teardown(() => {
        sinon.restore();
    });

    suite('Git Bash activation with conda.sh', () => {
        test('Uses source conda.sh + conda activate when condaShPath is provided', async () => {
            // Arrange
            getCondaHookPs1PathStub.resolves('C:\\conda\\shell\\condabin\\conda-hook.ps1');
            const sourceInitPath = 'C:\\conda\\Scripts\\activate.bat';
            const prefix = 'myenv';
            const condaFolder = 'C:\\conda';
            const condaShPath = 'C:\\conda\\etc\\profile.d\\conda.sh';

            // Act
            const result = await windowsExceptionGenerateConfig(sourceInitPath, prefix, condaFolder, condaShPath);

            // Assert
            const gitBashActivation = result.shellActivation.get(ShellConstants.GITBASH);
            assert.ok(gitBashActivation, 'Git Bash activation should be defined');
            assert.strictEqual(gitBashActivation.length, 2, 'Should have 2 commands: source conda.sh + conda activate');

            // First command: source conda.sh (no env arg - it's an initialization script)
            assert.strictEqual(gitBashActivation[0].executable, 'source');
            assert.deepStrictEqual(gitBashActivation[0].args, ['C:/conda/etc/profile.d/conda.sh']);

            // Second command: conda activate <env>
            assert.strictEqual(gitBashActivation[1].executable, 'conda');
            assert.deepStrictEqual(gitBashActivation[1].args, ['activate', 'myenv']);
        });

        test('Falls back to single source command when condaShPath is undefined', async () => {
            // Arrange
            getCondaHookPs1PathStub.resolves(undefined);
            const sourceInitPath = 'C:\\conda\\Scripts\\activate.bat';
            const prefix = 'myenv';
            const condaFolder = 'C:\\conda';
            const condaShPath = undefined; // Not available

            // Act
            const result = await windowsExceptionGenerateConfig(sourceInitPath, prefix, condaFolder, condaShPath);

            // Assert
            const gitBashActivation = result.shellActivation.get(ShellConstants.GITBASH);
            assert.ok(gitBashActivation, 'Git Bash activation should be defined');
            assert.strictEqual(gitBashActivation.length, 1, 'Should have 1 command when condaShPath not available');

            // Single command: source <activate-script> <env>
            assert.strictEqual(gitBashActivation[0].executable, 'source');
            assert.deepStrictEqual(gitBashActivation[0].args, ['C:/conda/Scripts/activate.bat', 'myenv']);
        });

        test('Converts Windows backslashes to forward slashes for bash', async () => {
            // Arrange
            getCondaHookPs1PathStub.resolves(undefined);
            const condaShPath = 'C:\\Tools\\miniforge3\\etc\\profile.d\\conda.sh';

            // Act
            const result = await windowsExceptionGenerateConfig(
                'C:\\Tools\\miniforge3\\Scripts\\activate.bat',
                'pipes',
                'C:\\Tools\\miniforge3',
                condaShPath,
            );

            // Assert
            const gitBashActivation = result.shellActivation.get(ShellConstants.GITBASH);
            assert.ok(gitBashActivation, 'Git Bash activation should be defined');
            // Verify forward slashes are used
            const sourcePath = gitBashActivation[0].args?.[0];
            assert.ok(sourcePath, 'Source path should be defined');
            assert.ok(!sourcePath.includes('\\'), 'Path should not contain backslashes');
            assert.ok(sourcePath.includes('/'), 'Path should contain forward slashes');
        });
    });

    suite('PowerShell activation', () => {
        test('Uses ps1 hook when available', async () => {
            // Arrange
            const ps1HookPath = 'C:\\conda\\shell\\condabin\\conda-hook.ps1';
            getCondaHookPs1PathStub.resolves(ps1HookPath);

            // Act
            const result = await windowsExceptionGenerateConfig(
                'C:\\conda\\Scripts\\activate.bat',
                'myenv',
                'C:\\conda',
                undefined,
            );

            // Assert
            const pwshActivation = result.shellActivation.get(ShellConstants.PWSH);
            assert.ok(pwshActivation, 'PowerShell activation should be defined');
            assert.strictEqual(pwshActivation.length, 2, 'Should have 2 commands');
            assert.strictEqual(pwshActivation[0].executable, ps1HookPath);
            assert.strictEqual(pwshActivation[1].executable, 'conda');
            assert.deepStrictEqual(pwshActivation[1].args, ['activate', 'myenv']);
        });

        test('Falls back to sourceInitPath when ps1 hook not found', async () => {
            // Arrange
            getCondaHookPs1PathStub.resolves(undefined);
            const sourceInitPath = 'C:\\conda\\Scripts\\activate.bat';

            // Act
            const result = await windowsExceptionGenerateConfig(sourceInitPath, 'myenv', 'C:\\conda', undefined);

            // Assert
            const pwshActivation = result.shellActivation.get(ShellConstants.PWSH);
            assert.ok(pwshActivation, 'PowerShell activation should be defined');
            assert.strictEqual(pwshActivation[0].executable, sourceInitPath);
        });
    });

    suite('CMD activation', () => {
        test('Uses activate.bat + conda activate', async () => {
            // Arrange
            getCondaHookPs1PathStub.resolves(undefined);
            const sourceInitPath = 'C:\\conda\\Scripts\\activate.bat';

            // Act
            const result = await windowsExceptionGenerateConfig(sourceInitPath, 'myenv', 'C:\\conda', undefined);

            // Assert
            const cmdActivation = result.shellActivation.get(ShellConstants.CMD);
            assert.ok(cmdActivation, 'CMD activation should be defined');
            assert.strictEqual(cmdActivation.length, 2, 'Should have 2 commands');
            assert.strictEqual(cmdActivation[0].executable, sourceInitPath);
            assert.strictEqual(cmdActivation[1].executable, 'conda');
            assert.deepStrictEqual(cmdActivation[1].args, ['activate', 'myenv']);
        });
    });

    suite('Deactivation commands', () => {
        test('All shells use conda deactivate', async () => {
            // Arrange
            getCondaHookPs1PathStub.resolves(undefined);

            // Act
            const result = await windowsExceptionGenerateConfig(
                'C:\\conda\\Scripts\\activate.bat',
                'myenv',
                'C:\\conda',
                undefined,
            );

            // Assert: All shells should have conda deactivate
            for (const shell of [ShellConstants.GITBASH, ShellConstants.CMD, ShellConstants.PWSH]) {
                const deactivation = result.shellDeactivation.get(shell);
                assert.ok(deactivation, `${shell} deactivation should be defined`);
                assert.strictEqual(deactivation.length, 1, `${shell} should have 1 deactivation command`);
                assert.strictEqual(deactivation[0].executable, 'conda');
                assert.deepStrictEqual(deactivation[0].args, ['deactivate']);
            }
        });
    });
});
