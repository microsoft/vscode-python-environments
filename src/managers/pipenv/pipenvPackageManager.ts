import * as ch from 'child_process';
import {
    CancellationError,
    CancellationToken,
    Event,
    EventEmitter,
    LogOutputChannel,
    MarkdownString,
    ProgressLocation,
    ThemeIcon,
} from 'vscode';
import { Disposable } from 'vscode-jsonrpc';
import {
    DidChangePackagesEventArgs,
    IconPath,
    Package,
    PackageChangeKind,
    PackageManagementOptions,
    PackageManager,
    PythonEnvironment,
    PythonEnvironmentApi,
} from '../../api';
import { showErrorMessage, showInputBox, withProgress } from '../../common/window.apis';
import { PipenvManager } from './pipenvManager';
import { getPipenv } from './pipenvUtils';

function getChanges(before: Package[], after: Package[]): { kind: PackageChangeKind; pkg: Package }[] {
    const changes: { kind: PackageChangeKind; pkg: Package }[] = [];
    before.forEach((pkg) => {
        changes.push({ kind: PackageChangeKind.remove, pkg });
    });
    after.forEach((pkg) => {
        changes.push({ kind: PackageChangeKind.add, pkg });
    });
    return changes;
}

export class PipenvPackageManager implements PackageManager, Disposable {
    private readonly _onDidChangePackages = new EventEmitter<DidChangePackagesEventArgs>();
    onDidChangePackages: Event<DidChangePackagesEventArgs> = this._onDidChangePackages.event;

    private packages: Map<string, Package[]> = new Map();

    constructor(
        private readonly api: PythonEnvironmentApi,
        public readonly log: LogOutputChannel,
        _pipenv: PipenvManager,
    ) {
        this.name = 'pipenv';
        this.displayName = 'Pipenv';
        this.description = 'This package manager for Python uses Pipenv for package management.';
        this.tooltip = new MarkdownString('This package manager for Python uses `pipenv` for package management.');
        this.iconPath = new ThemeIcon('package');
    }
    readonly name: string;
    readonly displayName?: string;
    readonly description?: string;
    readonly tooltip?: string | MarkdownString;
    readonly iconPath?: IconPath;

    async manage(environment: PythonEnvironment, options: PackageManagementOptions): Promise<void> {
        let toInstall: string[] = [...(options.install ?? [])];
        let toUninstall: string[] = [...(options.uninstall ?? [])];

        if (toInstall.length === 0 && toUninstall.length === 0) {
            // Show package input UI if no packages are specified
            const installInput = await showInputBox({
                prompt: 'Enter packages to install (comma separated)',
                placeHolder: 'e.g., requests, pytest, black',
            });

            if (installInput) {
                toInstall = installInput
                    .split(',')
                    .map((p) => p.trim())
                    .filter((p) => p.length > 0);
            }

            if (toInstall.length === 0) {
                return;
            }
        }

        await withProgress(
            {
                location: ProgressLocation.Notification,
                title: 'Managing packages with Pipenv',
                cancellable: true,
            },
            async (_progress, token) => {
                try {
                    const before = this.packages.get(environment.envId.id) ?? [];
                    const after = await this.managePackages(
                        environment,
                        { install: toInstall, uninstall: toUninstall },
                        token,
                    );
                    const changes = getChanges(before, after);
                    this.packages.set(environment.envId.id, after);
                    this._onDidChangePackages.fire({ environment, manager: this, changes });
                } catch (error) {
                    if (error instanceof CancellationError) {
                        // Operation was cancelled
                        return;
                    }
                    this.log.error('Failed to manage packages:', error);
                    await showErrorMessage(`Failed to manage packages: ${error instanceof Error ? error.message : String(error)}`);
                }
            },
        );
    }

    async getPackages(environment: PythonEnvironment): Promise<Package[]> {
        const cached = this.packages.get(environment.envId.id);
        if (cached) {
            return cached;
        }

        try {
            const packages = await this.listPackages(environment);
            this.packages.set(environment.envId.id, packages);
            return packages;
        } catch (error) {
            this.log.error('Failed to get packages:', error);
            return [];
        }
    }

    async refresh(environment: PythonEnvironment): Promise<void> {
        await withProgress(
            {
                location: ProgressLocation.Window,
                title: 'Refreshing Pipenv packages',
            },
            async () => {
                try {
                    const before = this.packages.get(environment.envId.id) ?? [];
                    const after = await this.listPackages(environment);
                    const changes = getChanges(before, after);
                    this.packages.set(environment.envId.id, after);
                    if (changes.length > 0) {
                        this._onDidChangePackages.fire({ environment, manager: this, changes });
                    }
                } catch (error) {
                    this.log.error(`Failed to refresh packages: ${error}`);
                    await showErrorMessage(`Failed to refresh Pipenv packages: ${error instanceof Error ? error.message : String(error)}`);
                }
            },
        );
    }

    private async listPackages(environment: PythonEnvironment): Promise<Package[]> {
        const pipenvPath = await getPipenv();
        if (!pipenvPath) {
            throw new Error('Pipenv not found');
        }

        // For pipenv, we need to find a project directory that might be associated with this environment
        // Since pipenv environments are typically tied to specific project directories
        const projects = this.api.getPythonProjects();
        let projectPath: string | undefined;

        if (projects.length === 1) {
            projectPath = projects[0].uri.fsPath;
        } else if (projects.length > 1) {
            // Try to find a project that matches the environment's group
            const envGroup = environment.group;
            if (envGroup && typeof envGroup === 'string') {
                const matchingProject = projects.find(p => 
                    p.name === envGroup || p.uri.fsPath.includes(envGroup)
                );
                projectPath = matchingProject?.uri.fsPath;
            }
        }

        if (!projectPath) {
            throw new Error('Cannot list packages for pipenv environment without a project directory');
        }

        try {
            // Try pipenv graph --json first
            const jsonPackages = await this.listPackagesJson(pipenvPath, projectPath, environment);
            if (jsonPackages.length > 0) {
                return jsonPackages;
            }
        } catch (error) {
            this.log.warn('Failed to get packages via JSON, trying verbose listing:', error);
        }

        // Fallback to pipenv list --verbose
        return await this.listPackagesVerbose(pipenvPath, projectPath, environment);
    }

