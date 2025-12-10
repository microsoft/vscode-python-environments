import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { CancellationToken, Progress, ProgressOptions, Uri } from 'vscode';
import { PythonEnvironmentApi, PythonProject } from '../../../api';
import * as winapi from '../../../common/window.apis';
import * as wapi from '../../../common/workspace.apis';
import { getProjectInstallable, hasProjectDependencies } from '../../../managers/builtin/pipUtils';

suite('Pip Utils - getProjectInstallable', () => {
    let findFilesStub: sinon.SinonStub;
    let withProgressStub: sinon.SinonStub;
    // Minimal mock that only implements the methods we need for this test
    // Using type assertion to satisfy TypeScript since we only need getPythonProject
    let mockApi: { getPythonProject: (uri: Uri) => PythonProject | undefined };

    setup(() => {
        findFilesStub = sinon.stub(wapi, 'findFiles');
        // Stub withProgress to immediately execute the callback
        withProgressStub = sinon.stub(winapi, 'withProgress');
        withProgressStub.callsFake(
            async (
                _options: ProgressOptions,
                callback: (
                    progress: Progress<{ message?: string; increment?: number }>,
                    token: CancellationToken,
                ) => Thenable<unknown>,
            ) => {
                return await callback(
                    {} as Progress<{ message?: string; increment?: number }>,
                    { isCancellationRequested: false } as CancellationToken,
                );
            },
        );

        const workspacePath = Uri.file('/test/path/root').fsPath;
        mockApi = {
            getPythonProject: (uri: Uri) => {
                // Return a project for any URI in workspace
                if (uri.fsPath.startsWith(workspacePath)) {
                    return { name: 'workspace', uri: Uri.file(workspacePath) };
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
                const workspacePath = Uri.file('/test/path/root').fsPath;
                return Promise.resolve([
                    Uri.file(path.join(workspacePath, 'requirements.txt')),
                    Uri.file(path.join(workspacePath, 'dev-requirements.txt')),
                    Uri.file(path.join(workspacePath, 'test-requirements.txt')),
                ]);
            } else if (pattern === '**/requirements/*.txt') {
                return Promise.resolve([]);
            } else if (pattern === '**/pyproject.toml') {
                return Promise.resolve([]);
            }
            return Promise.resolve([]);
        });

        // Act: Call getProjectInstallable
        const workspacePath = Uri.file('/test/path/root').fsPath;
        const projects = [{ name: 'workspace', uri: Uri.file(workspacePath) }];
        const result = await getProjectInstallable(mockApi as PythonEnvironmentApi, projects);

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
                const workspacePath = Uri.file('/test/path/root').fsPath;
                return Promise.resolve([Uri.file(path.join(workspacePath, 'dev-requirements.txt'))]);
            } else if (pattern === '*requirements*.txt') {
                const workspacePath = Uri.file('/test/path/root').fsPath;
                return Promise.resolve([
                    Uri.file(path.join(workspacePath, 'dev-requirements.txt')),
                    Uri.file(path.join(workspacePath, 'requirements.txt')),
                ]);
            } else if (pattern === '**/requirements/*.txt') {
                return Promise.resolve([]);
            } else if (pattern === '**/pyproject.toml') {
                return Promise.resolve([]);
            }
            return Promise.resolve([]);
        });

        // Act: Call getProjectInstallable
        const workspacePath = Uri.file('/test/path/root').fsPath;
        const projects = [{ name: 'workspace', uri: Uri.file(workspacePath) }];
        const result = await getProjectInstallable(mockApi as PythonEnvironmentApi, projects);

        // Assert: Should deduplicate and only have 2 unique files
        assert.strictEqual(result.length, 2, 'Should deduplicate and have 2 unique files');

        const names = result.map((r) => r.name).sort();
        assert.deepStrictEqual(names, ['dev-requirements.txt', 'requirements.txt'], 'Should have deduplicated results');
    });

    test('should find requirements files in subdirectories', async () => {
        // Arrange: Mock findFiles to return files in subdirectories
        findFilesStub.callsFake((pattern: string) => {
            if (pattern === '**/*requirements*.txt') {
                const workspacePath = Uri.file('/test/path/root').fsPath;
                return Promise.resolve([Uri.file(path.join(workspacePath, 'subdir', 'dev-requirements.txt'))]);
            } else if (pattern === '*requirements*.txt') {
                const workspacePath = Uri.file('/test/path/root').fsPath;
                return Promise.resolve([Uri.file(path.join(workspacePath, 'requirements.txt'))]);
            } else if (pattern === '**/requirements/*.txt') {
                const workspacePath = Uri.file('/test/path/root').fsPath;
                return Promise.resolve([Uri.file(path.join(workspacePath, 'requirements', 'test.txt'))]);
            } else if (pattern === '**/pyproject.toml') {
                return Promise.resolve([]);
            }
            return Promise.resolve([]);
        });

        // Act: Call getProjectInstallable
        const workspacePath = Uri.file('/test/path/root').fsPath;
        const projects = [{ name: 'workspace', uri: Uri.file(workspacePath) }];
        const result = await getProjectInstallable(mockApi as PythonEnvironmentApi, projects);

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
        const result = await getProjectInstallable(mockApi as PythonEnvironmentApi, undefined);

        // Assert: Should return empty array
        assert.strictEqual(result.length, 0, 'Should return empty array');
        assert.ok(!findFilesStub.called, 'Should not call findFiles when no projects');
    });

    test('should filter out files not in project directories', async () => {
        // Arrange: Mock findFiles to return files from multiple directories
        findFilesStub.callsFake((pattern: string) => {
            if (pattern === '*requirements*.txt') {
                const workspacePath = Uri.file('/test/path/root').fsPath;
                const otherPath = Uri.file('/other-dir').fsPath;
                return Promise.resolve([
                    Uri.file(path.join(workspacePath, 'requirements.txt')),
                    Uri.file(path.join(otherPath, 'requirements.txt')), // Should be filtered out
                ]);
            } else {
                return Promise.resolve([]);
            }
        });

        // Act: Call with only workspace project
        const workspacePath = Uri.file('/test/path/root').fsPath;
        const projects = [{ name: 'workspace', uri: Uri.file(workspacePath) }];
        const result = await getProjectInstallable(mockApi as PythonEnvironmentApi, projects);

        // Assert: Should only include files from workspace
        assert.strictEqual(result.length, 1, 'Should only include files from project directory');
        const firstResult = result[0];
        assert.ok(firstResult, 'Should have at least one result');
        assert.strictEqual(firstResult.name, 'requirements.txt');
        assert.ok(firstResult.uri, 'Should have a URI');
        assert.ok(firstResult.uri.fsPath.startsWith(workspacePath), 'Should be in workspace directory');
    });

    test('should show cancellable progress notification', async () => {
        // Arrange: Mock findFiles to return empty results
        findFilesStub.resolves([]);

        // Act: Call getProjectInstallable
        const workspacePath = Uri.file('/test/path/root').fsPath;
        const projects = [{ name: 'workspace', uri: Uri.file(workspacePath) }];
        await getProjectInstallable(mockApi as PythonEnvironmentApi, projects);

        // Assert: Verify withProgress was called with cancellable option
        assert.ok(withProgressStub.calledOnce, 'Should call withProgress once');
        const progressOptions = withProgressStub.firstCall.args[0] as ProgressOptions;
        assert.strictEqual(progressOptions.cancellable, true, 'Progress should be cancellable');
    });

    test('should handle cancellation during file search', async () => {
        // ARRANGE: Simulate a scenario where the user cancels the operation
        // Step 1: Create a pre-cancelled token to simulate user clicking "Cancel" button
        const cancelledToken: CancellationToken = {
            isCancellationRequested: true,
            onCancellationRequested: () => ({ dispose: () => {} }),
        };

        // Step 2: Override withProgress stub to pass the cancelled token to the search callback
        // This simulates the progress dialog being cancelled and the token being propagated
        withProgressStub.callsFake(
            async (
                _options: ProgressOptions,
                callback: (
                    progress: Progress<{ message?: string; increment?: number }>,
                    token: CancellationToken,
                ) => Thenable<unknown>,
            ) => {
                // Execute the callback with the cancelled token (simulating cancellation during the operation)
                return await callback({} as Progress<{ message?: string; increment?: number }>, cancelledToken);
            },
        );

        // Step 3: Mock findFiles to verify the cancelled token is properly passed through
        // This ensures cancellation propagates from withProgress -> getProjectInstallable -> findFiles
        findFilesStub.callsFake((_pattern: string, _exclude: string, _maxResults: number, token: CancellationToken) => {
            // VERIFY: The same cancellation token should be passed to each findFiles call
            assert.strictEqual(token, cancelledToken, 'Cancellation token should be passed to findFiles');
            return Promise.resolve([]);
        });

        // ACT: Call the function under test
        const workspacePath = Uri.file('/test/path/root').fsPath;
        const projects = [{ name: 'workspace', uri: Uri.file(workspacePath) }];
        await getProjectInstallable(mockApi as PythonEnvironmentApi, projects);

        // ASSERT: Verify the cancellation token was passed to all file search operations
        // Even though cancelled, the function should attempt all searches (they'll just return empty quickly)
        assert.ok(findFilesStub.called, 'findFiles should be called');
        // getProjectInstallable searches for dependencies using 4 different file patterns
        assert.strictEqual(findFilesStub.callCount, 4, 'Should call findFiles 4 times for different patterns');
    });
});

