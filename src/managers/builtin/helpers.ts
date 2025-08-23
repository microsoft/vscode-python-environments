import * as ch from 'child_process';
import { CancellationError, CancellationToken, LogOutputChannel } from 'vscode';
import { createDeferred } from '../../common/utils/deferred';
import { sendTelemetryEvent } from '../../common/telemetry/sender';
import { EventNames } from '../../common/telemetry/constants';

const available = createDeferred<boolean>();
export async function isUvInstalled(log?: LogOutputChannel): Promise<boolean> {
    if (available.completed) {
        return available.promise;
    }
    log?.info(`Running: uv --version`);
    const proc = ch.spawn('uv', ['--version']);
    proc.on('error', () => {
        available.resolve(false);
    });
    proc.stdout.on('data', (d) => log?.info(d.toString()));
    proc.on('exit', (code) => {
        if (code === 0) {
            sendTelemetryEvent(EventNames.VENV_USING_UV);
        }
        available.resolve(code === 0);
    });
    return available.promise;
}

export async function runUV(
    args: string[],
    cwd?: string,
    log?: LogOutputChannel,
    token?: CancellationToken,
): Promise<string> {
    log?.info(`Running: uv ${args.join(' ')}`);
    return new Promise<string>((resolve, reject) => {
        const proc = ch.spawn('uv', args, { cwd: cwd });
        token?.onCancellationRequested(() => {
            proc.kill();
            reject(new CancellationError());
        });

        let builder = '';
        proc.stdout?.on('data', (data) => {
            const s = data.toString('utf-8');
            builder += s;
            log?.append(s);
        });
        proc.stderr?.on('data', (data) => {
            log?.append(data.toString('utf-8'));
        });
        proc.on('close', () => {
            resolve(builder);
        });
        proc.on('exit', (code) => {
            if (code !== 0) {
                reject(new Error(`Failed to run uv ${args.join(' ')}`));
            }
        });
    });
}

export async function runPython(
    python: string,
    args: string[],
    cwd?: string,
    log?: LogOutputChannel,
    token?: CancellationToken,
): Promise<string> {
    log?.info(`Running: ${python} ${args.join(' ')}`);
    return new Promise<string>((resolve, reject) => {
        const proc = ch.spawn(python, args, { cwd: cwd });
        token?.onCancellationRequested(() => {
            proc.kill();
            reject(new CancellationError());
        });
        let builder = '';
        proc.stdout?.on('data', (data) => {
            const s = data.toString('utf-8');
            builder += s;
            log?.append(`python: ${s}`);
        });
        proc.stderr?.on('data', (data) => {
            const s = data.toString('utf-8');
            builder += s;
            log?.append(`python: ${s}`);
        });
        proc.on('close', () => {
            resolve(builder);
        });
        proc.on('exit', (code) => {
            if (code !== 0) {
                reject(new Error(`Failed to run python ${args.join(' ')}`));
            }
        });
    });
}
