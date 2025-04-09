import {
    CancellationToken,
    LanguageModelTextPart,
    LanguageModelTool,
    LanguageModelToolInvocationOptions,
    LanguageModelToolInvocationPrepareOptions,
    LanguageModelToolResult,
    PreparedToolInvocation,
    Uri,
} from 'vscode';
import {
    PythonCommandRunConfiguration,
    PythonEnvironment,
    PythonEnvironmentExecutionInfo,
    PythonPackageGetterApi,
    PythonPackageManagementApi,
    PythonProjectEnvironmentApi,
} from '../api';
import { createDeferred } from '../common/utils/deferred';

export interface IResourceReference {
    resourcePath?: string;
}

interface EnvironmentInfo {
    type: string; // e.g. conda, venv, virtualenv, sys
    version: string;
    runCommand: string;
    packages: string[] | string; //include versions too
}

/**
 * A tool to get the information about the Python environment.
 */
export class GetEnvironmentInfoTool implements LanguageModelTool<IResourceReference> {
    constructor(private readonly api: PythonProjectEnvironmentApi & PythonPackageGetterApi) {}
    /**
     * Invokes the tool to get the information about the Python environment.
     * @param options - The invocation options containing the file path.
     * @param token - The cancellation token.
     * @returns The result containing the information about the Python environment or an error message.
     */
    async invoke(
        options: LanguageModelToolInvocationOptions<IResourceReference>,
        token: CancellationToken,
    ): Promise<LanguageModelToolResult> {
        const deferredReturn = createDeferred<LanguageModelToolResult>();
        token.onCancellationRequested(() => {
            const errorMessage: string = `Operation cancelled by the user.`;
            deferredReturn.resolve({ content: [new LanguageModelTextPart(errorMessage)] } as LanguageModelToolResult);
        });

        const parameters: IResourceReference = options.input;

        if (parameters.resourcePath === undefined || parameters.resourcePath === '') {
            throw new Error('Invalid input: resourcePath is required');
        }
        const resourcePath: Uri = Uri.file(parameters.resourcePath);

        try {
            // environment info set to default values
            const envInfo: EnvironmentInfo = {
                type: 'no type found',
                version: 'no version found',
                packages: 'no packages found',
                runCommand: 'no run command found',
            };

            // environment
            const environment: PythonEnvironment | undefined = await this.api.getEnvironment(resourcePath);
            if (!environment) {
                // Check if the file is a notebook or a notebook cell to throw specific error messages.
                if (resourcePath.fsPath.endsWith('.ipynb') || resourcePath.fsPath.includes('.ipynb#')) {
                    throw new Error('Unable to access Jupyter kernels for notebook cells');
                }
                throw new Error('No environment found for the provided resource path: ' + resourcePath.fsPath);
            }

            const execInfo: PythonEnvironmentExecutionInfo = environment.execInfo;
            const run: PythonCommandRunConfiguration = execInfo.run;
            envInfo.runCommand = run.executable + (run.args ? ` ${run.args.join(' ')}` : '');
            // TODO: check if this is the right way to get type
            envInfo.type = environment.envId.managerId.split(':')[1];
            envInfo.version = environment.version;

            // does this need to be refreshed prior to returning to get any new packages?
            await this.api.refreshPackages(environment);
            const installedPackages = await this.api.getPackages(environment);
            if (!installedPackages || installedPackages.length === 0) {
                envInfo.packages = [];
            } else {
                envInfo.packages = installedPackages.map((pkg) =>
                    pkg.version ? `${pkg.name} (${pkg.version})` : pkg.name,
                );
            }

            // format and return
            const textPart = BuildEnvironmentInfoContent(envInfo);
            deferredReturn.resolve({ content: [textPart] });
        } catch (error) {
            const errorMessage: string = `An error occurred while fetching environment information: ${error}`;
            deferredReturn.resolve({ content: [new LanguageModelTextPart(errorMessage)] } as LanguageModelToolResult);
        }
        return deferredReturn.promise;
    }
    /**
     * Prepares the invocation of the tool.
     * @param _options - The preparation options.
     * @param _token - The cancellation token.
     * @returns The prepared tool invocation.
     */
    async prepareInvocation?(
        _options: LanguageModelToolInvocationPrepareOptions<IResourceReference>,
        _token: CancellationToken,
    ): Promise<PreparedToolInvocation> {
        const message = 'Preparing to fetch Python environment information...';
        return {
            invocationMessage: message,
        };
    }
}

