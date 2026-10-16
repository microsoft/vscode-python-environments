// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { Uri, WorkspaceConfiguration, WorkspaceFolder } from 'vscode';
import * as workspaceApis from '../../../common/workspace.apis';
import { isEnvironmentsExtensionEnabled } from '../../../features/settings/settingHelpers';

type SettingInspection = {
    defaultValue?: boolean;
    globalValue?: boolean;
    workspaceValue?: boolean;
    workspaceFolderValue?: boolean;
};

function createConfiguration(inspection: SettingInspection | undefined): WorkspaceConfiguration {
    return {
        inspect: sinon.stub().withArgs('useEnvironmentsExtension').returns(inspection),
    } as unknown as WorkspaceConfiguration;
}

function createWorkspaceFolder(name: string, index: number): WorkspaceFolder {
    return {
        uri: Uri.joinPath(Uri.file(process.cwd()), name),
        name,
        index,
    };
}

suite('isEnvironmentsExtensionEnabled', () => {
    teardown(() => {
        sinon.restore();
    });

    test('ignores a contributed default when no value is explicitly configured', () => {
        sinon.stub(workspaceApis, 'getWorkspaceFolders').returns(undefined);
        sinon
            .stub(workspaceApis, 'getConfiguration')
            .withArgs('python', undefined)
            .returns(createConfiguration({ defaultValue: false }));

        assert.strictEqual(isEnvironmentsExtensionEnabled(), true);
    });

    test('uses an explicit user false value when no workspace is open', () => {
        sinon.stub(workspaceApis, 'getWorkspaceFolders').returns(undefined);
        sinon
            .stub(workspaceApis, 'getConfiguration')
            .withArgs('python', undefined)
            .returns(createConfiguration({ globalValue: false }));

        assert.strictEqual(isEnvironmentsExtensionEnabled(), false);
    });

    test('uses a workspace true value over a user false value', () => {
        const workspaceFolder = createWorkspaceFolder('workspace', 0);
        sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([workspaceFolder]);
        sinon
            .stub(workspaceApis, 'getConfiguration')
            .withArgs('python', workspaceFolder.uri)
            .returns(createConfiguration({ globalValue: false, workspaceValue: true }));

        assert.strictEqual(isEnvironmentsExtensionEnabled(), true);
    });

    test('uses a workspace false value over a user true value', () => {
        const workspaceFolder = createWorkspaceFolder('workspace', 0);
        sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([workspaceFolder]);
        sinon
            .stub(workspaceApis, 'getConfiguration')
            .withArgs('python', workspaceFolder.uri)
            .returns(createConfiguration({ globalValue: true, workspaceValue: false }));

        assert.strictEqual(isEnvironmentsExtensionEnabled(), false);
    });

    test('uses a workspace-folder false value over a workspace true value', () => {
        const workspaceFolder = createWorkspaceFolder('workspace', 0);
        sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([workspaceFolder]);
        sinon
            .stub(workspaceApis, 'getConfiguration')
            .withArgs('python', workspaceFolder.uri)
            .returns(createConfiguration({ workspaceValue: true, workspaceFolderValue: false }));

        assert.strictEqual(isEnvironmentsExtensionEnabled(), false);
    });

    test('activates when any workspace folder resolves to true', () => {
        const disabledFolder = createWorkspaceFolder('disabled', 0);
        const enabledFolder = createWorkspaceFolder('enabled', 1);
        sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([disabledFolder, enabledFolder]);
        const getConfiguration = sinon.stub(workspaceApis, 'getConfiguration');
        getConfiguration
            .withArgs('python', disabledFolder.uri)
            .returns(createConfiguration({ workspaceValue: false }));
        getConfiguration
            .withArgs('python', enabledFolder.uri)
            .returns(createConfiguration({ workspaceValue: false, workspaceFolderValue: true }));

        assert.strictEqual(isEnvironmentsExtensionEnabled(), true);
    });
});
