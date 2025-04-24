import { l10n } from 'vscode';
import { executeCommand } from '../../common/command.api';
import { Common, ShellStartupActivationStrings } from '../../common/localize';
import { traceInfo, traceVerbose } from '../../common/logging';
import { isWindows } from '../../common/utils/platformUtils';
import { showErrorMessage, showInformationMessage } from '../../common/window.apis';
import { ShellConstants } from '../common/shellConstants';
import { ShellScriptEditState, ShellStartupScriptProvider } from './shells/startupProvider';
import { getAutoActivationType, setAutoActivationType } from './utils';

function getProviders(shellTypes: Set<string>, providers: ShellStartupScriptProvider[]): ShellStartupScriptProvider[] {
    return providers.filter((provider) => {
        if (isWindows() && shellTypes.has(ShellConstants.PWSH) && provider.shellType === 'powershell') {
            return true;
        }
        return shellTypes.has(provider.shellType);
    });
}

export async function handleSettingUpShellProfile(
    shellTypes: Set<string>,
    allProviders: ShellStartupScriptProvider[],
    callback: (provider: ShellStartupScriptProvider, result: boolean) => void,
): Promise<void> {
    const providers = getProviders(shellTypes, allProviders);
    const shells = providers.map((p) => p.shellType).join(', ');
    const response = await showInformationMessage(
        l10n.t(
            'To use "{0}" activation, the shell profiles need to be set up. Do you want to set it up now?',
            'shellStartup',
        ),
        { modal: true, detail: l10n.t('Shells: {0}', shells) },
        Common.yes,
        Common.no,
    );

    if (response === Common.yes) {
        traceVerbose(`User chose to set up shell profiles for ${shells} shells`);
        const states = await Promise.all(providers.map((provider) => provider.setupScripts()));
        if (states.every((state) => state === ShellScriptEditState.Edited)) {
            setImmediate(async () => {
                await showInformationMessage(
                    l10n.t(
                        'Shell profiles have been set up successfully. Extension will use shell startup activation next time a new terminal is created.',
                    ),
                    Common.ok,
                );
            });
            providers.forEach((provider) => callback(provider, true));
        } else {
            setImmediate(async () => {
                const button = await showErrorMessage(
                    l10n.t('Failed to set up shell profiles. Please check the output panel for more details.'),
                    Common.viewLogs,
                );
                if (button === Common.viewLogs) {
                    await executeCommand('python-envs.viewLogs');
                }
            });
            providers.forEach((provider) => callback(provider, false));
        }
    }
}

export async function cleanupStartupScripts(allProviders: ShellStartupScriptProvider[]): Promise<void> {
    await Promise.all(allProviders.map((provider) => provider.teardownScripts()));
    if (getAutoActivationType() === 'shellStartup') {
        setAutoActivationType('command');
        traceInfo(
            'Setting `python-envs.terminal.autoActivationType` to `command`, after removing shell startup scripts.',
        );
    }
    setImmediate(async () => await showInformationMessage(ShellStartupActivationStrings.revertedShellStartupScripts));
}
