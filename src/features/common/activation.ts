import { Terminal } from 'vscode';
import { PythonCommandRunConfiguration, PythonEnvironment } from '../../api';
import { identifyTerminalShell } from './shellDetector';

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
    return getActivationCommandForShell(environment, shell);
}

export function getActivationCommandForShell(
    environment: PythonEnvironment,
    shell: string,
): PythonCommandRunConfiguration[] | undefined {
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
