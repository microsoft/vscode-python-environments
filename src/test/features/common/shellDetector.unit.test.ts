import { Terminal } from 'vscode';
import { identifyTerminalShell } from '../../../features/common/shellDetector';
import assert from 'assert';
import { isWindows } from '../../../common/utils/platformUtils';

const testShellTypes: string[] = [
    'sh',
    'bash',
    'powershell',
    'pwsh',
    'powershellcore',
    'cmd',
    'commandPrompt',
    'gitbash',
    'zsh',
    'ksh',
    'fish',
    'csh',
    'cshell',
    'tcsh',
    'tcshell',
    'nu',
    'nushell',
    'wsl',
    'xonsh',
    'unknown',
];

function getNameByShellType(shellType: string): string {
    return shellType === 'unknown' ? '' : shellType;
}

function getShellPath(shellType: string): string | undefined {
    switch (shellType) {
        case 'sh':
            return '/bin/sh';
        case 'bash':
            return '/bin/bash';
        case 'powershell':
            return 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
        case 'pwsh':
        case 'powershellcore':
            return 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
        case 'cmd':
        case 'commandPrompt':
            return 'C:\\Windows\\System32\\cmd.exe';
        case 'gitbash':
            return isWindows() ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/usr/bin/gitbash';
        case 'zsh':
            return '/bin/zsh';
        case 'ksh':
            return '/bin/ksh';
        case 'fish':
            return '/usr/bin/fish';
        case 'csh':
        case 'cshell':
            return '/bin/csh';
        case 'nu':
        case 'nushell':
            return '/usr/bin/nu';
        case 'tcsh':
        case 'tcshell':
            return '/usr/bin/tcsh';
        case 'wsl':
            return '/mnt/c/Windows/System32/wsl.exe';
        case 'xonsh':
            return '/usr/bin/xonsh';
        default:
            return undefined;
    }
}

function expectedShellType(shellType: string): string {
    switch (shellType) {
        case 'sh':
            return 'sh';
        case 'bash':
            return 'bash';
        case 'pwsh':
        case 'powershell':
        case 'powershellcore':
            return 'pwsh';
        case 'cmd':
        case 'commandPrompt':
            return 'cmd';
        case 'gitbash':
            return 'gitbash';
        case 'zsh':
            return 'zsh';
        case 'ksh':
            return 'ksh';
        case 'fish':
            return 'fish';
        case 'csh':
        case 'cshell':
            return 'csh';
        case 'nu':
        case 'nushell':
            return 'nu';
        case 'tcsh':
        case 'tcshell':
            return 'tcsh';
        case 'xonsh':
            return 'xonsh';
        case 'wsl':
            return 'wsl';
        default:
            return 'unknown';
    }
}

suite('Shell Detector', () => {
    testShellTypes.forEach((shell) => {
        if (shell === 'unknown') {
            return;
        }

        const name = getNameByShellType(shell);
        test(`Detect ${shell}`, () => {
            const terminal = {
                name,
                state: { shell },
                creationOptions: {
                    shellPath: getShellPath(shell),
                },
            } as Terminal;
            const detected = identifyTerminalShell(terminal);
            const expected = expectedShellType(shell);
            assert.strictEqual(detected, expected);
        });
    });
});
