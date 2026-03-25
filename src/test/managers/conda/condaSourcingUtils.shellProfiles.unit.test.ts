import assert from 'assert';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { checkCondaInitInShellProfiles } from '../../../managers/conda/condaSourcingUtils';

/**
 * Tests for checkCondaInitInShellProfiles — verifying detection of `conda init <shell>`
 * in shell profile/config files.
 *
 * Uses a temporary directory with real files to avoid fs-extra stubbing issues.
 */
suite('Conda Sourcing Utils - checkCondaInitInShellProfiles', () => {
    let tmpHome: string;
    let originalXdg: string | undefined;

    const condaInitBlock = `
# some existing config
export PATH="/usr/bin:$PATH"

# >>> conda initialize >>>
# !! Contents within this block are managed by 'conda init' !!
eval "$('/home/user/miniforge3/bin/conda' 'shell.bash' 'hook' 2> /dev/null)"
# <<< conda initialize <<<
`;

    setup(async () => {
        tmpHome = path.join(os.tmpdir(), `conda-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await fse.ensureDir(tmpHome);
        originalXdg = process.env.XDG_CONFIG_HOME;
        delete process.env.XDG_CONFIG_HOME;
    });

    teardown(async () => {
        await fse.remove(tmpHome);
        if (originalXdg !== undefined) {
            process.env.XDG_CONFIG_HOME = originalXdg;
        } else {
            delete process.env.XDG_CONFIG_HOME;
        }
    });

    test('Detects conda init in .bashrc', async () => {
        await fse.writeFile(path.join(tmpHome, '.bashrc'), condaInitBlock);

        const status = await checkCondaInitInShellProfiles(tmpHome);
        assert.strictEqual(status.bash, true);
    });

    test('Detects conda init in .bash_profile when .bashrc has no conda', async () => {
        await fse.writeFile(path.join(tmpHome, '.bashrc'), '# no conda here');
        await fse.writeFile(path.join(tmpHome, '.bash_profile'), condaInitBlock);

        const status = await checkCondaInitInShellProfiles(tmpHome);
        assert.strictEqual(status.bash, true);
    });

    test('Detects conda init in .zshrc', async () => {
        await fse.writeFile(path.join(tmpHome, '.zshrc'), condaInitBlock);

        const status = await checkCondaInitInShellProfiles(tmpHome);
        assert.strictEqual(status.zsh, true);
    });

    test('Detects conda init in fish config.fish', async () => {
        const fishDir = path.join(tmpHome, '.config', 'fish');
        await fse.ensureDir(fishDir);
        await fse.writeFile(path.join(fishDir, 'config.fish'), condaInitBlock);

        const status = await checkCondaInitInShellProfiles(tmpHome);
        assert.strictEqual(status.fish, true);
    });

    test('Detects conda init in fish conf.d/conda.fish', async () => {
        const confdDir = path.join(tmpHome, '.config', 'fish', 'conf.d');
        await fse.ensureDir(confdDir);
        await fse.writeFile(path.join(confdDir, 'conda.fish'), condaInitBlock);

        const status = await checkCondaInitInShellProfiles(tmpHome);
        assert.strictEqual(status.fish, true);
    });

    test('Detects conda init in PowerShell profile', async () => {
        const psDir = path.join(tmpHome, '.config', 'powershell');
        await fse.ensureDir(psDir);
        await fse.writeFile(path.join(psDir, 'Microsoft.PowerShell_profile.ps1'), condaInitBlock);

        const status = await checkCondaInitInShellProfiles(tmpHome);
        assert.strictEqual(status.pwsh, true);
    });

    test('Returns undefined for shells without conda init', async () => {
        const status = await checkCondaInitInShellProfiles(tmpHome);
        assert.strictEqual(status.bash, undefined);
        assert.strictEqual(status.zsh, undefined);
        assert.strictEqual(status.fish, undefined);
        assert.strictEqual(status.pwsh, undefined);
    });

    test('Profile exists but does not contain conda initialize', async () => {
        await fse.writeFile(path.join(tmpHome, '.bashrc'), 'export PATH="/usr/bin:$PATH"\nalias ll="ls -la"');
        await fse.writeFile(path.join(tmpHome, '.zshrc'), '# just a comment');

        const status = await checkCondaInitInShellProfiles(tmpHome);
        assert.strictEqual(status.bash, undefined);
        assert.strictEqual(status.zsh, undefined);
    });

    test('Respects XDG_CONFIG_HOME for fish', async () => {
        const customConfig = path.join(tmpHome, 'custom-xdg');
        process.env.XDG_CONFIG_HOME = customConfig;

        const fishDir = path.join(customConfig, 'fish');
        await fse.ensureDir(fishDir);
        await fse.writeFile(path.join(fishDir, 'config.fish'), condaInitBlock);

        const status = await checkCondaInitInShellProfiles(tmpHome);
        assert.strictEqual(status.fish, true);
    });

    test('Respects XDG_CONFIG_HOME for pwsh', async () => {
        const customConfig = path.join(tmpHome, 'custom-xdg');
        process.env.XDG_CONFIG_HOME = customConfig;

        const psDir = path.join(customConfig, 'powershell');
        await fse.ensureDir(psDir);
        await fse.writeFile(path.join(psDir, 'profile.ps1'), condaInitBlock);

        const status = await checkCondaInitInShellProfiles(tmpHome);
        assert.strictEqual(status.pwsh, true);
    });

    test('Multiple shells initialized at once', async () => {
        await fse.writeFile(path.join(tmpHome, '.bashrc'), condaInitBlock);
        await fse.writeFile(path.join(tmpHome, '.zshrc'), condaInitBlock);

        const fishDir = path.join(tmpHome, '.config', 'fish');
        await fse.ensureDir(fishDir);
        await fse.writeFile(path.join(fishDir, 'config.fish'), condaInitBlock);

        const status = await checkCondaInitInShellProfiles(tmpHome);
        assert.strictEqual(status.bash, true);
        assert.strictEqual(status.zsh, true);
        assert.strictEqual(status.fish, true);
        assert.strictEqual(status.pwsh, undefined);
    });
});
