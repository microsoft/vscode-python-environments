import { Terminal } from 'vscode';
import { isWindows } from '../../managers/common/utils';
import * as os from 'os';
import { vscodeShell } from '../../common/vscodeEnv.apis';
import { getConfiguration } from '../../common/workspace.apis';
import { TerminalShellType } from '../../api';

/*
When identifying the shell use the following algorithm:
* 1. Identify shell based on the name of the terminal (if there is one already opened and used).
* 2. Identify shell based on the api provided by VSC.
* 2. Identify shell based on the settings in VSC.
* 3. Identify shell based on users environment variables.
* 4. Use default shells (bash for mac and linux, cmd for windows).
*/

// Types of shells can be found here:
// 1. https://wiki.ubuntu.com/ChangingShells
const IS_GITBASH = /(gitbash$)/i;
const IS_BASH = /(bash$)/i;
const IS_WSL = /(wsl$)/i;
const IS_ZSH = /(zsh$)/i;
const IS_KSH = /(ksh$)/i;
const IS_COMMAND = /(cmd$)/i;
const IS_POWERSHELL = /(powershell$)/i;
const IS_POWERSHELL_CORE = /(pwsh$)/i;
const IS_FISH = /(fish$)/i;
const IS_CSHELL = /(csh$)/i;
const IS_TCSHELL = /(tcsh$)/i;
const IS_NUSHELL = /(nu$)/i;
const IS_XONSH = /(xonsh$)/i;

const detectableShells = new Map<TerminalShellType, RegExp>();
detectableShells.set(TerminalShellType.powershell, IS_POWERSHELL);
detectableShells.set(TerminalShellType.gitbash, IS_GITBASH);
detectableShells.set(TerminalShellType.bash, IS_BASH);
detectableShells.set(TerminalShellType.wsl, IS_WSL);
detectableShells.set(TerminalShellType.zsh, IS_ZSH);
detectableShells.set(TerminalShellType.ksh, IS_KSH);
detectableShells.set(TerminalShellType.commandPrompt, IS_COMMAND);
detectableShells.set(TerminalShellType.fish, IS_FISH);
detectableShells.set(TerminalShellType.tcshell, IS_TCSHELL);
detectableShells.set(TerminalShellType.cshell, IS_CSHELL);
detectableShells.set(TerminalShellType.nushell, IS_NUSHELL);
detectableShells.set(TerminalShellType.powershellCore, IS_POWERSHELL_CORE);
detectableShells.set(TerminalShellType.xonsh, IS_XONSH);

function identifyShellFromShellPath(shellPath: string): TerminalShellType {
    // Remove .exe extension so shells can be more consistently detected
    // on Windows (including Cygwin).
    const basePath = shellPath.replace(/\.exe$/i, '');

    const shell = Array.from(detectableShells.keys()).reduce((matchedShell, shellToDetect) => {
        if (matchedShell === TerminalShellType.unknown) {
            const pat = detectableShells.get(shellToDetect);
            if (pat && pat.test(basePath)) {
                return shellToDetect;
            }
        }
        return matchedShell;
    }, TerminalShellType.unknown);

    return shell;
}

function identifyShellFromTerminalName(terminal: Terminal): TerminalShellType {
    return identifyShellFromShellPath(terminal.name);
}

function identifyPlatformDefaultShell(): TerminalShellType {
    if (isWindows()) {
        return identifyShellFromShellPath(getTerminalDefaultShellWindows());
    }

    const shellPath = process.env.SHELL && process.env.SHELL !== '/bin/false' ? process.env.SHELL : '/bin/bash';
    return identifyShellFromShellPath(shellPath);
}

function getTerminalDefaultShellWindows(): string {
    const isAtLeastWindows10 = parseFloat(os.release()) >= 10;
    const syspath = process.env.hasOwnProperty('PROCESSOR_ARCHITEW6432') ? 'Sysnative' : 'System32';
    const windir = process.env.windir ?? 'C:\\Windows';
    const powerShellPath = `${windir}\\${syspath}\\WindowsPowerShell\\v1.0\\powershell.exe`;
    return isAtLeastWindows10 ? powerShellPath : process.env.comspec || 'cmd.exe';
}

function identifyShellFromVSC(terminal: Terminal): TerminalShellType {
    const shellPath =
        terminal?.creationOptions && 'shellPath' in terminal.creationOptions && terminal.creationOptions.shellPath
            ? terminal.creationOptions.shellPath
            : vscodeShell();

    return shellPath ? identifyShellFromShellPath(shellPath) : TerminalShellType.unknown;
}

function identifyShellFromSettings(): TerminalShellType {
    const shellConfig = getConfiguration('terminal.integrated.shell');
    let shellPath: string | undefined;
    switch (process.platform) {
        case 'win32': {
            shellPath = shellConfig.get<string>('windows');
            break;
        }
        case 'darwin': {
            shellPath = shellConfig.get<string>('osx');
            break;
        }
        case 'freebsd':
        case 'openbsd':
        case 'linux': {
            shellPath = shellConfig.get<string>('linux');
            break;
        }
        default: {
            shellPath = undefined;
        }
    }
    return shellPath ? identifyShellFromShellPath(shellPath) : TerminalShellType.unknown;
}

export function identifyTerminalShell(terminal: Terminal): TerminalShellType {
    let shellType = identifyShellFromTerminalName(terminal);

    if (shellType === TerminalShellType.unknown) {
        shellType = identifyShellFromSettings();
    }

    if (shellType === TerminalShellType.unknown) {
        shellType = identifyShellFromVSC(terminal);
    }

    if (shellType === TerminalShellType.unknown) {
        shellType = identifyPlatformDefaultShell();
    }

    return shellType;
}
