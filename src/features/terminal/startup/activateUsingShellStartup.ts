import { ConfigurationChangeEvent, Disposable, GlobalEnvironmentVariableCollection } from 'vscode';
import { getWorkspaceFolder, getWorkspaceFolders, onDidChangeConfiguration } from '../../../common/workspace.apis';
import { getAutoActivationType, setAutoActivationType } from '../utils';
import { ShellStartupProvider } from './startupProvider';
import { DidChangeEnvironmentEventArgs } from '../../../api';
import { EnvironmentManagers } from '../../../internal.api';
import { traceError, traceInfo } from '../../../common/logging';
import { ShellStartupActivationStrings } from '../../../common/localize';
import { showInformationMessage } from '../../../common/window.apis';

export interface ShellStartupActivationManager extends Disposable {
    initialize(): Promise<void>;
    updateStartupScripts(): Promise<void>;
    cleanupStartupScripts(): Promise<void>;
}

export class ShellStartupActivationManagerImpl implements ShellStartupActivationManager {
    private readonly disposables: Disposable[] = [];
    constructor(
        private readonly envCollection: GlobalEnvironmentVariableCollection,
        private readonly shellStartupProviders: ShellStartupProvider[],
        private readonly em: EnvironmentManagers,
    ) {
        this.disposables.push(
            onDidChangeConfiguration((e: ConfigurationChangeEvent) => {
                this.handleConfigurationChange(e);
            }),
            this.em.onDidChangeEnvironmentFiltered((e: DidChangeEnvironmentEventArgs) => {
                this.handleEnvironmentChange(e);
            }),
        );
    }

    private async handleConfigurationChange(e: ConfigurationChangeEvent) {
        if (e.affectsConfiguration('python-envs.terminal.autoActivationType')) {
            const autoActType = getAutoActivationType();
            if (autoActType === 'shellStartup') {
                await this.initialize();
            } else {
                // remove any contributed environment variables
                const workspaces = getWorkspaceFolders() ?? [];
                if (workspaces.length > 0) {
                    // User has one or more workspaces open
                    const promises: Promise<void>[] = [];
                    workspaces.forEach((workspace) => {
                        const collection = this.envCollection.getScoped({ workspaceFolder: workspace });
                        promises.push(
                            ...this.shellStartupProviders.map((provider) => provider.removeEnvVariables(collection)),
                        );
                    });
                    await Promise.all(promises);
                } else {
                    // User has no workspaces open
                    await Promise.all(
                        this.shellStartupProviders.map((provider) => provider.removeEnvVariables(this.envCollection)),
                    );
                }
            }
        }
    }

    private async handleEnvironmentChange(e: DidChangeEnvironmentEventArgs) {
        const autoActType = getAutoActivationType();
        if (autoActType !== 'shellStartup') {
            return;
        }

        if (e.uri) {
            const wf = getWorkspaceFolder(e.uri);
            if (wf) {
                const envVars = this.envCollection.getScoped({ workspaceFolder: wf });
                if (envVars) {
                    await Promise.all(
                        this.shellStartupProviders.map(async (provider) => {
                            if (e.new) {
                                await provider.updateEnvVariables(envVars, e.new);
                            } else {
                                await provider.removeEnvVariables(envVars);
                            }
                        }),
                    );
                }
            }
        }
    }

    private async isSetupRequired(): Promise<boolean> {
        const results = await Promise.all(this.shellStartupProviders.map((provider) => provider.isSetup()));
        return results.some((result) => !result);
    }

    public async initialize(): Promise<void> {
        const autoActType = getAutoActivationType();
        if (autoActType === 'shellStartup') {
            if (await this.isSetupRequired()) {
                const result = await showInformationMessage(
                    ShellStartupActivationStrings.shellStartupScriptEditPrompt,
                    { modal: true },
                    ShellStartupActivationStrings.updateScript,
                );

                if (ShellStartupActivationStrings.updateScript === result) {
                    await this.updateStartupScripts();
                } else {
                    traceError('User declined to edit shell startup scripts. See <doc-link> for more information.');
                    traceInfo('Setting `python-envs.terminal.autoActivationType` to `command`.');
                    setAutoActivationType('command');
                    return;
                }
            }

            const workspaces = getWorkspaceFolders() ?? [];

            if (workspaces.length > 0) {
                const promises: Promise<void>[] = [];
                workspaces.forEach((workspace) => {
                    const collection = this.envCollection.getScoped({ workspaceFolder: workspace });
                    promises.push(
                        ...this.shellStartupProviders.map(async (provider) => {
                            const env = await this.em.getEnvironment(workspace.uri);
                            if (env) {
                                await provider.updateEnvVariables(collection, env);
                            } else {
                                await provider.removeEnvVariables(collection);
                            }
                        }),
                    );
                });
                await Promise.all(promises);
            } else {
                await Promise.all(
                    this.shellStartupProviders.map(async (provider) => {
                        const env = await this.em.getEnvironment(undefined);
                        if (env) {
                            await provider.updateEnvVariables(this.envCollection, env);
                        } else {
                            await provider.removeEnvVariables(this.envCollection);
                        }
                    }),
                );
            }
        }
    }

    public async updateStartupScripts(): Promise<void> {
        await Promise.all(this.shellStartupProviders.map((provider) => provider.setupScripts()));
    }

    public async cleanupStartupScripts(): Promise<void> {
        await Promise.all(this.shellStartupProviders.map((provider) => provider.teardownScripts()));
        setAutoActivationType('command');
        showInformationMessage(ShellStartupActivationStrings.revertToCommandActivation);
    }

    dispose() {
        this.disposables.forEach((disposable) => disposable.dispose());
    }
}
