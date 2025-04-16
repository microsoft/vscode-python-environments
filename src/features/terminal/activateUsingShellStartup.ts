import { ConfigurationChangeEvent, Disposable, GlobalEnvironmentVariableCollection } from 'vscode';
import { DidChangeEnvironmentEventArgs } from '../../api';
import { ShellStartupActivationStrings } from '../../common/localize';
import { traceError, traceInfo } from '../../common/logging';
import { showErrorMessage, showInformationMessage } from '../../common/window.apis';
import { getWorkspaceFolder, getWorkspaceFolders, onDidChangeConfiguration } from '../../common/workspace.apis';
import { EnvironmentManagers } from '../../internal.api';
import { ShellEnvsProvider, ShellScriptEditState, ShellStartupScriptProvider } from './shells/startupProvider';
import { getAutoActivationType, setAutoActivationType } from './utils';

export interface ShellStartupActivationManager extends Disposable {
    initialize(): Promise<void>;
    updateStartupScripts(): Promise<void>;
    cleanupStartupScripts(): Promise<void>;
}

export class ShellStartupActivationManagerImpl implements ShellStartupActivationManager {
    private readonly disposables: Disposable[] = [];
    constructor(
        private readonly envCollection: GlobalEnvironmentVariableCollection,
        private readonly shellStartupProviders: ShellStartupScriptProvider[],
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
                await this.initialize();
            } else {
                // remove any contributed environment variables
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
        if (autoActType !== 'shellStartup') {
            return;
        }

        if (e.uri) {
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

    private async getSetupRequired(): Promise<ShellStartupScriptProvider[]> {
        const results = await Promise.all(
            this.shellStartupProviders.map(async (provider) => {
                if (!(await provider.isSetup())) {
                    return provider;
                }
                return undefined;
            }),
        );

        const providers = results.filter((provider): provider is ShellStartupScriptProvider => provider !== undefined);
        return providers;
    }

    public async initialize(): Promise<void> {
        const autoActType = getAutoActivationType();
        if (autoActType === 'shellStartup') {
            const providers = await this.getSetupRequired();
            if (providers.length > 0) {
                const shells = providers.map((provider) => provider.name).join(', ');
                const result = await showInformationMessage(
                    ShellStartupActivationStrings.shellStartupScriptEditPrompt,
                    { modal: true, detail: `${ShellStartupActivationStrings.updatingTheseProfiles}: ${shells}` },
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
                await Promise.all(
                    this.shellEnvsProviders.map(async (provider) => {
                        const env = await this.em.getEnvironment(undefined);
                        if (env) {
                            provider.updateEnvVariables(this.envCollection, env);
                        } else {
                            provider.removeEnvVariables(this.envCollection);
                        }
                    }),
                );
            }
        }
    }

    public async updateStartupScripts(): Promise<void> {
        const results = await Promise.all(this.shellStartupProviders.map(async (provider) => provider.setupScripts()));

        const success = results
            .filter((r) => r !== ShellScriptEditState.NotInstalled)
            .every((result) => result === ShellScriptEditState.Edited);

        // Intentionally not awaiting this message. We don’t need a response here, and awaiting here for user response can
        // block setting up rest of the startup activation.
        if (success) {
            showInformationMessage(ShellStartupActivationStrings.shellStartupScriptEditComplete);
        } else {
            showErrorMessage(ShellStartupActivationStrings.shellStartupScriptEditFailed);
        }
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
