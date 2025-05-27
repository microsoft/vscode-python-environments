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
import { PythonEnvironmentApi } from '../../api';
import { EnvironmentManagers } from '../../internal.api';
import {
    getEnvDisplayName,
    getEnvironmentDetails,
    getToolResponseIfNotebook,
    raceCancellationError,
    resolveFilePath,
} from './utils';

export interface IResourceReference {
    resourcePath?: string;
}

export class GetExecutableTool implements LanguageModelTool<IResourceReference> {
    public static readonly toolName = 'get_python_executable_info';
    constructor(private readonly api: PythonEnvironmentApi, private readonly envManagers: EnvironmentManagers) {}
    async invoke(
        options: LanguageModelToolInvocationOptions<IResourceReference>,
        token: CancellationToken,
    ): Promise<LanguageModelToolResult> {
        const resourcePath = resolveFilePath(options.input.resourcePath);
        const notebookResponse = getToolResponseIfNotebook(resourcePath);
        if (notebookResponse) {
            return notebookResponse;
        }
        const environment = await raceCancellationError(this.api.getEnvironment(resourcePath), token);
        if (!environment) {
            throw new Error(`No environment found for the provided resource path ${resourcePath?.fsPath}`);
        }

        const message = await getEnvironmentDetails(
            resourcePath,
            undefined,
            this.api,
            this.envManagers,
            undefined,
            token,
        );

        return new LanguageModelToolResult([new LanguageModelTextPart(message)]);
    }

    async prepareInvocation?(
        options: LanguageModelToolInvocationPrepareOptions<IResourceReference>,
        token: CancellationToken,
    ): Promise<PreparedToolInvocation> {
        const resourcePath = resolveFilePath(options.input.resourcePath);
        const envName = await getEnvDisplayName(this.api, resourcePath, token);
        return {
            invocationMessage: envName
                ? l10n.t('Fetching Python executable information for {0}', envName)
                : l10n.t('Fetching Python executable information'),
        };
    }
}
