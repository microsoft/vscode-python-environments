import * as assert from 'assert';
import * as sinon from 'sinon';
import { ExtensionContext, InputBoxOptions, l10n } from 'vscode';
import * as commandApi from '../../common/command.api';
import * as windowApis from '../../common/window.apis';
import { reportIssue } from '../../features/reportIssue';
import * as helpers from '../../helpers';
import { EnvironmentManagers, PythonProjectManager } from '../../internal.api';

suite('Report Issue Command Tests', () => {
    const context = {} as ExtensionContext;
    const envManagers = {} as EnvironmentManagers;
    const projectManager = {} as PythonProjectManager;

    teardown(() => {
        sinon.restore();
    });

    test('stops when the title input is cancelled', async () => {
        sinon.stub(windowApis, 'showInputBox').resolves(undefined);
        const collectEnvironmentInfo = sinon.stub(helpers, 'collectEnvironmentInfo');
        const executeCommand = sinon.stub(commandApi, 'executeCommand');

        await reportIssue(context, envManagers, projectManager);

        sinon.assert.notCalled(collectEnvironmentInfo);
        sinon.assert.notCalled(executeCommand);
    });

    test('stops when the description input is cancelled', async () => {
        sinon.stub(windowApis, 'showInputBox').onFirstCall().resolves('Issue title').onSecondCall().resolves(undefined);
        const collectEnvironmentInfo = sinon.stub(helpers, 'collectEnvironmentInfo');
        const executeCommand = sinon.stub(commandApi, 'executeCommand');

        await reportIssue(context, envManagers, projectManager);

        sinon.assert.notCalled(collectEnvironmentInfo);
        sinon.assert.notCalled(executeCommand);
    });

    test('validates the minimum description length in the input box', async () => {
        const showInputBox = sinon
            .stub(windowApis, 'showInputBox')
            .onFirstCall()
            .resolves('Issue title')
            .onSecondCall()
            .resolves(undefined);

        await reportIssue(context, envManagers, projectManager);

        const options = showInputBox.secondCall.args[0] as InputBoxOptions;
        assert.ok(options.validateInput);
        assert.strictEqual(await options.validateInput('ab'), l10n.t('Enter at least {0} characters.', 3));
        assert.strictEqual(await options.validateInput('abc'), undefined);
    });

    test('does not collect environment information when confirmation is dismissed', async () => {
        sinon.stub(windowApis, 'showInputBox').onFirstCall().resolves('Issue title').onSecondCall().resolves('Details');
        sinon.stub(windowApis, 'showInformationMessage').resolves(undefined);
        const collectEnvironmentInfo = sinon.stub(helpers, 'collectEnvironmentInfo');
        const executeCommand = sinon.stub(commandApi, 'executeCommand');

        await reportIssue(context, envManagers, projectManager);

        sinon.assert.notCalled(collectEnvironmentInfo);
        sinon.assert.notCalled(executeCommand);
    });

    test('opens a prefilled issue reporter after confirmation', async () => {
        sinon
            .stub(windowApis, 'showInputBox')
            .onFirstCall()
            .resolves('  Issue title  ')
            .onSecondCall()
            .resolves('  Issue details  ');
        const showInformationMessage = sinon
            .stub(windowApis, 'showInformationMessage')
            .resolves(l10n.t('Continue to Issue Reporter'));
        const collectEnvironmentInfo = sinon.stub(helpers, 'collectEnvironmentInfo').resolves('Environment details');
        const executeCommand = sinon.stub(commandApi, 'executeCommand').resolves();

        await reportIssue(context, envManagers, projectManager);

        sinon.assert.calledOnce(showInformationMessage);
        assert.deepStrictEqual(showInformationMessage.firstCall.args, [
            l10n.t(
                'To help the Python Environments team investigate, VS Code will collect details about your Python environments and projects and open a prefilled GitHub issue. You can review and edit it before submitting.',
            ),
            { modal: true },
            l10n.t('Continue to Issue Reporter'),
        ]);
        sinon.assert.calledOnceWithExactly(collectEnvironmentInfo, context, envManagers, projectManager);
        sinon.assert.calledOnce(executeCommand);
        assert.strictEqual(executeCommand.firstCall.args[0], 'workbench.action.openIssueReporter');
        assert.deepStrictEqual(executeCommand.firstCall.args[1], {
            extensionId: 'ms-python.vscode-python-envs',
            issueTitle: '[Python Environments] Issue title',
            issueBody:
                '## Description\nIssue details\n\n## Steps to Reproduce\n1. \n2. \n3. \n\n## Expected Behavior\n\n\n' +
                '## Actual Behavior\n\n\n<!-- The following information was automatically generated -->\n\n<details>\n' +
                '<summary>Environment Information</summary>\n\n```\nEnvironment details\n```\n\n</details>',
        });
    });

    test('shows a localized error when opening the issue reporter fails', async () => {
        sinon.stub(windowApis, 'showInputBox').onFirstCall().resolves('Issue title').onSecondCall().resolves('Details');
        sinon.stub(windowApis, 'showInformationMessage').resolves(l10n.t('Continue to Issue Reporter'));
        sinon.stub(helpers, 'collectEnvironmentInfo').resolves('Environment details');
        sinon.stub(commandApi, 'executeCommand').rejects(new Error('Reporter failed'));
        const showErrorMessage = sinon.stub(windowApis, 'showErrorMessage').resolves(undefined);

        await reportIssue(context, envManagers, projectManager);

        sinon.assert.calledOnce(showErrorMessage);
        assert.strictEqual(
            showErrorMessage.firstCall.args[0],
            l10n.t('Failed to open the issue reporter. Please try again.'),
        );
    });
});
