import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';

import { getFishProfile } from '../../../../features/terminal/shells/fish/fishStartup';

suite('Fish Startup', () => {
    let originalXdgConfigHome: string | undefined;

    setup(() => {
        originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    });

    teardown(() => {
        if (originalXdgConfigHome === undefined) {
            delete process.env.XDG_CONFIG_HOME;
        } else {
            process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
        }
        sinon.restore();
    });

    test('getFishProfile uses XDG_CONFIG_HOME when set', async () => {
        const xdgConfigHome = path.join('test', 'xdg');
        process.env.XDG_CONFIG_HOME = xdgConfigHome;

        const profilePath = await getFishProfile();

        assert.strictEqual(profilePath, path.join(xdgConfigHome, 'fish', 'config.fish'));
    });

    test('getFishProfile falls back to ~/.config when XDG_CONFIG_HOME is empty', async () => {
        process.env.XDG_CONFIG_HOME = '   ';
        const homeDir = os.homedir();

        const profilePath = await getFishProfile();

        assert.strictEqual(profilePath, path.join(homeDir, '.config', 'fish', 'config.fish'));
    });
});
