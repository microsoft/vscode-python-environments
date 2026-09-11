import { ExtensionContext, l10n } from 'vscode';
import * as commandApi from '../common/command.api';
import { traceError } from '../common/logging';
import * as windowApis from '../common/window.apis';
import { collectEnvironmentInfo } from '../helpers';
import { EnvironmentManagers, PythonProjectManager } from '../internal.api';

const MINIMUM_DESCRIPTION_LENGTH = 3;

/**
 * Collects issue details and opens a prefilled issue reporter after the user confirms diagnostic collection.
 *
 * @param context The extension context used to collect extension information.
 * @param envManagers The registered Python environment managers.
 * @param projectManager The Python project manager.
 */
export async function reportIssue(
    context: ExtensionContext,
    envManagers: EnvironmentManagers,
    projectManager: PythonProjectManager,
): Promise<void> {
    try {
        const rawTitle = await windowApis.showInputBox({
            title: l10n.t('Report Issue - Title'),
            prompt: l10n.t('Enter a brief title for the issue'),
            placeHolder: l10n.t('e.g., Environment not detected, activation fails, etc.'),
            ignoreFocusOut: true,
        });
        const title = rawTitle?.trim();

        if (!title) {
            return;
        }

        const rawDescription = await windowApis.showInputBox({
            title: l10n.t('Report Issue - Description'),
            prompt: l10n.t('Describe the issue in more detail'),
            placeHolder: l10n.t('Provide additional context about what happened...'),
            ignoreFocusOut: true,
            validateInput: (value) =>
                value.trim().length < MINIMUM_DESCRIPTION_LENGTH
                    ? l10n.t('Enter at least {0} characters.', MINIMUM_DESCRIPTION_LENGTH)
                    : undefined,
        });
        const description = rawDescription?.trim();

        if (!description || description.length < MINIMUM_DESCRIPTION_LENGTH) {
            return;
        }

        const continueAction = l10n.t('Continue to Issue Reporter');
        const confirmation = await windowApis.showInformationMessage(
            l10n.t(
                'To help the Python Environments team investigate, VS Code will collect details about your Python environments and projects and open a prefilled GitHub issue. You can review and edit it before submitting.',
            ),
            { modal: true },
            continueAction,
        );

        if (confirmation !== continueAction) {
            return;
        }

        const issueData = await collectEnvironmentInfo(context, envManagers, projectManager);

        await commandApi.executeCommand('workbench.action.openIssueReporter', {
            extensionId: 'ms-python.vscode-python-envs',
            issueTitle: `[Python Environments] ${title}`,
            issueBody: `## Description\n${description}\n\n## Steps to Reproduce\n1. \n2. \n3. \n\n## Expected Behavior\n\n\n## Actual Behavior\n\n\n<!-- The following information was automatically generated -->\n\n<details>\n<summary>Environment Information</summary>\n\n\`\`\`\n${issueData}\n\`\`\`\n\n</details>`,
        });
    } catch (error) {
        traceError('Failed to open issue reporter', error);
        await windowApis.showErrorMessage(l10n.t('Failed to open the issue reporter. Please try again.'));
    }
}
