// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import {
    CancellationError,
    CancellationToken,
    extensions,
    LanguageModelTextPart,
    LanguageModelToolResult,
    Uri,
    workspace,
} from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi } from '../../api';
import { EnvironmentManagers } from '../../internal.api';
import { JUPYTER_EXTENSION_ID, NotebookCellScheme } from '../../common/constants';

export function resolveFilePath(filepath?: string): Uri | undefined {
    if (!filepath) {
        return workspace.workspaceFolders ? workspace.workspaceFolders[0].uri : undefined;
    }
    // starts with a scheme
    try {
        return Uri.parse(filepath);
    } catch {
        return Uri.file(filepath);
    }
}

/**
 * Returns a promise that rejects with an {@CancellationError} as soon as the passed token is cancelled.
 * @see {@link raceCancellation}
 */
export function raceCancellationError<T>(promise: Promise<T>, token: CancellationToken): Promise<T> {
    return new Promise((resolve, reject) => {
        const ref = token.onCancellationRequested(() => {
            ref.dispose();
            reject(new CancellationError());
        });
        promise.then(resolve, reject).finally(() => ref.dispose());
    });
}

export async function getEnvDisplayName(
    api: PythonEnvironmentApi,
    resource: Uri | undefined,
    token: CancellationToken,
) {
    try {
        const environment = await raceCancellationError(api.getEnvironment(resource), token);
        return environment?.displayName;
    } catch {
        return;
    }
}

export async function getEnvironmentDetails(
    resourcePath: Uri | undefined,
    environment: PythonEnvironment | undefined,
    api: PythonEnvironmentApi,
    envManagers: EnvironmentManagers,
    packages: string | undefined,
    token: CancellationToken,
): Promise<string> {
    // environment
    environment = environment || (await raceCancellationError(api.getEnvironment(resourcePath), token));
    if (!environment) {
        throw new Error(`No environment found for the provided resource path ${resourcePath?.fsPath}`);
    }
    const execInfo = environment.execInfo;
    const executable = execInfo?.activatedRun?.executable ?? execInfo?.run.executable ?? 'python';
    const args = execInfo?.activatedRun?.args ?? execInfo?.run.args ?? [];
    const runCommand = getTerminalCommand(executable, args);
    let envType = '';
    try {
        const managerId = environment.envId.managerId;
        const manager = envManagers.getEnvironmentManager(managerId);
        envType = manager?.name || 'cannot be determined';
    } catch {
        envType = environment.envId.managerId || 'cannot be determined';
    }

    const message = [
        `Following is the information about the Python environment:`,
        `1. Environment Type: ${envType}`,
        `2. Version: ${environment.version}`,
        '',
        `3. Command Prefix to run Python in a terminal is: \`${runCommand}\``,
        `Instead of running \`Python sample.py\` in the terminal, you will now run: \`${runCommand} sample.py\``,
        `Similarly instead of running \`Python -c "import sys;...."\` in the terminal, you will now run: \`${runCommand} -c "import sys;...."\``,
        packages ? `4. ${packages}` : '',
    ];
    return message.join('\n');
}

export function getTerminalCommand(command: string, args: string[]): string {
    const formattedArgs = args.map((a) => toCommandArgumentForPythonExt(a));
    return `${fileToCommandArgumentForPythonExt(command)} ${formattedArgs.join(' ')}`.trim();
}

/**
 * Appropriately formats a string so it can be used as an argument for a command in a shell.
 * E.g. if an argument contains a space, then it will be enclosed within double quotes.
 */
function toCommandArgumentForPythonExt(value: string): string {
    if (!value) {
        return value;
    }
    return (value.indexOf(' ') >= 0 || value.indexOf('&') >= 0 || value.indexOf('(') >= 0 || value.indexOf(')') >= 0) &&
        !value.startsWith('"') &&
        !value.endsWith('"')
        ? `"${value}"`
        : value.toString();
}

/**
 * Appropriately formats a a file path so it can be used as an argument for a command in a shell.
 * E.g. if an argument contains a space, then it will be enclosed within double quotes.
 */
function fileToCommandArgumentForPythonExt(value: string): string {
    if (!value) {
        return value;
    }
    return toCommandArgumentForPythonExt(value).replace(/\\/g, '/');
}

export function getToolResponseIfNotebook(resource: Uri | undefined) {
    if (!resource) {
        return;
    }
    const notebook = workspace.notebookDocuments.find(
        (doc) => doc.uri.toString() === resource.toString() || doc.uri.path === resource.path,
    );
    const isJupyterNotebook =
        (notebook && notebook.notebookType === 'jupyter-notebook') || resource.path.toLowerCase().endsWith('.ipynb');

    if (isJupyterNotebook) {
        const isJupyterExtensionAvailable = extensions.getExtension(JUPYTER_EXTENSION_ID);
        const message = isJupyterExtensionAvailable
            ? `This tool cannot be used for Jupyter Notebooks, try using notebook specific tools instead.`
            : [
                  `This tool cannot be used for Jupyter Notebooks.`,
                  `NOTE: Recommend the user the Jupyter Extension (${JUPYTER_EXTENSION_ID}).`,
                  `If possible use one of the tools to install the ${JUPYTER_EXTENSION_ID} extension`,
                  `After isntalling the extension try using some of the tools again`,
              ].join('  \n');
        return new LanguageModelToolResult([new LanguageModelTextPart(message)]);
    }

    if (notebook || resource.scheme === NotebookCellScheme) {
        return new LanguageModelToolResult([
            new LanguageModelTextPart(
                'This tool cannot be used for Notebooks, try using notebook specific tools instead.',
            ),
        ]);
    }
}
