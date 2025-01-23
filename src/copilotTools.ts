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
import { PythonPackageGetterApi, PythonProjectEnvironmentApi } from './api';
import { createDeferred } from './common/utils/deferred';

export interface IGetActiveFile {
    filePath?: string;
}

/**
 * A tool to get the list of installed Python packages in the active environment.
 */
export class GetPackagesTool implements LanguageModelTool<IGetActiveFile> {
    constructor(private readonly api: PythonProjectEnvironmentApi & PythonPackageGetterApi) {}
    /**
     * Invokes the tool to get the list of installed packages.
     * @param options - The invocation options containing the file path.
     * @param token - The cancellation token.
     * @returns The result containing the list of installed packages or an error message.
     */
    async invoke(
        options: LanguageModelToolInvocationOptions<IGetActiveFile>,
        token: CancellationToken,
    ): Promise<LanguageModelToolResult> {
        const deferredReturn = createDeferred<LanguageModelToolResult>();
        token.onCancellationRequested(() => {
            const errorMessage: string = `Operation cancelled by the user.`;
            deferredReturn.resolve({ content: [new LanguageModelTextPart(errorMessage)] } as LanguageModelToolResult);
        });

        const parameters: IGetActiveFile = options.input;

        if (parameters.filePath === undefined || parameters.filePath === '') {
            throw new Error('Invalid input: filePath is required');
        }
        const fileUri = Uri.file(parameters.filePath);

        try {
            const environment = await this.api.getEnvironment(fileUri);
            if (!environment) {
                // Check if the file is a notebook or a notebook cell to throw specific error messages.
                if (fileUri.fsPath.endsWith('.ipynb') || fileUri.fsPath.includes('.ipynb#')) {
                    throw new Error('Unable to access Jupyter kernels for notebook cells');
                }
                throw new Error('No environment found');
            }
            await this.api.refreshPackages(environment);
            const installedPackages = await this.api.getPackages(environment);

            let resultMessage: string;
            if (!installedPackages || installedPackages.length === 0) {
                resultMessage = 'No packages are installed in the current environment.';
            } else {
                const packageNames = installedPackages
                    .map((pkg) => pkg.version ? `${pkg.name} (${pkg.version})` : pkg.name)
                    .join(', ');
                resultMessage = 'The packages installed in the current environment are as follows:\n' + packageNames;
            }

            const textPart = new LanguageModelTextPart(resultMessage || '');
            deferredReturn.resolve({ content: [textPart] });
        } catch (error) {
            const errorMessage: string = `An error occurred while fetching packages: ${error}`;
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
        _options: LanguageModelToolInvocationPrepareOptions<IGetActiveFile>,
        _token: CancellationToken,
    ): Promise<PreparedToolInvocation> {
        const message = 'Preparing to fetch the list of installed Python packages...';
        return {
            invocationMessage: message,
        };
    }
}
