import { isWindows } from '../../../common/utils/platformUtils';
import { ShellConstants } from '../../common/shellConstants';
import { BashEnvsProvider } from './bash/bashEnvs';
import { PowerShellEnvsProvider } from './pwsh/pwshEnvs';
import {
    PowerShellClassicStartupProvider as PowerShellClassicStartupScriptProvider,
    PwshStartupProvider,
} from './pwsh/pwshStartup';
import { ShellEnvsProvider, ShellStartupScriptProvider } from './startupProvider';

export function createShellStartupScriptProviders(): ShellStartupScriptProvider[] {
    if (isWindows()) {
        return [new PowerShellClassicStartupScriptProvider(), new PwshStartupProvider()];
    }
    return [new PwshStartupProvider()];
}

export function createShellEnvProviders(): ShellEnvsProvider[] {
    if (isWindows()) {
        return [new PowerShellEnvsProvider(), new BashEnvsProvider(ShellConstants.GITBASH)];
    } else {
        return [new PowerShellEnvsProvider(), new BashEnvsProvider(ShellConstants.BASH)];
    }
}
