import * as cp from 'child_process';
import { traceVerbose } from '../../../common/logging';

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
