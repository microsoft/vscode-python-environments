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
import { GetEnvironmentScope, Package, PythonEnvironment } from './api';

export interface IGetActiveFile {
    filePath?: string;
}

/**
 * A tool to get the list of installed Python packages in the active environment.
 */
export class GetPackagesTool implements LanguageModelTool<IGetActiveFile> {
    private apiGetEnvironment: (scope: GetEnvironmentScope) => Promise<PythonEnvironment | undefined>;
    private apiGetPackages: (environment: PythonEnvironment) => Promise<Package[] | undefined>;

    private apiRefreshPackages: (environment: PythonEnvironment) => Promise<void>;
    constructor(
        apiGetEnvironmentCon: (scope: GetEnvironmentScope) => Promise<PythonEnvironment | undefined>,
        apiGetPackagesCon: (environment: PythonEnvironment) => Promise<Package[] | undefined>,
        apiRefreshPackagesCon: (environment: PythonEnvironment) => Promise<void>,
    ) {
        this.apiGetEnvironment = apiGetEnvironmentCon;
        this.apiGetPackages = apiGetPackagesCon;
        this.apiRefreshPackages = apiRefreshPackagesCon;
    }
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
        const parameters: IGetActiveFile = options.input;

        if (parameters.filePath === undefined || parameters.filePath === '') {
            throw new Error('Invalid input: filePath is required');
        }
        const fileUri = Uri.file(parameters.filePath);

        try {
            const environment = await this.apiGetEnvironment(fileUri);
            if (!environment) {
                // Check if the file is a notebook or a notebook cell to throw specific error messages.
                if (fileUri.fsPath.endsWith('.ipynb') || fileUri.fsPath.includes('.ipynb#')) {
                    throw new Error('Unable to access Jupyter kernels for notebook cells');
                }
                throw new Error('No environment found');
            }
            await this.apiRefreshPackages(environment);
            const installedPackages = await this.apiGetPackages(environment);

            let resultMessage: string;
            if (!installedPackages || installedPackages.length === 0) {
                resultMessage = 'No packages are installed in the current environment.';
            } else {
                const packageNames = installedPackages.map((pkg) => pkg.name).join(', ');
                resultMessage = 'The packages installed in the current environment are as follows:\n' + packageNames;
            }

            if (token.isCancellationRequested) {
                throw new Error('Operation cancelled');
            }

            const textPart = new LanguageModelTextPart(resultMessage || '');
            const result: LanguageModelToolResult = { content: [textPart] };
            return result;
        } catch (error) {
            const errorMessage: string = `An error occurred while fetching packages: ${error}`;
            const textPart = new LanguageModelTextPart(errorMessage);
            return { content: [textPart] } as LanguageModelToolResult;
        }
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
        console.log(message);
        return {
            invocationMessage: message,
        };
    }
}
