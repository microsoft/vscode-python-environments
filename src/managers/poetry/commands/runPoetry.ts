import { CancellationError, CancellationToken, LogOutputChannel } from 'vscode';
import { spawnProcess } from '../../../common/childProcess.apis';
import { getPoetry } from '../poetryUtils';

export async function runPoetry(
    args: string[],
    cwd?: string,
    log?: LogOutputChannel,
    token?: CancellationToken,
): Promise<string> {
    const poetry = await getPoetry();
    if (!poetry) {
        throw new Error('Poetry executable not found');
    }

    log?.info(`Running: ${poetry} ${args.join(' ')}`);

    return new Promise<string>((resolve, reject) => {
        const proc = spawnProcess(poetry, args, { cwd });
        token?.onCancellationRequested(() => {
            proc.kill();
            reject(new CancellationError());
        });
        let builder = '';
        proc.stdout?.on('data', (data) => {
            const output = data.toString('utf-8');
            builder += output;
            log?.append(`poetry: ${output}`);
        });
        proc.stderr?.on('data', (data) => {
            const output = data.toString('utf-8');
            builder += output;
            log?.append(`poetry: ${output}`);
        });
        proc.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`Failed to run poetry ${args.join(' ')}`));
                return;
            }
            resolve(builder);
        });
        proc.on('error', (error) => {
            log?.error(`Error executing poetry command: ${error}`);
            reject(error);
        });
    });
}
