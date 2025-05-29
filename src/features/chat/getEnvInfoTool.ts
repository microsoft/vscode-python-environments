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
import { getPythonPackagesResponse } from './listPackagesTool';
import { getEnvironmentDetails, getToolResponseIfNotebook, raceCancellationError, resolveFilePath } from './utils';

export interface IResourceReference {
    resourcePath?: string;
}

export class GetEnvironmentInfoTool implements LanguageModelTool<IResourceReference> {
    public static readonly toolName = 'get_python_environment_info';
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

        const packages = await getPythonPackagesResponse(environment, this.api, token);
        const message = await getEnvironmentDetails(
            resourcePath,
            undefined,
            this.api,
            this.envManagers,
            packages,
            token,
        );

        return new LanguageModelToolResult([new LanguageModelTextPart(message)]);
    }

    async prepareInvocation?(
        _options: LanguageModelToolInvocationPrepareOptions<IResourceReference>,
        _token: CancellationToken,
    ): Promise<PreparedToolInvocation> {
        return {
            invocationMessage: l10n.t('Fetching Python environment information'),
        };
    }
}
