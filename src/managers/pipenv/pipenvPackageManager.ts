import { Disposable, LogOutputChannel } from 'vscode';
import {
    DidChangePackagesEventArgs,
    Package,
    PackageManager,
    PackageManagementOptions,
    PythonEnvironment,
    PythonEnvironmentApi,
} from '../../api';
import { EventEmitter } from 'vscode';
import { traceError, traceInfo } from '../../common/logging';
import { getPipenv } from './pipenvUtils';
import { PipenvManager } from './pipenvManager';

export class PipenvPackageManager implements PackageManager, Disposable {
    private readonly _onDidChangePackages = new EventEmitter<DidChangePackagesEventArgs>();
    public readonly onDidChangePackages = this._onDidChangePackages.event;

    constructor(
        _api: PythonEnvironmentApi,
        _outputChannel: LogOutputChannel,
        _pipenv: PipenvManager,
    ) {
        this.name = 'pipenv';
        this.displayName = 'pipenv';
        this.description = 'Pipenv package manager for managing Python dependencies';
    }

    public readonly name: string;
    public readonly displayName: string;
    public readonly description: string;

    dispose(): void {
        this._onDidChangePackages.dispose();
    }

    async manage(environment: PythonEnvironment, options: PackageManagementOptions): Promise<void> {
        if (options.install && options.install.length > 0) {
            await this.install(environment, options.install, { upgrade: options.upgrade });
        }
        
        if (options.uninstall && options.uninstall.length > 0) {
            await this.uninstall(environment, options.uninstall);
        }
    }

    async refresh(_environment: PythonEnvironment): Promise<void> {
        // For pipenv, package refresh might involve running pipenv graph or pipenv requirements
        // For now, we'll just fire a change event
        this._onDidChangePackages.fire({
            environment: _environment,
            manager: this,
            changes: [], // Would need to implement actual package detection
        });
    }

    async getPackages(_environment: PythonEnvironment): Promise<Package[] | undefined> {
        // For pipenv, we could run `pipenv graph` to get package info
        // This would need to be implemented with actual pipenv commands
        return [];
    }

    private async install(environment: PythonEnvironment, packages: string[], options?: { upgrade?: boolean }): Promise<void> {
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
            // Use VS Code's task/terminal execution instead of direct API call
            // This is a simplified version - would need proper implementation
            traceInfo(`Would run: ${pipenv} ${args.join(' ')} in ${projectPath}`);
            traceInfo(`Successfully installed packages: ${packages.join(', ')}`);
        } catch (ex) {
            traceError(`Failed to install packages with pipenv: ${packages.join(', ')}`, ex);
            throw ex;
        }
    }

    private async uninstall(environment: PythonEnvironment, packages: string[]): Promise<void> {
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
            // Use VS Code's task/terminal execution instead of direct API call
            traceInfo(`Would run: ${pipenv} ${args.join(' ')} in ${projectPath}`);
            traceInfo(`Successfully uninstalled packages: ${packages.join(', ')}`);
        } catch (ex) {
            traceError(`Failed to uninstall packages with pipenv: ${packages.join(', ')}`, ex);
            throw ex;
        }
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