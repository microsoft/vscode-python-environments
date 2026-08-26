import * as fs from 'fs-extra';
import * as path from 'path';
import { commands, l10n, MarkdownString, QuickInputButtons, Uri, window, WorkspaceFolder } from 'vscode';
import { PythonProject, PythonProjectCreator, PythonProjectCreatorOptions } from '../../api';
import { NEW_PROJECT_TEMPLATES_FOLDER } from '../../common/constants';
import { traceError } from '../../common/logging';
import { isSameOrParentPath, isWindowsReservedDeviceName } from '../../common/utils/pathUtils';
import { showErrorMessage, showInputBoxWithButtons, showTextDocument } from '../../common/window.apis';
import { getWorkspaceFolder, getWorkspaceFolders } from '../../common/workspace.apis';
import { PythonProjectManager } from '../../internal.api';
import { isCopilotInstalled, manageCopilotInstructionsFile, replaceInFilesAndNames } from './creationHelpers';

function validateScriptFileName(value: string): string | null {
    const pathSegments = value.split(/[\\/]/);
    if (pathSegments.length !== 1 || pathSegments.includes('..')) {
        return l10n.t('Script name must be a file name without path separators or traversal.');
    }
    if (!value.endsWith('.py')) {
        return l10n.t('Script name must end with ".py".');
    }
    const baseName = value.replace(/\.py$/, '');
    if (isWindowsReservedDeviceName(baseName)) {
        return l10n.t('Script name uses a reserved Windows device name.');
    }
    // following PyPI (PEP 508) rules for package names
    if (!/^([a-z_]|[a-z0-9_][a-z0-9._-]*[a-z0-9_])$/i.test(baseName)) {
        return l10n.t(
            'Invalid script name. Use only letters, numbers, underscores, hyphens, or periods. Must start and end with a letter or number.',
        );
    }
    if (/^[-._0-9]$/i.test(baseName)) {
        return l10n.t('Single-character script names cannot be a number, hyphen, or period.');
    }
    return null;
}

function uriForFileRootInWorkspace(rootPath: string, workspaceFolder: WorkspaceFolder): Uri {
    const relativeRootPath = path.relative(path.resolve(workspaceFolder.uri.fsPath), path.resolve(rootPath));
    const pathSegments = relativeRootPath.split(/[\\/]/).filter((segment) => segment.length > 0);
    return workspaceFolder.uri.with({
        path: path.posix.join(workspaceFolder.uri.path, ...pathSegments),
    });
}

export class NewScriptProject implements PythonProjectCreator {
    public readonly name = l10n.t('newScript');
    public readonly displayName = l10n.t('Script');
    public readonly description = l10n.t('Creates a new script in your current workspace');
    public readonly tooltip = new MarkdownString(l10n.t('Create a new Python script'));

    constructor(private readonly projectManager: PythonProjectManager) {}

