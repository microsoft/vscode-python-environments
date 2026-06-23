import assert from 'node:assert';
import { resolveVariables } from '../../common/utils/internalVariables';
import * as workspaceApi from '../../common/workspace.apis';
import * as sinon from 'sinon';
import * as path from 'path';
import { Uri } from 'vscode';

suite('Internal Variable substitution', () => {
    let getWorkspaceFolderStub: sinon.SinonStub;
    let getWorkspaceFoldersStub: sinon.SinonStub;

    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    const project = { name: 'project1', uri: { fsPath: path.join(home, 'workspace1', 'project1') } };
    const workspaceFolder = { name: 'workspace1', uri: { fsPath: path.join(home, 'workspace1') } };

    setup(() => {
        getWorkspaceFolderStub = sinon.stub(workspaceApi, 'getWorkspaceFolder');
        getWorkspaceFoldersStub = sinon.stub(workspaceApi, 'getWorkspaceFolders');

        getWorkspaceFolderStub.returns(workspaceFolder);
        getWorkspaceFoldersStub.returns([workspaceFolder]);
    });

    teardown(() => {
        sinon.restore();
    });

    [
        { variable: '${userHome}', substitution: home },
        { variable: '${pythonProject}', substitution: project.uri.fsPath },
        { variable: '${workspaceFolder}', substitution: workspaceFolder.uri.fsPath },
        { variable: '${workspaceFolder:workspace1}', substitution: workspaceFolder.uri.fsPath },
        { variable: '${cwd}', substitution: process.cwd() },
        process.platform === 'win32'
            ? { variable: '${env:USERPROFILE}', substitution: home }
            : { variable: '${env:HOME}', substitution: home },
    ].forEach((item) => {
        test(`Resolve ${item.variable}`, () => {
            // Two times here to ensure that both instances are handled
            const value = `Some ${item.variable} text ${item.variable}`;
            const result = resolveVariables(value, project.uri as unknown as Uri);
            assert.equal(result, `Some ${item.substitution} text ${item.substitution}`);
        });
    });

    test('Resolve ${workspaceFolder} via single-folder fallback when owning folder is undefined', () => {
        // Simulates the Windows scenario where workspace.getWorkspaceFolder() fails to find the
        // owning folder (e.g. drive-letter casing). With a single open folder, the token should
        // still resolve instead of being left as a literal ${workspaceFolder}.
        getWorkspaceFolderStub.returns(undefined);
        getWorkspaceFoldersStub.returns([workspaceFolder]);

        const result = resolveVariables('${workspaceFolder}/.venv/Scripts/python.exe', project.uri as unknown as Uri);

        assert.equal(result, `${workspaceFolder.uri.fsPath}/.venv/Scripts/python.exe`);
        assert.ok(!result.includes('${workspaceFolder}'), 'token should be expanded');
    });

    test('Leaves ${workspaceFolder} unresolved when no project scope is provided', () => {
        // Global scope (no project) must not resolve workspace-specific variables.
        getWorkspaceFolderStub.returns(undefined);
        getWorkspaceFoldersStub.returns([workspaceFolder]);

        const result = resolveVariables('${workspaceFolder}/.venv/Scripts/python.exe');

        assert.equal(result, '${workspaceFolder}/.venv/Scripts/python.exe');
    });

    test('Does not use single-folder fallback for ${workspaceFolder} with multiple folders', () => {
        const otherFolder = { name: 'workspace2', uri: { fsPath: path.join(home, 'workspace2') } };
        getWorkspaceFolderStub.returns(undefined);
        getWorkspaceFoldersStub.returns([workspaceFolder, otherFolder]);

        const result = resolveVariables('${workspaceFolder}/.venv/Scripts/python.exe', project.uri as unknown as Uri);

        assert.equal(result, '${workspaceFolder}/.venv/Scripts/python.exe');
    });
});
