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
    PackageManagementOptions,
    PythonEnvironment,
    PythonEnvironmentExecutionInfo,
    PythonPackageGetterApi,
    PythonPackageManagementApi,
    PythonProjectEnvironmentApi,
} from '../api';
import { createDeferred } from '../common/utils/deferred';
import { EnvironmentManagers } from '../internal.api';

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
    constructor(
        private readonly api: PythonProjectEnvironmentApi & PythonPackageGetterApi,
        private readonly envManagers: EnvironmentManagers,
    ) {}
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
        const resourcePath: Uri = Uri.parse(parameters.resourcePath);

        // environment info set to default values
        const envInfo: EnvironmentInfo = {
            type: 'no type found',
            version: 'no version found',
            packages: 'no packages found',
            runCommand: 'no run command found',
        };

        try {
            // environment
            const environment: PythonEnvironment | undefined = await this.api.getEnvironment(resourcePath);
            if (!environment) {
                throw new Error('No environment found for the provided resource path: ' + resourcePath.fsPath);
            }

            const execInfo: PythonEnvironmentExecutionInfo = environment.execInfo;
            const executable = execInfo?.activatedRun?.executable ?? execInfo?.run.executable ?? 'python';
            const args = execInfo?.activatedRun?.args ?? execInfo?.run.args ?? [];
            envInfo.runCommand = args.length > 0 ? `${executable} ${args.join(' ')}` : executable;
            envInfo.version = environment.version;

            // get the environment type or manager if type is not available
            try {
                const managerId = environment.envId.managerId;
                const manager = this.envManagers.getEnvironmentManager(managerId);
                envInfo.type = manager?.name || 'cannot be determined';
            } catch {
                envInfo.type = environment.envId.managerId || 'cannot be determined';
            }

            // TODO: remove refreshPackages here eventually once terminal isn't being used as a fallback
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
            const partialContent = BuildEnvironmentInfoContent(envInfo);
            const combinedContent = new LanguageModelTextPart(`${errorMessage}\n\n${partialContent.value}`);
            deferredReturn.resolve({ content: [combinedContent] } as LanguageModelToolResult);
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
    let envTypeDescriptor: string = `This environment is managed by ${envInfo.type} environment manager. Use the install tool to install packages into this environment.`;

    if (envInfo.type === 'system') {
        envTypeDescriptor =
            'System pythons are pythons that ship with the OS or are installed globally. These python installs may be used by the OS for running services and core functionality. Confirm with the user before installing packages into this environment, as it can lead to issues with any services on the OS.';
    }
    const content = `{
    // ${JSON.stringify(envTypeDescriptor)}
  "environmentType": ${JSON.stringify(envInfo.type)},
  // Python version of the environment
  "pythonVersion": ${JSON.stringify(envInfo.version)},
  // Use this command to run Python script or code in the terminal.
  "runCommand": ${JSON.stringify(envInfo.runCommand)},
  // Installed Python packages, each in the format <name> or <name> (<version>). The version may be omitted if unknown. Returns an empty array if no packages are installed.
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
            const pkgManagementOptions: PackageManagementOptions = {
                install: parameters.packageList,
            };
            await this.api.managePackages(environment, pkgManagementOptions);
            const resultMessage = `Successfully installed ${packagePlurality}: ${parameters.packageList.join(', ')}`;

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