    async create(options?: PythonProjectCreatorOptions): Promise<PythonProject | Uri | undefined> {
        let scriptFileName = options?.name;
        let createCopilotInstructions: boolean | undefined;
        if (options?.quickCreate === true) {
            // If quickCreate is true, we should not prompt for any input
            if (!scriptFileName) {
                throw new Error('Script file name is required in quickCreate mode.');
            }
            if (path.extname(scriptFileName) === '') {
                scriptFileName = `${scriptFileName}.py`;
            }
            createCopilotInstructions = true;
        } else {
            //Prompt as quickCreate is false
            if (!scriptFileName) {
                try {
                    scriptFileName = await showInputBoxWithButtons({
                        prompt: l10n.t('What is the name of the script? (e.g. my_script.py)'),
                        ignoreFocusOut: true,
                        showBackButton: true,
                        validateInput: validateScriptFileName,
                    });
                } catch (ex) {
                    if (ex === QuickInputButtons.Back) {
                        await commands.executeCommand('python-envs.createNewProjectFromTemplate');
                    }
                }
                if (!scriptFileName) {
                    return undefined;
                }
                if (isCopilotInstalled()) {
                    createCopilotInstructions = true;
                }
            }
        }
        const validationError = validateScriptFileName(scriptFileName);
        if (validationError) {
            if (options?.quickCreate === true) {
                throw new Error(validationError);
            }
            window.showErrorMessage(validationError);
            return undefined;
        }

        // 1. Copy template file
        const newScriptTemplateFile = path.join(NEW_PROJECT_TEMPLATES_FOLDER, 'newInlineScriptTemplate', 'script.py');
        if (!(await fs.pathExists(newScriptTemplateFile))) {
            window.showErrorMessage(l10n.t('Template file does not exist, aborting creation.'));
            traceError(`Template file not found at: ${newScriptTemplateFile}`);
            return undefined;
        }

        // Check if the destination folder is provided, otherwise use the first workspace folder.
        let destinationRootUri = options?.rootUri;
        let workspaceFolders: readonly WorkspaceFolder[] | undefined;
        if (!destinationRootUri) {
            workspaceFolders = getWorkspaceFolders();
            if (!workspaceFolders || workspaceFolders.length === 0) {
                window.showErrorMessage(l10n.t('No workspace folder is open or provided, aborting creation.'));
                return undefined;
            }
            destinationRootUri = workspaceFolders[0].uri;
        }

        const destRoot = destinationRootUri.fsPath;
        const resolvedDestRoot = path.resolve(destRoot);
        let workspaceFolder = getWorkspaceFolder(destinationRootUri);
        if (!workspaceFolder && destinationRootUri.scheme === 'file') {
            workspaceFolders ??= getWorkspaceFolders();
            workspaceFolder = workspaceFolders
                ?.filter((folder) => isSameOrParentPath(folder.uri.fsPath, resolvedDestRoot))
                .sort((first, second) => second.uri.fsPath.length - first.uri.fsPath.length)[0];
        }
        if (!workspaceFolder) {
            showErrorMessage(l10n.t('Destination folder must be inside an open workspace, aborting creation.'));
            return undefined;
        }

        let physicalDestRoot: string;
        let physicalWorkspaceRoot: string;
        try {
            [physicalDestRoot, physicalWorkspaceRoot] = await Promise.all([
                fs.realpath(resolvedDestRoot),
                fs.realpath(workspaceFolder.uri.fsPath),
            ]);
        } catch (error) {
            traceError('Failed to resolve the destination or workspace folder:', error);
            showErrorMessage(l10n.t('Unable to resolve the destination folder inside the open workspace.'));
            return undefined;
        }
        if (!isSameOrParentPath(physicalWorkspaceRoot, physicalDestRoot)) {
            showErrorMessage(l10n.t('Destination folder must resolve inside the open workspace, aborting creation.'));
            return undefined;
        }

        const identityRootUri =
            destinationRootUri.scheme === 'file' && workspaceFolder.uri.scheme !== 'file'
                ? uriForFileRootInWorkspace(resolvedDestRoot, workspaceFolder)
                : destinationRootUri;
        const scriptDestination = path.resolve(resolvedDestRoot, scriptFileName);
        const relativeScriptPath = path.relative(resolvedDestRoot, scriptDestination);
        if (
            relativeScriptPath === '' ||
            relativeScriptPath === '..' ||
            relativeScriptPath.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relativeScriptPath)
        ) {
            const containmentError = l10n.t('Script name must resolve to a file inside the destination folder.');
            if (options?.quickCreate === true) {
                throw new Error(containmentError);
            }
            window.showErrorMessage(containmentError);
            return undefined;
        }

        // Check if the destination file already exists
        if (await fs.pathExists(scriptDestination)) {
            window.showErrorMessage(
                l10n.t(
                    'A script file by that name already exists, aborting creation. Please retry with a unique script name given your workspace.',
                ),
            );
            return undefined;
        }
        // Build the project entry up front so copying the template, substituting
        // the script name, and registering the project share one cleanup boundary:
        // if any step fails, the partially created script is removed so a retry
        // starts from a clean state.
        const createdScript: PythonProject = {
            name: scriptFileName,
            uri: identityRootUri.with({
                path: path.posix.join(identityRootUri.path, scriptFileName),
            }),
        };
        let projectRegistrationAttempted = false;
        try {
            await fs.copy(newScriptTemplateFile, scriptDestination);
            // Replace 'script_name' in the file (script name without the .py suffix).
            await replaceInFilesAndNames(scriptDestination, 'script_name', scriptFileName.replace(/\.py$/, ''));
            projectRegistrationAttempted = true;
            await this.projectManager.add(createdScript);
        } catch (creationError) {
            if (projectRegistrationAttempted) {
                try {
                    this.projectManager.remove(createdScript);
                } catch (rollbackError) {
                    traceError('Failed to remove the new script project after creation failed:', rollbackError);
                }
            }
            try {
                await fs.remove(scriptDestination);
            } catch (rollbackError) {
                traceError('Failed to delete the new script after creation failed:', rollbackError);
            }
            throw creationError;
        }

        // 3. add custom github copilot instructions
        if (createCopilotInstructions) {
            const packageInstructionsPath = path.join(
                NEW_PROJECT_TEMPLATES_FOLDER,
                'copilot-instructions-text',
                'script-copilot-instructions.md',
            );
            await manageCopilotInstructionsFile(destRoot, packageInstructionsPath, [
                { searchValue: '<script_name>', replaceValue: scriptFileName },
            ]);
        }

        await showTextDocument(createdScript.uri);

        return createdScript;
    }
}