    private async listPackagesJson(pipenvPath: string, projectPath: string, environment: PythonEnvironment): Promise<Package[]> {
        return new Promise((resolve, reject) => {
            ch.exec(
                `"${pipenvPath}" graph --json`,
                {
                    cwd: projectPath,
                    timeout: 30000,
                },
                (error, stdout, _stderr) => {
                    if (error) {
                        reject(new Error(`Failed to list packages: ${error.message}`));
                        return;
                    }

                    try {
                        const packages: Package[] = [];
                        const lines = stdout.split('\n').filter(line => line.trim());
                        
                        for (const line of lines) {
                            try {
                                const pkgData = JSON.parse(line);
                                if (pkgData.package_name && pkgData.installed_version) {
                                    const packageInfo = {
                                        name: pkgData.package_name,
                                        displayName: pkgData.package_name,
                                        version: pkgData.installed_version,
                                        description: pkgData.package?.summary || '',
                                    };
                                    packages.push(this.api.createPackageItem(packageInfo, environment, this));
                                }
                            } catch {
                                // Skip invalid JSON lines
                            }
                        }

                        resolve(packages);
                    } catch (parseError) {
                        reject(new Error(`Failed to parse package list: ${parseError instanceof Error ? parseError.message : String(parseError)}`));
                    }
                },
            );
        });
    }

    private async listPackagesVerbose(pipenvPath: string, projectPath: string, environment: PythonEnvironment): Promise<Package[]> {
        return new Promise((resolve, reject) => {
            ch.exec(
                `"${pipenvPath}" list --verbose`,
                {
                    cwd: projectPath,
                    timeout: 30000,
                },
                (error, stdout, _stderr) => {
                    if (error) {
                        reject(new Error(`Failed to list packages: ${error.message}`));
                        return;
                    }

                    try {
                        const packages: Package[] = [];
                        const lines = stdout.split('\n').filter(line => line.trim());
                        
                        for (const line of lines) {
                            // Parse lines like: "requests==2.28.1 HTTP library"
                            const match = line.match(/^([a-zA-Z0-9\-_.]+)==([^\s]+)(?:\s+(.*))?$/);
                            if (match) {
                                const packageInfo = {
                                    name: match[1],
                                    displayName: match[1],
                                    version: match[2],
                                    description: match[3] || '',
                                };
                                packages.push(this.api.createPackageItem(packageInfo, environment, this));
                            }
                        }

                        resolve(packages);
                    } catch (parseError) {
                        reject(new Error(`Failed to parse package list: ${parseError instanceof Error ? parseError.message : String(parseError)}`));
                    }
                },
            );
        });
    }

    private async managePackages(
        environment: PythonEnvironment,
        options: { install?: string[]; uninstall?: string[] },
        token: CancellationToken,
    ): Promise<Package[]> {
        const pipenvPath = await getPipenv();
        if (!pipenvPath) {
            throw new Error('Pipenv not found');
        }

        // Find project path similar to listPackages
        const projects = this.api.getPythonProjects();
        let projectPath: string | undefined;

        if (projects.length === 1) {
            projectPath = projects[0].uri.fsPath;
        } else if (projects.length > 1) {
            const envGroup = environment.group;
            if (envGroup && typeof envGroup === 'string') {
                const matchingProject = projects.find(p => 
                    p.name === envGroup || p.uri.fsPath.includes(envGroup)
                );
                projectPath = matchingProject?.uri.fsPath;
            }
        }

        if (!projectPath) {
            throw new Error('Cannot manage packages for pipenv environment without a project directory');
        }

        // Check if cancelled before starting
        if (token.isCancellationRequested) {
            throw new CancellationError();
        }

        // Uninstall packages first
        if (options.uninstall && options.uninstall.length > 0) {
            await this.runPipenvCommand(
                pipenvPath,
                ['uninstall', ...options.uninstall],
                projectPath,
                token,
            );
        }

        // Check if cancelled before installing
        if (token.isCancellationRequested) {
            throw new CancellationError();
        }

        // Install packages
        if (options.install && options.install.length > 0) {
            await this.runPipenvCommand(
                pipenvPath,
                ['install', ...options.install],
                projectPath,
                token,
            );
        }

        // Return updated package list
        return await this.listPackages(environment);
    }

    private async runPipenvCommand(
        pipenvPath: string,
        args: string[],
        cwd: string,
        token: CancellationToken,
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const proc = ch.spawn(pipenvPath, args, {
                cwd,
                stdio: 'pipe',
            });

            let stdout = '';
            let stderr = '';

            proc.stdout?.on('data', (data) => {
                stdout += data.toString();
            });

            proc.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            proc.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Pipenv command failed with code ${code}: ${stderr || stdout}`));
                }
            });

            proc.on('error', (error) => {
                reject(error);
            });

            // Handle cancellation
            const cancellationHandler = () => {
                proc.kill('SIGTERM');
                reject(new CancellationError());
            };

            token.onCancellationRequested(cancellationHandler);

            // Cleanup cancellation handler when process completes
            proc.on('close', () => {
                // Remove the cancellation handler
            });
        });
    }

    dispose(): void {
        this.packages.clear();
        this._onDidChangePackages.dispose();
    }
}