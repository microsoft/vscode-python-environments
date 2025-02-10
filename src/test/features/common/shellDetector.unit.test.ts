import { TerminalShellType } from '../../../api';
import { Terminal, TerminalShellType as VSCTerminalShellType } from 'vscode';
import { identifyTerminalShell } from '../../../features/common/shellDetector';
import assert from 'assert';
import { isWindows } from '../../../managers/common/utils';

const testShellTypes: string[] = [
    'sh',
    'bash',
    'powershell',
    'pwsh',
    'cmd',
    'gitbash',
    'zsh',
    'ksh',
    'fish',
    'cshell',
    'tcshell',
    'nushell',
    'wsl',
    'xonsh',
    'unknown',
];

function getNameByShellType(shellType: string): string {
    return shellType === 'unknown' ? '' : shellType;
}

function getVSCShellType(shellType: string): VSCTerminalShellType | undefined {
    try {
        switch (shellType) {
            case 'sh':
                return VSCTerminalShellType.Sh;
            case 'bash':
                return VSCTerminalShellType.Bash;
            case 'powershell':
            case 'pwsh':
                return VSCTerminalShellType.PowerShell;
            case 'cmd':
                return VSCTerminalShellType.CommandPrompt;
            case 'gitbash':
                return VSCTerminalShellType.GitBash;
            case 'zsh':
                return VSCTerminalShellType.Zsh;
            case 'ksh':
                return VSCTerminalShellType.Ksh;
            case 'fish':
                return VSCTerminalShellType.Fish;
            case 'cshell':
                return VSCTerminalShellType.Csh;
            case 'nushell':
                return VSCTerminalShellType.NuShell;
            default:
                return undefined;
        }
    } catch {
        return undefined;
    }
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
            return 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
        case 'cmd':
            return 'C:\\Windows\\System32\\cmd.exe';
        case 'gitbash':
            return isWindows() ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/usr/bin/gitbash';
        case 'zsh':
            return '/bin/zsh';
        case 'ksh':
            return '/bin/ksh';
        case 'fish':
            return '/usr/bin/fish';
        case 'cshell':
            return '/bin/csh';
        case 'nushell':
            return '/usr/bin/nu';
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

function expectedShellType(shellType: string): TerminalShellType {
    switch (shellType) {
        case 'sh':
            return TerminalShellType.bash;
        case 'bash':
            return TerminalShellType.bash;
        case 'powershell':
            return TerminalShellType.powershell;
        case 'pwsh':
            return TerminalShellType.powershellCore;
        case 'cmd':
            return TerminalShellType.commandPrompt;
        case 'gitbash':
            return TerminalShellType.gitbash;
        case 'zsh':
            return TerminalShellType.zsh;
        case 'ksh':
            return TerminalShellType.ksh;
        case 'fish':
            return TerminalShellType.fish;
        case 'cshell':
            return TerminalShellType.cshell;
        case 'nushell':
            return TerminalShellType.nushell;
        case 'tcshell':
            return TerminalShellType.tcshell;
        case 'wsl':
            return TerminalShellType.wsl;
        case 'xonsh':
            return TerminalShellType.xonsh;
        default:
            return TerminalShellType.unknown;
    }
}

suite('Shell Detector', () => {
    testShellTypes.forEach((shellType) => {
        if (shellType === TerminalShellType.unknown) {
            return;
        }

        const name = getNameByShellType(shellType);
        const vscShellType = getVSCShellType(shellType);
        test(`Detect ${shellType}`, () => {
            const terminal = {
                name,
                state: { shellType: vscShellType },
                creationOptions: {
                    shellPath: getShellPath(shellType),
                },
            } as Terminal;
            const detected = identifyTerminalShell(terminal);
            const expected = expectedShellType(shellType);
            assert.strictEqual(detected, expected);
        });
    });
});
