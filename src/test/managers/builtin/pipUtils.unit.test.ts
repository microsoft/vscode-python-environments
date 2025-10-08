import assert from 'assert';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import { getProjectInstallable } from '../../../managers/builtin/pipUtils';
import * as wapi from '../../../common/workspace.apis';
import * as winapi from '../../../common/window.apis';

suite('Pip Utils - getProjectInstallable', () => {
    let findFilesStub: sinon.SinonStub;
    let withProgressStub: sinon.SinonStub;
    let mockApi: any;

    setup(() => {
        findFilesStub = sinon.stub(wapi, 'findFiles');
        // Stub withProgress to immediately execute the callback
        withProgressStub = sinon.stub(winapi, 'withProgress');
        withProgressStub.callsFake(async (_options: any, callback: any) => {
            return await callback(undefined, { isCancellationRequested: false });
        });
        
        mockApi = {
            getPythonProject: (uri: Uri) => {
                // Return a project for any URI in /workspace
                if (uri.fsPath.startsWith('/workspace')) {
                    return { uri: Uri.file('/workspace') };
                }
                return undefined;
            },
        };
    });

    teardown(() => {
        sinon.restore();
    });

    test('should find dev-requirements.txt at workspace root', async () => {
        // Arrange: Mock findFiles to return both requirements.txt and dev-requirements.txt
        findFilesStub.callsFake((pattern: string) => {
            if (pattern === '**/*requirements*.txt') {
                // This pattern might not match root-level files in VS Code
                return Promise.resolve([]);
            } else if (pattern === '*requirements*.txt') {
                // This pattern should match root-level files
                return Promise.resolve([
                    Uri.file('/workspace/requirements.txt'),
                    Uri.file('/workspace/dev-requirements.txt'),
                    Uri.file('/workspace/test-requirements.txt'),
                ]);
            } else if (pattern === '**/requirements/*.txt') {
                return Promise.resolve([]);
            } else if (pattern === '**/pyproject.toml') {
                return Promise.resolve([]);
            }
            return Promise.resolve([]);
        });

        // Act: Call getProjectInstallable
        const projects = [{ name: 'workspace', uri: Uri.file('/workspace') }];
        const result = await getProjectInstallable(mockApi, projects);

        // Assert: Should find all three requirements files
        assert.strictEqual(result.length, 3, 'Should find three requirements files');
        
        const names = result.map((r) => r.name).sort();
        assert.deepStrictEqual(
            names,
            ['dev-requirements.txt', 'requirements.txt', 'test-requirements.txt'],
            'Should find requirements.txt, dev-requirements.txt, and test-requirements.txt',
        );

        // Verify each file has correct properties
        result.forEach((item) => {
            assert.strictEqual(item.group, 'Requirements', 'Should be in Requirements group');
            assert.ok(item.args, 'Should have args');
            assert.strictEqual(item.args?.length, 2, 'Should have 2 args');
            assert.strictEqual(item.args?.[0], '-r', 'First arg should be -r');
            assert.ok(item.uri, 'Should have a URI');
        });
    });

    test('should deduplicate files found by multiple patterns', async () => {
        // Arrange: Mock both patterns to return the same file
        findFilesStub.callsFake((pattern: string) => {
            if (pattern === '**/*requirements*.txt') {
                return Promise.resolve([
                    Uri.file('/workspace/dev-requirements.txt'),
                ]);
            } else if (pattern === '*requirements*.txt') {
                return Promise.resolve([
                    Uri.file('/workspace/dev-requirements.txt'),
                    Uri.file('/workspace/requirements.txt'),
                ]);
            } else if (pattern === '**/requirements/*.txt') {
                return Promise.resolve([]);
            } else if (pattern === '**/pyproject.toml') {
                return Promise.resolve([]);
            }
            return Promise.resolve([]);
        });

        // Act: Call getProjectInstallable
        const projects = [{ name: 'workspace', uri: Uri.file('/workspace') }];
        const result = await getProjectInstallable(mockApi, projects);

        // Assert: Should deduplicate and only have 2 unique files
        assert.strictEqual(result.length, 2, 'Should deduplicate and have 2 unique files');
        
        const names = result.map((r) => r.name).sort();
        assert.deepStrictEqual(
            names,
            ['dev-requirements.txt', 'requirements.txt'],
            'Should have deduplicated results',
        );
    });

    test('should find requirements files in subdirectories', async () => {
        // Arrange: Mock findFiles to return files in subdirectories
        findFilesStub.callsFake((pattern: string) => {
            if (pattern === '**/*requirements*.txt') {
                return Promise.resolve([
                    Uri.file('/workspace/subdir/dev-requirements.txt'),
                ]);
            } else if (pattern === '*requirements*.txt') {
                return Promise.resolve([
                    Uri.file('/workspace/requirements.txt'),
                ]);
            } else if (pattern === '**/requirements/*.txt') {
                return Promise.resolve([
                    Uri.file('/workspace/requirements/test.txt'),
                ]);
            } else if (pattern === '**/pyproject.toml') {
                return Promise.resolve([]);
            }
            return Promise.resolve([]);
        });

        // Act: Call getProjectInstallable
        const projects = [{ name: 'workspace', uri: Uri.file('/workspace') }];
        const result = await getProjectInstallable(mockApi, projects);

        // Assert: Should find all files
        assert.strictEqual(result.length, 3, 'Should find three files');
        
        const names = result.map((r) => r.name).sort();
        assert.deepStrictEqual(
            names,
            ['dev-requirements.txt', 'requirements.txt', 'test.txt'],
            'Should find files at different levels',
        );
    });

    test('should return empty array when no projects provided', async () => {
        // Act: Call with no projects
        const result = await getProjectInstallable(mockApi, undefined);

        // Assert: Should return empty array
        assert.strictEqual(result.length, 0, 'Should return empty array');
        assert.ok(!findFilesStub.called, 'Should not call findFiles when no projects');
    });

    test('should filter out files not in project directories', async () => {
        // Arrange: Mock findFiles to return files from multiple directories
        findFilesStub.callsFake((pattern: string) => {
            if (pattern === '*requirements*.txt') {
                return Promise.resolve([
                    Uri.file('/workspace/requirements.txt'),
                    Uri.file('/other-dir/requirements.txt'), // Should be filtered out
                ]);
            } else {
                return Promise.resolve([]);
            }
        });

        // Act: Call with only /workspace project
        const projects = [{ name: 'workspace', uri: Uri.file('/workspace') }];
        const result = await getProjectInstallable(mockApi, projects);

        // Assert: Should only include files from /workspace
        assert.strictEqual(result.length, 1, 'Should only include files from project directory');
        const firstResult = result[0];
        assert.ok(firstResult, 'Should have at least one result');
        assert.strictEqual(firstResult.name, 'requirements.txt');
        assert.ok(firstResult.uri, 'Should have a URI');
        assert.ok(firstResult.uri.fsPath.startsWith('/workspace'), 'Should be in workspace directory');
    });
});
