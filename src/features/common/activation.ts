import { Terminal, window } from 'vscode';
import { PythonCommandRunConfiguration, PythonEnvironment } from '../../api';
import { identifyTerminalShell } from './shellDetector';
import { traceLog } from '../../common/logging';

export function isActivatableEnvironment(environment: PythonEnvironment): boolean {
    return !!environment.execInfo?.activation || !!environment.execInfo?.shellActivation;
}

export function isActivatedRunAvailable(environment: PythonEnvironment): boolean {
    return !!environment.execInfo?.activatedRun;
}

export function getActivationCommand(
    terminal: Terminal,
    environment: PythonEnvironment,
): PythonCommandRunConfiguration[] | undefined {
    const shell = identifyTerminalShell(terminal);
    traceLog('getActivationCommand: Shell type from API:', shell);
    window.onDidChangeTerminalState((e) => {
        // traceLog('getActivationCommand: Terminal state changed:', e);
        traceLog('the shell type from API inside the listener:', e.state.shell);
    });

    let activation: PythonCommandRunConfiguration[] | undefined;
    if (environment.execInfo?.shellActivation) {
        activation = environment.execInfo.shellActivation.get(shell);
        if (!activation) {
            activation = environment.execInfo.shellActivation.get('unknown');
        }
    }

    if (!activation) {
        activation = environment.execInfo?.activation;
    }

    return activation;
}

export function getDeactivationCommand(
    terminal: Terminal,
    environment: PythonEnvironment,
): PythonCommandRunConfiguration[] | undefined {
    const shell = identifyTerminalShell(terminal);

    let deactivation: PythonCommandRunConfiguration[] | undefined;
    if (environment.execInfo?.shellDeactivation) {
        deactivation = environment.execInfo.shellDeactivation.get(shell);
        if (!deactivation) {
            deactivation = environment.execInfo.shellDeactivation.get('unknown');
        }
    }

    if (!deactivation) {
        deactivation = environment.execInfo?.deactivation;
    }

    return deactivation;
}
