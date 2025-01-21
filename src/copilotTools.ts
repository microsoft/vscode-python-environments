import * as vscode from 'vscode';
import { PythonEnvironmentApi } from './api';
import { getPythonApi } from './features/pythonApi';

export interface IGetActiveFile {
    filePath?: string;
}

/**
 * A tool to get the list of installed Python packages in the active environment.
 */
export class GetPackagesTool implements vscode.LanguageModelTool<IGetActiveFile> {
    /**
     * Invokes the tool to get the list of installed packages.
     * @param options - The invocation options containing the file path.
     * @param token - The cancellation token.
     * @returns The result containing the list of installed packages or an error message.
     */
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IGetActiveFile>,
        token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const parameters: IGetActiveFile = options.input;

        if (parameters.filePath === undefined) {
            throw new Error('Invalid input: filePath is required');
        }
        const fileUri = vscode.Uri.file(parameters.filePath);

        // Check if the file is a notebook or a notebook cell
        if (fileUri.fsPath.endsWith('.ipynb') || fileUri.scheme === 'vscode-notebook-cell') {
            throw new Error('Unable to access Jupyter kernels for notebook cells');
        }

        try {
            const pythonApi: PythonEnvironmentApi = await getPythonApi();
            const environment = await pythonApi.getEnvironment(fileUri);
            if (!environment) {
                throw new Error('No environment found');
            }
            await pythonApi.refreshPackages(environment);
            const installedPackages = await pythonApi.getPackages(environment);

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

            const textPart = new vscode.LanguageModelTextPart(resultMessage || '');
            const result: vscode.LanguageModelToolResult = new vscode.LanguageModelToolResult([textPart]);
            return result;
        } catch (error) {
            const errorMessage = `An error occurred while fetching packages: ${error.message}`;
            const textPart = new vscode.LanguageModelTextPart(errorMessage);
            return new vscode.LanguageModelToolResult([textPart]);
        }
    }

    /**
     * Prepares the invocation of the tool.
     * @param _options - The preparation options.
     * @param _token - The cancellation token.
     * @returns The prepared tool invocation.
     */
    async prepareInvocation?(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<IGetActiveFile>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        const message = 'Preparing to fetch the list of installed Python packages...';
        console.log(message);
        return {
            invocationMessage: message,
        };
    }
}

/**
 * Registers the chat tools with the given extension context.
 * @param context - The extension context.
 */
export function registerChatTools(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.lm.registerTool('python_get_python_packages', new GetPackagesTool()));
}
