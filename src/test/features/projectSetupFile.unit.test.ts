import assert from 'assert';
import * as sinon from 'sinon';
import { FileStat, FileType, Uri } from 'vscode';
import * as workspaceFs from '../../common/workspace.fs.apis';
import { PythonProjectsImpl } from '../../internal.api';

function fileStat(type: FileType): FileStat {
    return { type, ctime: 0, mtime: 0, size: 0 };
}

suite('Project setup file discovery', () => {
    teardown(() => {
        sinon.restore();
    });

    test('prefers pyproject.toml and preserves the project URI scheme', async () => {
        const projectUri = Uri.parse('vscode-remote://ssh-remote+host/workspace/project');
        const project = new PythonProjectsImpl('project', projectUri);
        const statStub = sinon.stub(workspaceFs, 'stat').callsFake((uri) => {
            if (uri.toString() === projectUri.toString()) {
                return Promise.resolve(fileStat(FileType.Directory));
            }
            if (uri.path.endsWith('/pyproject.toml')) {
                return Promise.resolve(fileStat(FileType.File));
            }
            return Promise.reject(new Error('File not found'));
        });

        const result = await project.discoverProjectSetupFile();

        assert.strictEqual(result?.scheme, projectUri.scheme);
        assert.strictEqual(result?.authority, projectUri.authority);
        assert.strictEqual(result?.path, '/workspace/project/pyproject.toml');
        assert.strictEqual(statStub.callCount, 2);
    });

    test('falls back to setup.py and requirements.txt', async () => {
        const projectUri = Uri.file('/workspace/project');
        const availableFileNames = new Set(['setup.py']);
        sinon.stub(workspaceFs, 'stat').callsFake((uri) => {
            if (uri.toString() === projectUri.toString()) {
                return Promise.resolve(fileStat(FileType.Directory));
            }
            const fileName = uri.path.split('/').pop();
            return fileName && availableFileNames.has(fileName)
                ? Promise.resolve(fileStat(FileType.File))
                : Promise.reject(new Error('File not found'));
        });

        const setupProject = new PythonProjectsImpl('project', projectUri);
        const setupFileUri = await setupProject.discoverProjectSetupFile();
        assert.strictEqual(setupFileUri?.path.endsWith('/setup.py'), true);

        availableFileNames.clear();
        availableFileNames.add('requirements.txt');
        const requirementsProject = new PythonProjectsImpl('project', projectUri);
        const requirementsFileUri = await requirementsProject.discoverProjectSetupFile();
        assert.strictEqual(requirementsFileUri?.path.endsWith('/requirements.txt'), true);
    });

    test('returns undefined when no setup file exists', async () => {
        const projectUri = Uri.file('/workspace/project');
        const project = new PythonProjectsImpl('project', projectUri);
        sinon.stub(workspaceFs, 'stat').callsFake((uri) => {
            return uri.toString() === projectUri.toString()
                ? Promise.resolve(fileStat(FileType.Directory))
                : Promise.reject(new Error('File not found'));
        });

        assert.strictEqual(await project.discoverProjectSetupFile(), undefined);
    });

    test('does not append setup paths to a standalone Python file', async () => {
        const scriptUri = Uri.file('/workspace/script.py');
        const project = new PythonProjectsImpl('script.py', scriptUri);
        sinon.stub(workspaceFs, 'stat').resolves(fileStat(FileType.File));

        assert.strictEqual(await project.discoverProjectSetupFile(), undefined);
    });

    test('accepts a recognized setup file as the project URI', async () => {
        const setupFileUri = Uri.file('/workspace/pyproject.toml');
        const project = new PythonProjectsImpl('pyproject.toml', setupFileUri);
        sinon.stub(workspaceFs, 'stat').resolves(fileStat(FileType.File));

        assert.strictEqual(await project.discoverProjectSetupFile(), setupFileUri);
    });
});
