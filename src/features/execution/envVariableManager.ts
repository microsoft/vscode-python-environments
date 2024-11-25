import * as path from 'path';
import * as fsapi from 'fs-extra';
import { Uri, Event, EventEmitter, FileChangeType, RelativePattern } from 'vscode';
import {
    DidChangeEnvironmentVariablesEventArgs,
    PythonEnvironment,
    PythonEnvironmentVariablesApi,
    TerminalShellType,
} from '../../api';
import { Disposable } from 'vscode-jsonrpc';
import { createFileSystemWatcher, findFiles, getConfiguration } from '../../common/workspace.apis';
import { PythonProjectManager } from '../../internal.api';
import { mergeEnvVariables, parseEnvFile } from './envVarUtils';
import { resolveVariables } from '../../common/utils/internalVariables';
import { getActivationCommand } from '../common/activation';

export interface InternalPythonEnvironmentVariablesApi extends PythonEnvironmentVariablesApi, Disposable {}

class PythonEnvVariableManager implements InternalPythonEnvironmentVariablesApi {
    private disposables: Disposable[] = [];

    private _onDidChangeEnvironmentVariables;
    private watcher;

    constructor(private pm: PythonProjectManager) {
        this._onDidChangeEnvironmentVariables = new EventEmitter<DidChangeEnvironmentVariablesEventArgs>();
        this.onDidChangeEnvironmentVariables = this._onDidChangeEnvironmentVariables.event;

        this.watcher = createFileSystemWatcher('**/.env');
        this.disposables.push(
            this._onDidChangeEnvironmentVariables,
            this.watcher,
            this.watcher.onDidCreate((e) =>
                this._onDidChangeEnvironmentVariables.fire({ uri: e, changeTye: FileChangeType.Created }),
            ),
            this.watcher.onDidChange((e) =>
                this._onDidChangeEnvironmentVariables.fire({ uri: e, changeTye: FileChangeType.Changed }),
            ),
            this.watcher.onDidDelete((e) =>
                this._onDidChangeEnvironmentVariables.fire({ uri: e, changeTye: FileChangeType.Deleted }),
            ),
        );
    }

    async getActivatedEnvironmentVariables(
        _environment: PythonEnvironment,
        _baseEnvVar?: { [key: string]: string | undefined },
        _shellType?: TerminalShellType,
    ): Promise<{ [key: string]: string | undefined }> {
        throw new Error('Method not implemented.');
    }

    async getEnvironmentVariables(
        uri: Uri,
        overrides?: ({ [key: string]: string | undefined } | Uri)[],
        baseEnvVar?: { [key: string]: string | undefined },
    ): Promise<{ [key: string]: string | undefined }> {
        const project = this.pm.get(uri);

        const base = baseEnvVar || { ...process.env };
        let env = base;

        const config = getConfiguration('python', project?.uri ?? uri);
        let envFilePath = config.get<string>('envFile');
        envFilePath = envFilePath ? path.normalize(resolveVariables(envFilePath)) : undefined;

        if (envFilePath && (await fsapi.pathExists(envFilePath))) {
            const other = await parseEnvFile(Uri.file(envFilePath));
            env = mergeEnvVariables(env, other);
        }

        let projectEnvFilePath = project ? path.normalize(path.join(project.uri.fsPath, '.env')) : undefined;
        if (
            projectEnvFilePath &&
            projectEnvFilePath?.toLowerCase() !== envFilePath?.toLowerCase() &&
            (await fsapi.pathExists(projectEnvFilePath))
        ) {
            const other = await parseEnvFile(Uri.file(projectEnvFilePath));
            env = mergeEnvVariables(env, other);
        }

        if (overrides) {
            for (const override of overrides) {
                const other = override instanceof Uri ? await parseEnvFile(override) : override;
                env = mergeEnvVariables(env, other);
            }
        }

        return env;
    }

    onDidChangeEnvironmentVariables: Event<DidChangeEnvironmentVariablesEventArgs>;

    dispose(): void {
        this.disposables.forEach((disposable) => disposable.dispose());
    }
}
