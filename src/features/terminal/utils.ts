import { Terminal } from 'vscode';
import { sleep } from '../../common/utils/asyncUtils';

const SHELL_INTEGRATION_TIMEOUT = 500; // 0.5 seconds
const SHELL_INTEGRATION_POLL_INTERVAL = 20; // 0.02 seconds

export async function waitForShellIntegration(terminal: Terminal): Promise<boolean> {
    let timeout = 0;
    while (!terminal.shellIntegration && timeout < SHELL_INTEGRATION_TIMEOUT) {
        await sleep(SHELL_INTEGRATION_POLL_INTERVAL);
        timeout += SHELL_INTEGRATION_POLL_INTERVAL;
    }
    return terminal.shellIntegration !== undefined;
}
