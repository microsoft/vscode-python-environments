import { isWindows } from '../../../common/utils/platformUtils';
import { ShellConstants } from '../../common/shellConstants';
import { BashEnvsProvider, ZshEnvsProvider } from './bash/bashEnvs';
import { BashStartupProvider, GitBashStartupProvider, ZshStartupProvider } from './bash/bashStartup';
import { CmdEnvsProvider } from './cmd/cmdEnvs';
import { CmdStartupProvider } from './cmd/cmdStartup';
import { FishEnvsProvider } from './fish/fishEnvs';
import { FishStartupProvider } from './fish/fishStartup';
import { PowerShellEnvsProvider } from './pwsh/pwshEnvs';
import { PowerShellClassicStartupProvider, PwshStartupProvider } from './pwsh/pwshStartup';
import { ShellEnvsProvider, ShellStartupScriptProvider } from './startupProvider';

export function createShellStartupProviders(): ShellStartupScriptProvider[] {
    if (isWindows()) {
        return [
            new PowerShellClassicStartupProvider(),
            new PwshStartupProvider(),
            new GitBashStartupProvider(),
            new CmdStartupProvider(),
        ];
    }
    return [new PwshStartupProvider(), new BashStartupProvider(), new FishStartupProvider(), new ZshStartupProvider()];
}

export function createShellEnvProviders(): ShellEnvsProvider[] {
    if (isWindows()) {
        return [new PowerShellEnvsProvider(), new BashEnvsProvider(ShellConstants.GITBASH), new CmdEnvsProvider()];
    }
    return [
        new PowerShellEnvsProvider(),
        new BashEnvsProvider(ShellConstants.BASH),
        new FishEnvsProvider(),
        new ZshEnvsProvider(),
    ];
}
