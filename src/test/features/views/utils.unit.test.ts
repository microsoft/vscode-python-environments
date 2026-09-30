/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from 'assert';
import * as sinon from 'sinon';
import { PythonProject } from '../../../api';
import * as platformUtils from '../../../common/utils/platformUtils';
import * as workspaceApis from '../../../common/workspace.apis';
import { removable } from '../../../features/views/utils';

/**
 * Builds a minimal PythonProject-like object for the given filesystem path.
 */
function makeProject(fsPath: string): PythonProject {
    return { name: fsPath, uri: { fsPath } } as any;
}

/**
 * Stubs getWorkspaceFolder to return a workspace folder with the given path.
 */
function stubWorkspaceFolder(getWsStub: sinon.SinonStub, fsPath: string | undefined): void {
    getWsStub.returns(fsPath === undefined ? undefined : ({ uri: { fsPath } } as any));
}

suite('Views utils - removable', () => {
    let getWorkspaceFolderStub: sinon.SinonStub;
    let isWindowsStub: sinon.SinonStub;

    setup(() => {
        getWorkspaceFolderStub = sinon.stub(workspaceApis, 'getWorkspaceFolder');
        isWindowsStub = sinon.stub(platformUtils, 'isWindows');
    });

    teardown(() => {
        sinon.restore();
    });

    test('returns true when the project has no workspace folder', () => {
        stubWorkspaceFolder(getWorkspaceFolderStub, undefined);
        assert.strictEqual(removable(makeProject('/home/user/project')), true);
    });

    test('returns false when project path equals workspace path', () => {
        isWindowsStub.returns(false);
        stubWorkspaceFolder(getWorkspaceFolderStub, '/home/user/project');
        assert.strictEqual(removable(makeProject('/home/user/project')), false);
    });

    test('returns true when project is nested inside the workspace folder', () => {
        isWindowsStub.returns(false);
        stubWorkspaceFolder(getWorkspaceFolderStub, '/home/user/workspace');
        assert.strictEqual(removable(makeProject('/home/user/workspace/project')), true);
    });

    test('Windows: matches paths that differ only by drive-letter case', () => {
        // Regression: path.normalize() does not lowercase, so 'C:\\ws' and 'c:\\ws'
        // would not match and the workspace root would be wrongly reported removable.
        isWindowsStub.returns(true);
        stubWorkspaceFolder(getWorkspaceFolderStub, 'C:\\Users\\test\\project');
        assert.strictEqual(removable(makeProject('c:\\users\\test\\project')), false);
    });

    test('Windows: matches paths that differ only by slash direction', () => {
        isWindowsStub.returns(true);
        stubWorkspaceFolder(getWorkspaceFolderStub, 'C:\\Users\\test\\project');
        assert.strictEqual(removable(makeProject('C:/Users/test/project')), false);
    });

    test('non-Windows comparison stays case-sensitive', () => {
        isWindowsStub.returns(false);
        stubWorkspaceFolder(getWorkspaceFolderStub, '/home/user/Project');
        assert.strictEqual(removable(makeProject('/home/user/project')), true);
    });
});
