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
    LogOutputChannel,
    PreparedToolInvocation,
} from 'vscode';
import { PythonEnvironmentApi } from '../../api';
import { EnvironmentManagers, PythonProjectManager } from '../../internal.api';
import { createAnyEnvironmentCommand } from '../envCommands';
import { getEnvironmentDetails, resolveFilePath } from './utils';
import { SysPythonManager } from '../../managers/builtin/sysPythonManager';
import { ensureGlobalEnv } from '../../managers/builtin/venvUtils';

export interface IResourceReference {
    packageList?: string[];
    resourcePath?: string;
}

export class CreateQuickVirtualEnvironmentTool implements LanguageModelTool<IResourceReference> {
    public static readonly toolName = 'create_quick_virtual_environment';
    constructor(
        private readonly api: PythonEnvironmentApi,
        private readonly envManagers: EnvironmentManagers,
        private readonly projectManager: PythonProjectManager,
        private readonly sysManager: Promise<SysPythonManager>,
        private readonly log: LogOutputChannel,
    ) {}
    async invoke(
        options: LanguageModelToolInvocationOptions<IResourceReference>,
        token: CancellationToken,
    ): Promise<LanguageModelToolResult | undefined> {
        const resourcePath = resolveFilePath(options.input.resourcePath);
        const env = await createAnyEnvironmentCommand(this.envManagers, this.projectManager, {
            selectEnvironment: true,
            quickCreate: true,
            uri: resourcePath,
            additionalPackages:
                Array.isArray(options.input.packageList) && options.input.packageList.length
                    ? options.input.packageList
                    : [],
        });
        if (env) {
            const message = await getEnvironmentDetails(
                resourcePath,
                env,
                this.api,
                this.envManagers,
                undefined,
                token,
            );
            return new LanguageModelToolResult([new LanguageModelTextPart(message)]);
        }
    }

    async prepareInvocation?(
        _options: LanguageModelToolInvocationPrepareOptions<IResourceReference>,
        _token: CancellationToken,
    ): Promise<PreparedToolInvocation> {
        let version = '';
        try {
            const sysMgr = await this.sysManager;
            const globals = await sysMgr.getEnvironments('global');
            const sortedEnvs = ensureGlobalEnv(globals, this.log);
            version = getDisplayVersion(sortedEnvs[0].version);
        } catch (ex) {
            this.log.error('Failed to get Python version for quick virtual environment creation', ex);
        }

        return {
            confirmationMessages: {
                title: l10n.t('Create a Virtual Environment{0}?', version ? ` (${version})` : ''),
                message: l10n.t(`Virtual Environments provide the benefit of package isolation and more.`),
            },
            invocationMessage: l10n.t('Creating a Virtual Environment'),
        };
    }
}

function getDisplayVersion(version: string): string {
    if (!version) {
        return '';
    }
    const parts = version.split('.');
    if (parts.length < 3) {
        return version;
    }
    return `${parts[0]}.${parts[1]}.${parts[2]}`;
}
