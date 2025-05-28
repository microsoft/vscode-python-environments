// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import {
    CancellationToken,
    l10n,
    LanguageModelTextPart,
    LanguageModelTool,
    LanguageModelToolInvocationOptions,
    LanguageModelToolInvocationPrepareOptions,
    LanguageModelToolResult,
    PreparedToolInvocation,
} from 'vscode';
import { PackageManagementOptions, PythonEnvironmentApi } from '../../api';
import { getToolResponseIfNotebook, raceCancellationError, resolveFilePath } from './utils';

/**
 * The input interface for the Install Package Tool.
 */
export interface IInstallPackageInput {
    packageList: string[];
    resourcePath?: string;
}

/**
 * A tool to install Python packages in the active environment.
 */
export class InstallPackageTool implements LanguageModelTool<IInstallPackageInput> {
    public static readonly toolName = 'install_python_package';
    constructor(private readonly api: PythonEnvironmentApi) {}

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
        const parameters: IInstallPackageInput = options.input;
        if (!parameters.packageList || parameters.packageList.length === 0) {
            throw new Error('Invalid input: packageList is required and cannot be empty');
        }
        const resourcePath = resolveFilePath(options.input.resourcePath);
        const packageCount = parameters.packageList.length;
        const packagePlurality = packageCount === 1 ? 'package' : 'packages';

        const netobookResponse = getToolResponseIfNotebook(resourcePath);
        if (netobookResponse) {
            // If the tool is invoked in a notebook, return the response directly.
            return netobookResponse;
        }

        const environment = await this.api.getEnvironment(resourcePath);
        if (!environment) {
            // Check if the file is a notebook or a notebook cell to throw specific error messages.
            if (resourcePath && (resourcePath.fsPath.endsWith('.ipynb') || resourcePath.fsPath.includes('.ipynb#'))) {
                throw new Error('Unable to access Jupyter kernels for notebook cells');
            }
            throw new Error('No environment found');
        }

        // Install the packages
        const pkgManagementOptions: PackageManagementOptions = { install: parameters.packageList };
        await raceCancellationError(this.api.managePackages(environment, pkgManagementOptions), token);
        const resultMessage = `Successfully installed ${packagePlurality}: ${parameters.packageList.join(', ')}`;

        return new LanguageModelToolResult([new LanguageModelTextPart(resultMessage)]);
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
        const resourcePath = resolveFilePath(options.input.resourcePath);

        const packageCount = options.input.packageList.length;
        let envName = '';
        try {
            const environment = await this.api.getEnvironment(resourcePath);
            envName = environment?.displayName || '';
        } catch {
            //
        }

        let title = '';
        let invocationMessage = '';
        const message =
            packageCount === 1
                ? ''
                : l10n.t(`The following packages will be installed: {0}`, options.input.packageList.sort().join(', '));
        if (envName) {
            title =
                packageCount === 1
                    ? l10n.t(`Install {0} in {1}?`, options.input.packageList[0], envName)
                    : l10n.t(`Install packages in {0}?`, envName);
            invocationMessage =
                packageCount === 1
                    ? l10n.t(`Installing {0} in {1}`, options.input.packageList[0], envName)
                    : l10n.t(`Installing packages {0} in {1}`, options.input.packageList.sort().join(', '), envName);
        } else {
            title =
                options.input.packageList.length === 1
                    ? l10n.t(`Install Python package '{0}'?`, options.input.packageList[0])
                    : l10n.t(`Install Python packages?`);
            invocationMessage =
                packageCount === 1
                    ? l10n.t(`Installing Python package '{0}'`, options.input.packageList[0])
                    : l10n.t(`Installing Python packages: {0}`, options.input.packageList.sort().join(', '));
        }

        return {
            confirmationMessages: { title, message },
            invocationMessage,
        };
    }
}
