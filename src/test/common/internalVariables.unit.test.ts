import assert from 'node:assert';
import { resolveVariables } from '../../common/utils/internalVariables';
import * as workspaceApi from '../../common/workspace.apis';
import * as sinon from 'sinon';

suite('Internal Variable substitution', () => {
    let getWorkspaceFolderStub: sinon.SinonStub;
    let getWorkspaceFoldersStub: sinon.SinonStub;

    const home = process.env.HOME ?? process.env.USERPROFILE;
    const project = { name: 'project', uri: { fsPath: 'project' } };
    const workspaceFolder = { name: 'workspaceFolder', uri: { fsPath: 'workspaceFolder' } };

    setup(() => {
        getWorkspaceFolderStub = sinon.stub(workspaceApi, 'getWorkspaceFolder');
        getWorkspaceFoldersStub = sinon.stub(workspaceApi, 'getWorkspaceFolders');

        getWorkspaceFolderStub.callsFake(() => {
            return workspaceFolder;
        });

        getWorkspaceFoldersStub.callsFake(() => {
            return [workspaceFolder];
        });
    });

    [
        { variable: '${userHome}', substitution: home },
        { variable: '${pythonProject}', substitution: project.uri.fsPath },
        { variable: '${workspaceFolder}', substitution: workspaceFolder.uri.fsPath },
    ].forEach((item) => {
        test(`Resolve ${item.variable}`, () => {
            const value = `Some ${item.variable} text`;
            const result = resolveVariables(value, project.uri as any);
            assert.equal(result, `Some ${item.substitution} text`);
        });
    });

    teardown(() => {
        sinon.restore();
    });
});