suite('Pip Utils - hasProjectDependencies', () => {
    let findFilesStub: sinon.SinonStub;

    setup(() => {
        findFilesStub = sinon.stub(wapi, 'findFiles');
    });

    teardown(() => {
        sinon.restore();
    });

    test('should return true when requirements.txt exists', async () => {
        // Arrange: Mock findFiles to return a requirements file
        findFilesStub.callsFake((pattern: string, _exclude: string, maxResults?: number) => {
            // Verify maxResults=1 is used for performance (quick check)
            assert.strictEqual(maxResults, 1, 'Should use maxResults=1 for quick check');

            if (pattern === '*requirements*.txt') {
                return Promise.resolve([Uri.file('/test/path/root/requirements.txt')]);
            }
            return Promise.resolve([]);
        });

        // Act
        const projects = [{ name: 'workspace', uri: Uri.file('/test/path/root') }];
        const result = await hasProjectDependencies(projects);

        // Assert
        assert.strictEqual(result, true, 'Should return true when requirements files exist');
    });

    test('should return true when pyproject.toml exists', async () => {
        // Arrange: Mock findFiles to return pyproject.toml
        findFilesStub.callsFake((pattern: string, _exclude: string, maxResults?: number) => {
            assert.strictEqual(maxResults, 1, 'Should use maxResults=1 for quick check');

            if (pattern === '**/pyproject.toml') {
                return Promise.resolve([Uri.file('/test/path/root/pyproject.toml')]);
            }
            return Promise.resolve([]);
        });

        // Act
        const projects = [{ name: 'workspace', uri: Uri.file('/test/path/root') }];
        const result = await hasProjectDependencies(projects);

        // Assert
        assert.strictEqual(result, true, 'Should return true when pyproject.toml exists');
    });

    test('should return false when no dependency files exist', async () => {
        // Arrange: Mock findFiles to return empty arrays
        findFilesStub.resolves([]);

        // Act
        const projects = [{ name: 'workspace', uri: Uri.file('/test/path/root') }];
        const result = await hasProjectDependencies(projects);

        // Assert
        assert.strictEqual(result, false, 'Should return false when no dependency files exist');
        // Verify all 4 patterns were checked
        assert.strictEqual(findFilesStub.callCount, 4, 'Should check all 4 file patterns');
    });

    test('should return false when no projects provided', async () => {
        // Act
        const result = await hasProjectDependencies(undefined);

        // Assert
        assert.strictEqual(result, false, 'Should return false when no projects provided');
        assert.ok(!findFilesStub.called, 'Should not call findFiles when no projects');
    });

    test('should return false when empty projects array provided', async () => {
        // Act
        const result = await hasProjectDependencies([]);

        // Assert
        assert.strictEqual(result, false, 'Should return false when empty projects array');
        assert.ok(!findFilesStub.called, 'Should not call findFiles when projects array is empty');
    });

    test('should use maxResults=1 for all patterns for performance', async () => {
        // Arrange: Track all maxResults values
        const maxResultsUsed: (number | undefined)[] = [];
        findFilesStub.callsFake((_pattern: string, _exclude: string, maxResults?: number) => {
            maxResultsUsed.push(maxResults);
            return Promise.resolve([]);
        });

        // Act
        const projects = [{ name: 'workspace', uri: Uri.file('/test/path/root') }];
        await hasProjectDependencies(projects);

        // Assert: All calls should use maxResults=1 for performance
        assert.strictEqual(maxResultsUsed.length, 4, 'Should make 4 findFiles calls');
        maxResultsUsed.forEach((value, index) => {
            assert.strictEqual(value, 1, `Call ${index + 1} should use maxResults=1`);
        });
    });

    test('should short-circuit when first pattern finds a file', async () => {
        // Arrange: First pattern returns a result
        findFilesStub.callsFake((pattern: string) => {
            if (pattern === '**/*requirements*.txt') {
                return Promise.resolve([Uri.file('/test/path/root/dev-requirements.txt')]);
            }
            return Promise.resolve([]);
        });

        // Act
        const projects = [{ name: 'workspace', uri: Uri.file('/test/path/root') }];
        const result = await hasProjectDependencies(projects);

        // Assert: Should still return true even though only first pattern matched
        assert.strictEqual(result, true, 'Should return true when any pattern finds files');
        // Note: All 4 patterns are checked in parallel with Promise.all, so all 4 calls happen
        assert.strictEqual(findFilesStub.callCount, 4, 'All patterns checked in parallel');
    });
});
