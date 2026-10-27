import { CancellationError, CancellationToken, Disposable, l10n, LogOutputChannel } from 'vscode';
import { spawnProcess } from '../../../common/childProcess.apis';
import { runLoggedProcess } from '../../../common/utils/processRunner';
import { throwIfCancelled } from '../../../internal/pythonToolSupport';
import { getPoetry } from '../poetryUtils';

export async function runPoetry(
    args: string[],
    cwd?: string,
    log?: LogOutputChannel,
    token?: CancellationToken,
    toolExecution = false,
    env?: NodeJS.ProcessEnv,
): Promise<string> {
    throwIfCancelled(token);
    const poetry = await getPoetry();
    if (!poetry) {
        throw new Error(l10n.t('Poetry executable not found.'));
    }
    throwIfCancelled(token);

    if (toolExecution) {
        return runLoggedProcess(poetry, ['--no-interaction', ...args], { cwd, env }, log, token, 300_000);
    }
    log?.info(`Running: ${poetry} ${args.join(' ')}`);

    return new Promise<string>((resolve, reject) => {
        const proc = spawnProcess(poetry, args, { cwd, env });
        let settled = false;
        let subscription: Disposable | undefined;
        const finish = (error?: Error, output?: string) => {
            if (settled) {
                return;
            }
            settled = true;
            subscription?.dispose();
            if (error) {
                reject(error);
            } else {
                resolve(output ?? '');
            }
        };
        subscription = token?.onCancellationRequested(() => {
            proc.kill();
            finish(new CancellationError());
        });
        let builder = '';
        proc.stdout?.on('data', (data) => {
            const output = data.toString('utf-8');
            builder += output;
            log?.append(`poetry: ${output}`);
        });
        proc.stderr?.on('data', (data) => {
            const output = data.toString('utf-8');
            log?.append(`poetry: ${output}`);
        });
        proc.on('close', (code) => {
            if (code !== 0) {
                finish(new Error(l10n.t('Failed to run Poetry command: {0}', args.join(' '))));
                return;
            }
            finish(undefined, builder);
        });
        proc.on('error', (error) => {
            log?.error(`Error executing poetry command: ${error}`);
            finish(error);
        });
    });
}
