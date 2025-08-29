import { QuickInputButtons, QuickPickItem } from 'vscode';
import { executeCommand } from '../../common/command.api';
import { traceInfo } from '../../common/logging';
import { showQuickPickWithButtons } from '../../common/window.apis';
import { cleanupStartupScripts, handleSettingUpShellProfile } from './shellStartupSetupHandlers';
import { ShellSetupState, ShellStartupScriptProvider } from './shells/startupProvider';
import { identifyTerminalShell } from '../common/shellDetector';
import { activeTerminal } from '../../common/window.apis';

interface ShellManagementMenuItem extends QuickPickItem {
    action: 'revert' | 'viewStatus' | 'injectStartup';
}

interface ShellSelectionItem extends QuickPickItem {
    provider: ShellStartupScriptProvider;
    isDefault?: boolean;
}

/**
 * Main entry point for the shell management menu
 */
export async function showShellManagementMenu(providers: ShellStartupScriptProvider[]): Promise<void> {
    const menuItems: ShellManagementMenuItem[] = [
        {
            label: 'Revert Shell Startup Script Changes',
            detail: 'Remove all shell startup scripts and revert to command activation',
            action: 'revert',
        },
        {
            label: 'View Shell Startup Statuses',
            detail: 'Check and display the setup status of all shell types',
            action: 'viewStatus',
        },
        {
            label: 'Inject Shell Startup',
            detail: 'Select specific shells to inject startup scripts into',
            action: 'injectStartup',
        },
    ];

    try {
        const selection = await showQuickPickWithButtons(
            menuItems,
            {
                title: 'Manage Shell Startup',
                placeHolder: 'Select an action to manage shell startup configurations',
                ignoreFocusOut: true,
            },
        );

        if (selection && !Array.isArray(selection)) {
            switch (selection.action) {
                case 'revert':
                    await revertShellStartupScripts(providers);
                    break;
                case 'viewStatus':
                    await viewShellStartupStatuses(providers);
                    break;
                case 'injectStartup':
                    await showShellSelectionMenu(providers);
                    break;
            }
        }
    } catch (error) {
        if (error === QuickInputButtons.Back) {
            // User clicked back, nothing to do
            return;
        }
        throw error;
    }
}

/**
 * Revert all shell startup scripts (existing functionality)
 */
async function revertShellStartupScripts(providers: ShellStartupScriptProvider[]): Promise<void> {
    await cleanupStartupScripts(providers);
}

/**
 * View and log the status of all shell startup configurations
 */
async function viewShellStartupStatuses(providers: ShellStartupScriptProvider[]): Promise<void> {
    traceInfo('=== Shell Startup Status Report ===');
    
    for (const provider of providers) {
        try {
            const status = await provider.isSetup();
            const statusText = getStatusText(status);
            traceInfo(`${provider.name} (${provider.shellType}): ${statusText}`);
        } catch (error) {
            traceInfo(`${provider.name} (${provider.shellType}): Error checking status - ${error}`);
        }
    }
    
    traceInfo('=== End Shell Startup Status Report ===');
    
    // Open the logs to show the status
    await executeCommand('python-envs.viewLogs');
}

/**
 * Show shell selection menu for injection
 */
async function showShellSelectionMenu(providers: ShellStartupScriptProvider[]): Promise<void> {
    const defaultShell = getDefaultShell();
    
    const shellItems: ShellSelectionItem[] = providers.map((provider) => {
        const isDefault = provider.shellType === defaultShell;
        return {
            label: provider.name,
            detail: isDefault ? `${provider.shellType} (default shell)` : provider.shellType,
            description: isDefault ? '⭐' : undefined,
            provider,
            isDefault,
        };
    });

    try {
        const selection = await showQuickPickWithButtons(
            shellItems,
            {
                title: 'Inject Shell Startup',
                placeHolder: 'Select shell to inject startup scripts into',
                showBackButton: true,
                ignoreFocusOut: true,
            },
        );

        if (selection && !Array.isArray(selection)) {
            await injectShellStartup([selection.provider]);
        }
    } catch (error) {
        if (error === QuickInputButtons.Back) {
            // Go back to main menu
            await showShellManagementMenu(providers);
            return;
        }
        throw error;
    }
}

/**
 * Inject startup scripts into selected shells
 */
async function injectShellStartup(providers: ShellStartupScriptProvider[]): Promise<void> {
    await handleSettingUpShellProfile(providers, (provider, result) => {
        if (result) {
            traceInfo(`Successfully set up shell startup for ${provider.name} (${provider.shellType})`);
        } else {
            traceInfo(`Failed to set up shell startup for ${provider.name} (${provider.shellType})`);
        }
    });
}

/**
 * Get a human-readable status text from ShellSetupState
 */
function getStatusText(status: ShellSetupState): string {
    switch (status) {
        case ShellSetupState.Setup:
            return 'Setup (startup scripts are configured)';
        case ShellSetupState.NotSetup:
            return 'Not Setup (no startup scripts configured)';
        case ShellSetupState.NotInstalled:
            return 'Not Installed (shell not available on this system)';
        default:
            return 'Unknown';
    }
}

/**
 * Get the default shell type for the current system
 */
function getDefaultShell(): string {
    const terminal = activeTerminal();
    if (terminal) {
        return identifyTerminalShell(terminal);
    }
    // Fallback logic could be added here for when no terminal is active
    return '';
}