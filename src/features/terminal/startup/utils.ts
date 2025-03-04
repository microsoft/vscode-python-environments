import * as cp from 'child_process';
import { traceVerbose } from '../../../common/logging';
import { PythonCommandRunConfiguration } from '../../../api';
import { quoteArgs } from '../../execution/execUtils';

export async function runCommand(command: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        cp.exec(command, (err, stdout) => {
            if (err) {
                traceVerbose(`Error running command: ${command}`, err);
                resolve(undefined);
            } else {
                resolve(stdout?.trim());
            }
        });
    });
}

export function getCommandAsString(command: PythonCommandRunConfiguration[], delimiter: string): string {
    const parts = [];
    for (const cmd of command) {
        const args = cmd.args ?? [];
        parts.push(quoteArgs([cmd.executable, ...args]).join(' '));
    }
    return parts.join(` ${delimiter} `);
}
