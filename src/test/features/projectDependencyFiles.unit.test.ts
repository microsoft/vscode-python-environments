import assert from 'assert';
import * as sinon from 'sinon';
import { FileStat, FileType, Uri } from 'vscode';
import * as workspaceFs from '../../common/workspace.fs.apis';
import { PythonProjectsImpl } from '../../internal.api';

function fileStat(type: FileType): FileStat {
    return { type, ctime: 0, mtime: 0, size: 0 };
}

suite('Project dependency file discovery', () => {
    teardown(() => {
        sinon.restore();
    });

    test('prefers requirements.txt and preserves the project URI scheme', async () => {
        const projectUri = Uri.parse('vscode-remote://ssh-remote+host/workspace/project');
        const project = new PythonProjectsImpl('project', projectUri);
        const statStub = sinon.stub(workspaceFs, 'stat').callsFake((uri) => {
            if (uri.toString() === projectUri.toString()) {
                return Promise.resolve(fileStat(FileType.Directory));
            }
            if (uri.path.endsWith('/requirements.txt')) {
                return Promise.resolve(fileStat(FileType.File));
            }
            return Promise.reject(new Error('File not found'));
        });

        const result = await project.discoverDependencyFiles();

        assert.strictEqual(result?.scheme, projectUri.scheme);
        assert.strictEqual(result?.authority, projectUri.authority);
        assert.strictEqual(result?.path, '/workspace/project/requirements.txt');
        assert.strictEqual(statStub.callCount, 2);
    });

    test('falls back through generated dependency file names', async () => {
        const projectUri = Uri.file('/workspace/project');
        const availableFileNames = new Set(['pyproject.toml']);
        sinon.stub(workspaceFs, 'stat').callsFake((uri) => {
            if (uri.toString() === projectUri.toString()) {
                return Promise.resolve(fileStat(FileType.Directory));
            }
            const fileName = uri.path.split('/').pop();
            return fileName && availableFileNames.has(fileName)
                ? Promise.resolve(fileStat(FileType.File))
                : Promise.reject(new Error('File not found'));
        });

        const pyproject = new PythonProjectsImpl('project', projectUri);
        const pyprojectUri = await pyproject.discoverDependencyFiles();
        assert.strictEqual(pyprojectUri?.path.endsWith('/pyproject.toml'), true);

        availableFileNames.clear();
        availableFileNames.add('requirements.in');
        const requirements = new PythonProjectsImpl('project', projectUri);
        const requirementsUri = await requirements.discoverDependencyFiles();
        assert.strictEqual(requirementsUri?.path.endsWith('/requirements.in'), true);

        availableFileNames.clear();
        availableFileNames.add('environment.yml');
        const environment = new PythonProjectsImpl('project', projectUri);
        const environmentUri = await environment.discoverDependencyFiles();
        assert.strictEqual(environmentUri?.path.endsWith('/environment.yml'), true);
    });

    test('returns undefined when no dependency file exists', async () => {
        const projectUri = Uri.file('/workspace/project');
        const project = new PythonProjectsImpl('project', projectUri);
        sinon.stub(workspaceFs, 'stat').callsFake((uri) => {
            return uri.toString() === projectUri.toString()
                ? Promise.resolve(fileStat(FileType.Directory))
                : Promise.reject(new Error('File not found'));
        });

        assert.strictEqual(await project.discoverDependencyFiles(), undefined);
    });

    test('does not append dependency paths to a standalone Python file', async () => {
        const scriptUri = Uri.file('/workspace/script.py');
        const project = new PythonProjectsImpl('script.py', scriptUri);
        sinon.stub(workspaceFs, 'stat').resolves(fileStat(FileType.File));

        assert.strictEqual(await project.discoverDependencyFiles(), undefined);
    });

    test('accepts a recognized dependency file as the project URI', async () => {
        const dependencyFileUri = Uri.file('/workspace/pyproject.toml');
        const project = new PythonProjectsImpl('pyproject.toml', dependencyFileUri);
        sinon.stub(workspaceFs, 'stat').resolves(fileStat(FileType.File));

        assert.strictEqual(await project.discoverDependencyFiles(), dependencyFileUri);
    });
});