function BuildEnvironmentInfoContent(envInfo: EnvironmentInfo): LanguageModelTextPart {
    // Create a formatted string that looks like JSON but preserves comments
    const content = `{
  // type of python environment; sys means it is the system python
  "environmentType": ${JSON.stringify(envInfo.type)},
  // python version of the environment
  "pythonVersion": ${JSON.stringify(envInfo.version)},
  // command to run python in this environment, will include command with active environment if applicable
  "runCommand": ${JSON.stringify(envInfo.runCommand)},
  // installed python packages and their versions if know in the format <name> (<version>), empty array is returned if no packages are installed.
  "packages": ${JSON.stringify(Array.isArray(envInfo.packages) ? envInfo.packages : envInfo.packages, null, 2)}
}`;

    return new LanguageModelTextPart(content);
}

/**
 * The input interface for the Install Package Tool.
 */
export interface IInstallPackageInput {
    packageList: string[];
    workspacePath?: string;
}

/**
 * A tool to install Python packages in the active environment.
 */
export class InstallPackageTool implements LanguageModelTool<IInstallPackageInput> {
    constructor(
        private readonly api: PythonProjectEnvironmentApi & PythonPackageGetterApi & PythonPackageManagementApi,
    ) {}

    /**
     * Invokes the tool to install Python packages in the active environment.
     * @param options - The invocation options containing the package list.
     * @param token - The cancellation token.
     * @returns The result containing the installation status or an error message.
     */
    async invoke(
        options: LanguageModelToolInvocationOptions<IInstallPackageInput>,
        token: CancellationToken,
    ): Promise<LanguageModelToolResult> {
        const deferredReturn = createDeferred<LanguageModelToolResult>();
        token.onCancellationRequested(() => {
            const errorMessage: string = `Operation cancelled by the user.`;
            deferredReturn.resolve({ content: [new LanguageModelTextPart(errorMessage)] } as LanguageModelToolResult);
        });

        const parameters: IInstallPackageInput = options.input;
        const workspacePath = parameters.workspacePath ? Uri.file(parameters.workspacePath) : undefined;
        if (!workspacePath) {
            throw new Error('Invalid input: workspacePath is required');
        }

        if (!parameters.packageList || parameters.packageList.length === 0) {
            throw new Error('Invalid input: packageList is required and cannot be empty');
        }
        const packageCount = parameters.packageList.length;
        const packagePlurality = packageCount === 1 ? 'package' : 'packages';

        try {
            const environment = await this.api.getEnvironment(workspacePath);
            if (!environment) {
                // Check if the file is a notebook or a notebook cell to throw specific error messages.
                if (workspacePath.fsPath.endsWith('.ipynb') || workspacePath.fsPath.includes('.ipynb#')) {
                    throw new Error('Unable to access Jupyter kernels for notebook cells');
                }
                throw new Error('No environment found');
            }

            // Install the packages
            await this.api.installPackages(environment, parameters.packageList);
            const resultMessage = `Successfully installed ${packagePlurality}: ${parameters.packageList.join(', ')}`;

            // Refresh packages after installation to update the package view
            //TODO: do I want the await?
            await this.api.refreshPackages(environment);

            deferredReturn.resolve({
                content: [new LanguageModelTextPart(resultMessage)],
            });
        } catch (error) {
            const errorMessage = `An error occurred while installing ${packagePlurality}: ${error}`;

            deferredReturn.resolve({ content: [new LanguageModelTextPart(errorMessage)] } as LanguageModelToolResult);
        }

        return deferredReturn.promise;
    }

    /**
     * Prepares the invocation of the tool.
     * @param options - The preparation options.
     * @param _token - The cancellation token.
     * @returns The prepared tool invocation.
     */
    async prepareInvocation?(
        options: LanguageModelToolInvocationPrepareOptions<IInstallPackageInput>,
        _token: CancellationToken,
    ): Promise<PreparedToolInvocation> {
        const packageList = options.input.packageList || [];
        const packageCount = packageList.length;
        const packageText = packageCount === 1 ? 'package' : 'packages';
        const message = `Preparing to install Python ${packageText}: ${packageList.join(', ')}...`;

        return {
            invocationMessage: message,
        };
    }
}
