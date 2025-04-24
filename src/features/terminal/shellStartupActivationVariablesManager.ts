import { ConfigurationChangeEvent, Disposable, GlobalEnvironmentVariableCollection } from 'vscode';
import { DidChangeEnvironmentEventArgs } from '../../api';
import { ShellStartupActivationStrings } from '../../common/localize';
import { getWorkspaceFolder, getWorkspaceFolders, onDidChangeConfiguration } from '../../common/workspace.apis';
import { EnvironmentManagers } from '../../internal.api';
import { ShellEnvsProvider } from './shells/startupProvider';
import { getAutoActivationType } from './utils';

export interface ShellStartupActivationVariablesManager extends Disposable {
    initialize(): Promise<void>;
}

export class ShellStartupActivationVariablesManagerImpl implements ShellStartupActivationVariablesManager {
    private readonly disposables: Disposable[] = [];
    constructor(
        private readonly envCollection: GlobalEnvironmentVariableCollection,
        private readonly shellEnvsProviders: ShellEnvsProvider[],
        private readonly em: EnvironmentManagers,
    ) {
        this.envCollection.description = ShellStartupActivationStrings.envCollectionDescription;
        this.disposables.push(
            onDidChangeConfiguration(async (e: ConfigurationChangeEvent) => {
                await this.handleConfigurationChange(e);
            }),
            this.em.onDidChangeEnvironmentFiltered(async (e: DidChangeEnvironmentEventArgs) => {
                await this.handleEnvironmentChange(e);
            }),
        );
    }

    private async handleConfigurationChange(e: ConfigurationChangeEvent) {
        if (e.affectsConfiguration('python-envs.terminal.autoActivationType')) {
            const autoActType = getAutoActivationType();
            if (autoActType === 'shellStartup') {
                await this.initializeInternal();
            } else {
                const workspaces = getWorkspaceFolders() ?? [];
                if (workspaces.length > 0) {
                    workspaces.forEach((workspace) => {
                        const collection = this.envCollection.getScoped({ workspaceFolder: workspace });
                        this.shellEnvsProviders.forEach((provider) => provider.removeEnvVariables(collection));
                    });
                } else {
                    this.shellEnvsProviders.forEach((provider) => provider.removeEnvVariables(this.envCollection));
                }
            }
        }
    }

    private async handleEnvironmentChange(e: DidChangeEnvironmentEventArgs) {
        const autoActType = getAutoActivationType();
        if (autoActType === 'shellStartup' && e.uri) {
            const wf = getWorkspaceFolder(e.uri);
            if (wf) {
                const envVars = this.envCollection.getScoped({ workspaceFolder: wf });
                if (envVars) {
                    this.shellEnvsProviders.forEach((provider) => {
                        if (e.new) {
                            provider.updateEnvVariables(envVars, e.new);
                        } else {
                            provider.removeEnvVariables(envVars);
                        }
                    });
                }
            }
        }
    }

    private async initializeInternal(): Promise<void> {
        const workspaces = getWorkspaceFolders() ?? [];

        if (workspaces.length > 0) {
            const promises: Promise<void>[] = [];
            workspaces.forEach((workspace) => {
                const collection = this.envCollection.getScoped({ workspaceFolder: workspace });
                promises.push(
                    ...this.shellEnvsProviders.map(async (provider) => {
                        const env = await this.em.getEnvironment(workspace.uri);
                        if (env) {
                            provider.updateEnvVariables(collection, env);
                        } else {
                            provider.removeEnvVariables(collection);
                        }
                    }),
                );
            });
            await Promise.all(promises);
        } else {
            const env = await this.em.getEnvironment(undefined);
            await Promise.all(
                this.shellEnvsProviders.map(async (provider) => {
                    if (env) {
                        provider.updateEnvVariables(this.envCollection, env);
                    } else {
                        provider.removeEnvVariables(this.envCollection);
                    }
                }),
            );
        }
    }

    public async initialize(): Promise<void> {
        const autoActType = getAutoActivationType();
        if (autoActType === 'shellStartup') {
            await this.initializeInternal();
        }
    }

    dispose() {
        this.disposables.forEach((disposable) => disposable.dispose());
    }
}
