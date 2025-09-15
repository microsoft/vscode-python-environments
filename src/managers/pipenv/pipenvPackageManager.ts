import { LogOutputChannel, Uri } from 'vscode';
import {
    CreateEnvironmentOptions,
    PackageInstallOptions,
    PackageManager,
    PythonEnvironment,
    PythonEnvironmentApi,
    RemoveEnvironmentOptions,
} from '../../api';
import { traceError, traceInfo } from '../../common/logging';
import { getPipenv } from './pipenvUtils';
import { PipenvManager } from './pipenvManager';

export class PipenvPackageManager implements PackageManager {
    constructor(
        private readonly api: PythonEnvironmentApi,
        private readonly outputChannel: LogOutputChannel,
        private readonly _pipenv: PipenvManager,
    ) {
        this.id = 'ms-python.python:pipenv';
        this.displayName = 'pipenv';
        this.description = 'Pipenv package manager for managing Python dependencies';
        this.isDefault = false;
        this.supportsInstall = true;
        this.supportsUninstall = true;
        this.supportsUpgrade = true;
        this.supportsCreateEnvironment = false; // Pipenv creates environments automatically when installing
        this.supportsRemoveEnvironment = false; // Use `pipenv --rm` command directly
    }

    public readonly id: string;
    public readonly displayName: string;
    public readonly description: string;
    public readonly isDefault: boolean;
    public readonly supportsInstall: boolean;
    public readonly supportsUninstall: boolean;
    public readonly supportsUpgrade: boolean;
    public readonly supportsCreateEnvironment: boolean;
    public readonly supportsRemoveEnvironment: boolean;

    async install(environment: PythonEnvironment, packages: string[], options?: PackageInstallOptions): Promise<void> {
        const pipenv = await getPipenv();
        if (!pipenv) {
            throw new Error('Pipenv not found');
        }

        const projectPath = this.getProjectPath(environment);
        if (!projectPath) {
            throw new Error('Project path not found for pipenv environment');
        }

        const args = ['install'];
        
        if (options?.upgrade) {
            args.push('--upgrade');
        }

        // Add packages
        args.push(...packages);

        try {
            traceInfo(`Installing packages with pipenv: ${packages.join(', ')}`);
            await this.api.runCommand({
                command: pipenv,
                args,
                cwd: projectPath,
                outputChannel: this.outputChannel,
            });
            traceInfo(`Successfully installed packages: ${packages.join(', ')}`);
        } catch (ex) {
            traceError(`Failed to install packages with pipenv: ${packages.join(', ')}`, ex);
            throw ex;
        }
    }

    async uninstall(environment: PythonEnvironment, packages: string[]): Promise<void> {
        const pipenv = await getPipenv();
        if (!pipenv) {
            throw new Error('Pipenv not found');
        }

        const projectPath = this.getProjectPath(environment);
        if (!projectPath) {
            throw new Error('Project path not found for pipenv environment');
        }

        const args = ['uninstall', ...packages];

        try {
            traceInfo(`Uninstalling packages with pipenv: ${packages.join(', ')}`);
            await this.api.runCommand({
                command: pipenv,
                args,
                cwd: projectPath,
                outputChannel: this.outputChannel,
            });
            traceInfo(`Successfully uninstalled packages: ${packages.join(', ')}`);
        } catch (ex) {
            traceError(`Failed to uninstall packages with pipenv: ${packages.join(', ')}`, ex);
            throw ex;
        }
    }

    async upgrade(environment: PythonEnvironment, packages: string[]): Promise<void> {
        // For pipenv, upgrade is handled by install with --upgrade flag
        await this.install(environment, packages, { upgrade: true });
    }

    async createEnvironment(options: CreateEnvironmentOptions): Promise<PythonEnvironment | undefined> {
        // Pipenv automatically creates environments when installing packages
        // Users should use the pipenv CLI directly
        throw new Error('Environment creation not supported. Use `pipenv install` directly.');
    }

    async removeEnvironment(
        environment: PythonEnvironment,
        options?: RemoveEnvironmentOptions,
    ): Promise<void> {
        // Pipenv environment removal should be done via `pipenv --rm`
        throw new Error('Environment removal not supported. Use `pipenv --rm` directly.');
    }

    private getProjectPath(environment: PythonEnvironment): string | undefined {
        // For pipenv, we need to find the project directory where Pipfile exists
        // This is typically stored in the environment's description or we can derive it
        if (environment.description?.startsWith('Project: ')) {
            return environment.description.replace('Project: ', '');
        }

        // Fallback: try to derive from environment path
        // Pipenv virtual environments are typically named after the project
        // but stored in a centralized location
        return undefined;
    }
}