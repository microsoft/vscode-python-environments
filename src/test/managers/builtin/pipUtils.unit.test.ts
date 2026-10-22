import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { CancellationError, CancellationToken, CancellationTokenSource, LogOutputChannel, Progress, ProgressLocation, ProgressOptions, Uri } from 'vscode';
import * as fse from 'fs-extra';
import * as os from 'os';
import { PythonEnvironment, PythonEnvironmentApi, PythonProject } from '../../../api';
import { PackageManagement } from '../../../common/localize';
import * as winapi from '../../../common/window.apis';
import * as wapi from '../../../common/workspace.apis';
import { PipListCommand } from '../../../managers/builtin/commands/list';
import * as helpers from '../../../managers/builtin/helpers';
import { getProjectInstallable, getWorkspacePackagesToInstall } from '../../../managers/builtin/pipUtils';

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
                    {
                        isCancellationRequested: false,
                        onCancellationRequested: () => ({ dispose: () => {} }),
                    } as CancellationToken,
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

    suite('Pip Utils - getWorkspacePackagesToInstall', () => {
        teardown(() => {
            sinon.restore();
        });

        test('marks dependency progress cancellable and rejects a pre-cancelled interactive search', async () => {
            const source = new CancellationTokenSource();
            source.cancel();
            withProgressStub.callsFake(async (options: ProgressOptions, task) => {
                assert.strictEqual(options.cancellable, true);
                return task({ report: () => {} }, source.token);
            });
            const projects = [{ name: 'workspace', uri: Uri.file(process.cwd()) }];
            try {
                await assert.rejects(
                    getProjectInstallable(mockApi as PythonEnvironmentApi, projects),
                    CancellationError,
                );
                assert.ok(findFilesStub.notCalled);
            } finally {
                source.dispose();
            }
        });

        test('propagates the progress token and promptly rejects cancellation during file search', async () => {
            const source = new CancellationTokenSource();
            let startedCount = 0;
            let markSearchesStarted!: () => void;
            const searchesStarted = new Promise<void>((resolve) => {
                markSearchesStarted = resolve;
            });
            findFilesStub.callsFake(
                (_pattern: string, _exclude: string, _maxResults: number | undefined, token: CancellationToken) => {
                    assert.strictEqual(token, source.token);
                    startedCount += 1;
                    if (startedCount === 4) {
                        markSearchesStarted();
                    }
                    if (startedCount === 1) {
                        return new Promise<Uri[]>(() => {});
                    }
                    return new Promise<Uri[]>((resolve) => {
                        token.onCancellationRequested(() => resolve([]));
                    });
                },
            );
            withProgressStub.callsFake(async (options: ProgressOptions, task) => {
                assert.strictEqual(options.cancellable, true);
                const pending = task({ report: () => {} }, source.token);
                await searchesStarted;
                source.cancel();
                return pending;
            });

            let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    assert.rejects(
                        getProjectInstallable(mockApi as PythonEnvironmentApi, [
                            { name: 'workspace', uri: Uri.file(process.cwd()) },
                        ]),
                        CancellationError,
                    ),
                    new Promise<void>((_resolve, reject) => {
                        timeoutHandle = setTimeout(
                            () => reject(new Error('Dependency search did not cancel promptly')),
                            1_000,
                        );
                    }),
                ]);
                assert.strictEqual(findFilesStub.callCount, 4);
            } finally {
                clearTimeout(timeoutHandle);
                source.dispose();
            }
        });

        test('rejects cancellation after file searches resolve without processing partial results', async () => {
            const source = new CancellationTokenSource();
            const resolutions: Array<(uris: Uri[]) => void> = [];
            const partialResult = Uri.file(path.join(process.cwd(), 'requirements.txt'));
            const getPythonProject = sinon.stub().throws(new Error('Unexpected post-search processing'));
            mockApi.getPythonProject = getPythonProject;
            findFilesStub.callsFake(
                (_pattern: string, _exclude: string, _maxResults: number | undefined, token: CancellationToken) => {
                    assert.strictEqual(token, source.token);
                    return new Promise<Uri[]>((resolve) => resolutions.push(resolve));
                },
            );
            withProgressStub.callsFake(async (_options: ProgressOptions, task) => {
                const pending = task({ report: () => {} }, source.token);
                assert.strictEqual(resolutions.length, 4);
                resolutions.forEach((resolve, index) => resolve(index === 0 ? [partialResult] : []));
                source.cancel();
                return pending;
            });

            try {
                await assert.rejects(
                    getProjectInstallable(mockApi as PythonEnvironmentApi, [
                        { name: 'workspace', uri: Uri.file(process.cwd()) },
                    ]),
                    CancellationError,
                );
                assert.ok(getPythonProject.notCalled);
            } finally {
                source.dispose();
            }
        });

        test('observes a queued Cancel click before post-search processing succeeds', async () => {
            const source = new CancellationTokenSource();
            const partialResult = Uri.file(path.join(process.cwd(), 'requirements.txt'));
            const getPythonProject = sinon.stub().throws(new Error('Unexpected post-search processing'));
            mockApi.getPythonProject = getPythonProject;
            findFilesStub.callsFake((pattern: string) =>
                Promise.resolve(pattern === '**/*requirements*.txt' ? [partialResult] : []),
            );
            withProgressStub.callsFake(async (_options: ProgressOptions, task) => {
                const pending = task({ report: () => {} }, source.token);
                setImmediate(() => source.cancel());
                return pending;
            });

            try {
                await assert.rejects(
                    getProjectInstallable(mockApi as PythonEnvironmentApi, [
                        { name: 'workspace', uri: Uri.file(process.cwd()) },
                    ]),
                    CancellationError,
                );
                assert.ok(getPythonProject.notCalled);
            } finally {
                source.dispose();
            }
        });

        test('rejects cancellation during a TOML read before strict parsing or validation', async () => {
            const temp = await fse.mkdtemp(path.join(os.tmpdir(), 'piputils-cancel-'));
            const project = { name: 'workspace', uri: Uri.file(temp) };
            const pyproject = Uri.file(path.join(temp, 'pyproject.toml'));
            await fse.outputFile(pyproject.fsPath, '[invalid TOML');
            mockApi.getPythonProject = () => project;
            findFilesStub.callsFake((pattern: string) =>
                Promise.resolve(pattern === '**/pyproject.toml' ? [pyproject] : []),
            );

            let cancelled = false;
            let subscriptionCount = 0;
            let markPostReadCheck!: () => void;
            const postReadCheck = new Promise<void>((resolve) => {
                markPostReadCheck = resolve;
            });
            const token = {
                get isCancellationRequested() {
                    if (cancelled) {
                        markPostReadCheck();
                    }
                    return cancelled;
                },
                onCancellationRequested: (listener: () => unknown) => {
                    subscriptionCount += 1;
                    if (subscriptionCount === 2) {
                        queueMicrotask(() => {
                            cancelled = true;
                            listener();
                        });
                    }
                    return { dispose: () => {} };
                },
            } as unknown as CancellationToken;

            try {
                await assert.rejects(
                    getProjectInstallable(mockApi as PythonEnvironmentApi, [project], {
                        runHeadless: true,
                        token,
                    }),
                    CancellationError,
                );
                await postReadCheck;
                assert.strictEqual(subscriptionCount, 2);
                assert.ok(withProgressStub.notCalled);
            } finally {
                await fse.remove(temp);
            }
        });

        test('headless search preserves the caller token and CancellationError semantics', async () => {
            const source = new CancellationTokenSource();
            source.cancel();
            try {
                await assert.rejects(
                    getProjectInstallable(
                        mockApi as PythonEnvironmentApi,
                        [{ name: 'workspace', uri: Uri.file(process.cwd()) }],
                        { runHeadless: true, token: source.token },
                    ),
                    CancellationError,
                );
                assert.ok(withProgressStub.notCalled);
                assert.ok(findFilesStub.notCalled);
            } finally {
                source.dispose();
            }
        });

        test('headless search propagates in-flight cancellation and passes the caller token unchanged', async () => {
            const source = new CancellationTokenSource();
            let startedCount = 0;
            let markSearchesStarted!: () => void;
            const searchesStarted = new Promise<void>((resolve) => {
                markSearchesStarted = resolve;
            });
            findFilesStub.callsFake(
                (_pattern: string, _exclude: string, _maxResults: number | undefined, token: CancellationToken) => {
                    assert.strictEqual(token, source.token);
                    startedCount += 1;
                    if (startedCount === 4) {
                        markSearchesStarted();
                    }
                    return new Promise<Uri[]>((resolve) => {
                        token.onCancellationRequested(() => resolve([]));
                    });
                },
            );

            try {
                const pending = getProjectInstallable(
                    mockApi as PythonEnvironmentApi,
                    [{ name: 'workspace', uri: Uri.file(process.cwd()) }],
                    { runHeadless: true, token: source.token },
                );
                await searchesStarted;
                source.cancel();
                await assert.rejects(pending, CancellationError);
                assert.strictEqual(findFilesStub.callCount, 4);
                assert.ok(withProgressStub.notCalled);
            } finally {
                source.dispose();
            }
        });

        test('returns an empty result after a successful dependency search with no matches', async () => {
            findFilesStub.resolves([]);
            const workspacePath = Uri.file('/test/path/root').fsPath;

            const result = await getProjectInstallable(mockApi as PythonEnvironmentApi, [
                { name: 'workspace', uri: Uri.file(workspacePath) },
            ]);

            assert.deepStrictEqual(result.installables, []);
            assert.deepStrictEqual(result.validationErrors, []);
            assert.strictEqual(findFilesStub.callCount, 4);
            assert.ok(withProgressStub.calledOnce);
        });

        test('opens the package picker when listing installed packages fails', async () => {
            const listError = new Error('pip list failed');
            const logError = sinon.stub();
            const log = { error: logError } as unknown as LogOutputChannel;
            const environment = {
                environmentPath: Uri.file('.'),
                execInfo: { run: { executable: 'python' } },
            } as PythonEnvironment;
            const workspacePath = Uri.file('/test/path/root').fsPath;
            findFilesStub.callsFake((pattern: string) =>
                Promise.resolve(
                    pattern === '*requirements*.txt'
                        ? [Uri.file(path.join(workspacePath, 'requirements.txt'))]
                        : [],
                ),
            );

            sinon.stub(helpers, 'shouldUseUv').resolves(false);
            sinon.stub(PipListCommand.prototype, 'execute').rejects(listError);
            const showQuickPick = sinon.stub(winapi, 'showQuickPickWithButtons').resolves(undefined);

            const result = await getWorkspacePackagesToInstall(
                mockApi as PythonEnvironmentApi,
                { install: [], showSkipOption: true },
                [{ name: 'workspace', uri: Uri.file(workspacePath) }],
                environment,
                log,
            );

            assert.strictEqual(result, undefined);
            assert.ok(logError.calledOnceWithExactly('Error listing installed packages', listError));
            assert.ok(showQuickPick.calledOnce, 'The package picker should still open after a list failure');
        });

        test('does not block configurable creation when malformed pyproject.toml is unselected', async () => {
            const tempRoot = await fse.mkdtemp(path.join(os.tmpdir(), 'piputils-selection-'));
            try {
                const invalidToml = path.join(tempRoot, 'pyproject.toml');
                const requirements = path.join(tempRoot, 'requirements.txt');
                await fse.writeFile(invalidToml, '[project]\nname = "unterminated\n');
                await fse.writeFile(requirements, 'requests\n');
                mockApi.getPythonProject = () => ({ name: 'workspace', uri: Uri.file(tempRoot) });
                findFilesStub.callsFake((pattern: string) => {
                    if (pattern === '**/pyproject.toml') {
                        return Promise.resolve([Uri.file(invalidToml)]);
                    }
                    if (pattern === '*requirements*.txt') {
                        return Promise.resolve([Uri.file(requirements)]);
                    }
                    return Promise.resolve([]);
                });
                const picker = sinon.stub(winapi, 'showQuickPickWithButtons');
                picker.onFirstCall().callsFake(async (items) =>
                    items.find((item) => item.label === PackageManagement.workspaceDependencies),
                );
                picker.onSecondCall().callsFake(async (items) => {
                    const requirement = items.find((item) => (item as { args?: string[] }).args?.[0] === '-r');
                    assert.ok(requirement);
                    return [requirement];
                });
                const showError = sinon.stub(winapi, 'showErrorMessage').throws(new Error('Unexpected validation'));

                const result = await getWorkspacePackagesToInstall(
                    mockApi as PythonEnvironmentApi,
                    { install: [], showSkipOption: true },
                    [{ name: 'workspace', uri: Uri.file(tempRoot) }],
                );

                assert.deepStrictEqual(result, { install: ['-r', Uri.file(requirements).fsPath], uninstall: [] });
                assert.ok(showError.notCalled);
            } finally {
                await fse.remove(tempRoot);
            }
        });

        test('prompts when configurable creation selects an invalid-file-only workspace dependency', async () => {
            const tempRoot = await fse.mkdtemp(path.join(os.tmpdir(), 'piputils-selection-'));
            try {
                const invalidToml = path.join(tempRoot, 'pyproject.toml');
                await fse.writeFile(invalidToml, '[project]\nname = "unterminated\n');
                mockApi.getPythonProject = () => ({ name: 'workspace', uri: Uri.file(tempRoot) });
                findFilesStub.callsFake((pattern: string) =>
                    pattern === '**/pyproject.toml'
                        ? Promise.resolve([Uri.file(invalidToml)])
                        : Promise.resolve([]),
                );
                sinon.stub(winapi, 'showQuickPickWithButtons').callsFake(async (items) =>
                    items.find((item) => item.label === PackageManagement.workspaceDependencies),
                );
                const showError = sinon.stub(winapi, 'showErrorMessage');
                showError.callsFake(async (...args: unknown[]) => args[3] as never);

                const result = await getWorkspacePackagesToInstall(
                    mockApi as PythonEnvironmentApi,
                    { install: [], showSkipOption: true },
                    [{ name: 'workspace', uri: Uri.file(tempRoot) }],
                );

                assert.strictEqual(result, undefined);
                assert.ok(showError.calledOnce);
            } finally {
                await fse.remove(tempRoot);
            }
        });

        test('shows progress while listing installed packages', async () => {
            const environment = {
                environmentPath: Uri.file('.'),
                execInfo: { run: { executable: 'python' } },
            } as PythonEnvironment;
            const workspacePath = Uri.file('/test/path/root').fsPath;
            findFilesStub.callsFake((pattern: string) =>
                Promise.resolve(
                    pattern === '*requirements*.txt'
                        ? [Uri.file(path.join(workspacePath, 'requirements.txt'))]
                        : [],
                ),
            );
            sinon.stub(helpers, 'shouldUseUv').resolves(false);
            sinon.stub(PipListCommand.prototype, 'execute').resolves([]);
            const showQuickPick = sinon.stub(winapi, 'showQuickPickWithButtons').resolves(undefined);

            await getWorkspacePackagesToInstall(
                mockApi as PythonEnvironmentApi,
                { install: [] },
                [{ name: 'workspace', uri: Uri.file(workspacePath) }],
                environment,
            );

            assert.strictEqual(withProgressStub.callCount, 2);
            assert.strictEqual(withProgressStub.secondCall.args[0].location, ProgressLocation.Notification);
            assert.ok(withProgressStub.secondCall.calledBefore(showQuickPick.firstCall));
        });
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
        const result = (await getProjectInstallable(mockApi as PythonEnvironmentApi, projects)).installables;

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
        const result = (await getProjectInstallable(mockApi as PythonEnvironmentApi, projects)).installables;

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
        const result = (await getProjectInstallable(mockApi as PythonEnvironmentApi, projects)).installables;

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
        const result = (await getProjectInstallable(mockApi as PythonEnvironmentApi, undefined)).installables;

        // Assert: Should return empty array
        assert.strictEqual(result.length, 0, 'Should return empty array');
        assert.ok(!findFilesStub.called, 'Should not call findFiles when no projects');
    });

    test('private nested creation excludes parent and sibling dependencies before parsing or validating them', async () => {
        const temp = await fse.mkdtemp(path.join(os.tmpdir(), 'private-dependency-scope-'));
        const source = new CancellationTokenSource();
        try {
            const project = { name: 'root', uri: Uri.file(temp) };
            const nested = Uri.file(path.join(temp, 'new service'));
            const ownRequirement = Uri.file(path.join(nested.fsPath, 'requirements.txt'));
            const rootRequirement = Uri.file(path.join(temp, 'requirements.txt'));
            const siblingRequirement = Uri.file(path.join(temp, 'sibling', 'requirements.txt'));
            const siblingToml = Uri.file(path.join(temp, 'sibling', 'pyproject.toml'));
            const invalidSiblingSyntax = Uri.file(path.join(temp, 'sibling-two', 'pyproject.toml'));
            await fse.outputFile(siblingToml.fsPath, '[project]\nname = "sibling"\n[build-system]\nbuild-backend = "missing"\n');
            await fse.outputFile(invalidSiblingSyntax.fsPath, '[invalid syntax');
            mockApi.getPythonProject = () => project;
            findFilesStub.resolves([rootRequirement, ownRequirement, siblingRequirement, siblingToml, invalidSiblingSyntax]);
            const result = await getProjectInstallable(mockApi as PythonEnvironmentApi, [project], {
                runHeadless: true,
                token: source.token,
                preferredRoot: nested,
                deduplicateProjectPackages: true,
            });
            assert.deepStrictEqual(result.installables.map((item) => item.uri?.fsPath), [ownRequirement.fsPath]);
            assert.strictEqual(result.validationErrors[0], undefined);
            assert.ok(withProgressStub.notCalled);
        } finally {
            source.dispose();
            await fse.remove(temp);
        }
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
        const result = (await getProjectInstallable(mockApi as PythonEnvironmentApi, projects)).installables;

        // Assert: Should only include files from workspace
        assert.strictEqual(result.length, 1, 'Should only include files from project directory');
        const firstResult = result[0];
        assert.ok(firstResult, 'Should have at least one result');
        assert.strictEqual(firstResult.name, 'requirements.txt');
        assert.ok(firstResult.uri, 'Should have a URI');
        assert.ok(firstResult.uri.fsPath.startsWith(workspacePath), 'Should be in workspace directory');
    });

    test('should sort shallower files before deeper ones', async () => {
        // Arrange: Use the shared workspacePath from setup() so paths are platform-safe.
        const workspacePath = Uri.file('/test/path/root').fsPath;
        const rootReqPath = path.join(workspacePath, 'requirements.txt');
        const subdirReqPath = path.join(workspacePath, 'subdir', 'dev-requirements.txt');
        const deepReqPath = path.join(workspacePath, 'deep', 'nested', 'sub', 'requirements.txt');

        // Return files at different depths, with deeper ones discovered first.
        findFilesStub.callsFake((pattern: string) => {
            if (pattern === '**/*requirements*.txt') {
                return Promise.resolve([Uri.file(deepReqPath), Uri.file(subdirReqPath)]);
            } else if (pattern === '*requirements*.txt') {
                return Promise.resolve([Uri.file(rootReqPath)]);
            } else if (pattern === '**/requirements/*.txt') {
                return Promise.resolve([]);
            } else if (pattern === '**/pyproject.toml') {
                return Promise.resolve([]);
            }
            return Promise.resolve([]);
        });

        // Act
        const projects = [{ name: 'workspace', uri: Uri.file(workspacePath) }];
        const result = (await getProjectInstallable(mockApi as PythonEnvironmentApi, projects)).installables;

        // Assert: order by fsPath so the two `requirements.txt` files are unambiguous.
        assert.strictEqual(result.length, 3);
        const fsPaths = result.map((r) => r.uri!.fsPath);
        assert.deepStrictEqual(
            fsPaths,
            [rootReqPath, subdirReqPath, deepReqPath],
            'Files should be ordered by depth relative to the project root',
        );
    });
});

suite('Pip Utils - getProjectInstallable duplicate pyproject.toml handling', () => {
    let findFilesStub: sinon.SinonStub;
    let withProgressStub: sinon.SinonStub;
    let mockApi: { getPythonProject: (uri: Uri) => PythonProject | undefined };

    let tmpRoot: string;
    let projectRoot: string;

    // Builds a valid, pip-installable pyproject.toml with the given package name.
    function tomlFor(name: string, version = '0.1.0'): string {
        return [
            '[project]',
            `name = "${name}"`,
            `version = "${version}"`,
            '',
            '[build-system]',
            'requires = ["setuptools"]',
            'build-backend = "setuptools.build_meta"',
            '',
        ].join('\n');
    }

    // Writes a pyproject.toml under <projectRoot>/<relDir> and returns its path.
    async function writeToml(relDir: string, name: string): Promise<string> {
        return writeTomlContent(relDir, tomlFor(name));
    }

    async function writeTomlContent(relDir: string, content: string): Promise<string> {
        const dir = path.join(projectRoot, relDir);
        await fse.mkdirp(dir);
        const file = path.join(dir, 'pyproject.toml');
        await fse.writeFile(file, content);
        return file;
    }

    function automaticOptions(preferredRoot: string = projectRoot) {
        return {
            deduplicateProjectPackages: true,
            preferredRoot: Uri.file(preferredRoot),
        };
    }

    setup(async () => {
        findFilesStub = sinon.stub(wapi, 'findFiles').resolves([]);
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
                    {
                        isCancellationRequested: false,
                        onCancellationRequested: () => ({ dispose: () => {} }),
                    } as CancellationToken,
                );
            },
        );

        // Use real temp files because fs-extra's readFile cannot be stubbed
        // (non-configurable), and getProjectInstallable parses the toml contents.
        tmpRoot = await fse.mkdtemp(path.join(os.tmpdir(), 'piputils-'));
        // Normalize through Uri.file so drive-letter casing matches the paths that
        // getProjectInstallable derives from the discovered Uris on Windows.
        projectRoot = Uri.file(path.join(tmpRoot, 'myapp')).fsPath;
        await fse.mkdirp(projectRoot);

        mockApi = {
            getPythonProject: (uri: Uri) => {
                // Every file under the project root belongs to the same project.
                if (uri.fsPath.startsWith(projectRoot)) {
                    return { name: 'myapp', uri: Uri.file(projectRoot) };
                }
                return undefined;
            },
        };
    });

    teardown(async () => {
        sinon.restore();
        if (tmpRoot) {
            await fse.remove(tmpRoot);
        }
    });

    test('reports invalid TOML syntax instead of treating the file as empty', async () => {
        const invalidToml = await writeTomlContent('', '[project]\nname = \"unterminated\n');
        findFilesStub.callsFake((pattern: string) =>
            pattern === '**/pyproject.toml' ? Promise.resolve([Uri.file(invalidToml)]) : Promise.resolve([]),
        );

        const result = await getProjectInstallable(
            mockApi as PythonEnvironmentApi,
            [{ name: 'myapp', uri: Uri.file(projectRoot) }],
            automaticOptions(projectRoot),
        );

        assert.strictEqual(result.installables.length, 0);
        assert.strictEqual(result.validationErrors[0]?.fileUri.fsPath, invalidToml);
    });

    test('reports unreadable TOML instead of treating the file as empty', async () => {
        const missingToml = path.join(projectRoot, 'missing', 'pyproject.toml');
        findFilesStub.callsFake((pattern: string) =>
            pattern === '**/pyproject.toml' ? Promise.resolve([Uri.file(missingToml)]) : Promise.resolve([]),
        );

        const result = await getProjectInstallable(
            mockApi as PythonEnvironmentApi,
            [{ name: 'myapp', uri: Uri.file(projectRoot) }],
        );

        assert.strictEqual(result.installables.length, 0);
        assert.strictEqual(result.validationErrors[0]?.fileUri.fsPath, Uri.file(missingToml).fsPath);
        assert.match(result.validationErrors[0]?.message ?? '', /read or parse/i);
    });

    test('reports malformed dependency values while retaining the editable install for Continue Anyway', async () => {
        const invalidToml = await writeTomlContent(
            '',
            [
                '[project]',
                'name = "myapp"',
                'dependencies = "requests"',
                '',
                '[build-system]',
                'requires = ["setuptools"]',
                'build-backend = "setuptools.build_meta"',
                '',
            ].join('\n'),
        );
        findFilesStub.callsFake((pattern: string) =>
            pattern === '**/pyproject.toml' ? Promise.resolve([Uri.file(invalidToml)]) : Promise.resolve([]),
        );

        const result = await getProjectInstallable(
            mockApi as PythonEnvironmentApi,
            [{ name: 'myapp', uri: Uri.file(projectRoot) }],
        );

        assert.deepStrictEqual(result.installables[0]?.args, ['-e', projectRoot]);
        assert.match(result.validationErrors[0]?.message ?? '', /dependencies.*array of strings/i);
    });

    test('rejects datetime values where a dependency table is required', async () => {
        const invalidToml = await writeTomlContent(
            '',
            [
                '[project]',
                'name = "myapp"',
                'optional-dependencies = 1979-05-27T07:32:00Z',
                '',
                '[build-system]',
                'requires = ["setuptools"]',
                'build-backend = "setuptools.build_meta"',
                '',
            ].join('\n'),
        );
        findFilesStub.callsFake((pattern: string) =>
            pattern === '**/pyproject.toml' ? Promise.resolve([Uri.file(invalidToml)]) : Promise.resolve([]),
        );

        const result = await getProjectInstallable(
            mockApi as PythonEnvironmentApi,
            [{ name: 'myapp', uri: Uri.file(projectRoot) }],
        );

        assert.deepStrictEqual(result.installables[0]?.args, ['-e', projectRoot]);
        assert.match(result.validationErrors[0]?.message ?? '', /optional-dependencies.*table/i);
    });

    test('reports invalid optional dependency group names before installation', async () => {
        const invalidToml = await writeTomlContent(
            '',
            [
                '[project]',
                'name = "myapp"',
                '',
                '[project.optional-dependencies]',
                '"bad extra" = ["pytest"]',
                '',
            ].join('\n'),
        );
        findFilesStub.callsFake((pattern: string) =>
            pattern === '**/pyproject.toml' ? Promise.resolve([Uri.file(invalidToml)]) : Promise.resolve([]),
        );

        const result = await getProjectInstallable(
            mockApi as PythonEnvironmentApi,
            [{ name: 'myapp', uri: Uri.file(projectRoot) }],
        );

        assert.deepStrictEqual(result.installables[0]?.args, ['-e', `${projectRoot}[bad extra]`]);
        assert.match(result.validationErrors[0]?.message ?? '', /invalid optional dependency group name/i);
    });

    test('returns a valid TOML installable without validation errors', async () => {
        const validToml = await writeToml('', 'myapp');
        findFilesStub.callsFake((pattern: string) =>
            pattern === '**/pyproject.toml' ? Promise.resolve([Uri.file(validToml)]) : Promise.resolve([]),
        );

        const result = await getProjectInstallable(
            mockApi as PythonEnvironmentApi,
            [{ name: 'myapp', uri: Uri.file(projectRoot) }],
        );

        assert.deepStrictEqual(result.installables[0]?.args, ['-e', projectRoot]);
        assert.deepStrictEqual(result.validationErrors, []);
    });

    test('ignores malformed pyproject.toml from a sibling worktree outside the creation root', async () => {
        const owningToml = await writeToml('main', 'myapp');
        const siblingToml = await writeTomlContent('copilot', '[project]\nname = "unterminated\n');
        findFilesStub.callsFake((pattern: string) =>
            pattern === '**/pyproject.toml'
                ? Promise.resolve([Uri.file(siblingToml), Uri.file(owningToml)])
                : Promise.resolve([]),
        );

        const result = await getProjectInstallable(
            mockApi as PythonEnvironmentApi,
            [{ name: 'myapp', uri: Uri.file(projectRoot) }],
            automaticOptions(path.join(projectRoot, 'main')),
        );

        assert.deepStrictEqual(result.installables.map((item) => item.args?.[1]), [path.join(projectRoot, 'main')]);
        assert.deepStrictEqual(result.validationErrors, []);
    });

    test('does not substitute a valid sibling when the owning pyproject.toml is malformed', async () => {
        const owningToml = await writeTomlContent('main', '[project]\nname = "unterminated\n');
        const siblingToml = await writeToml('copilot', 'myapp');
        findFilesStub.callsFake((pattern: string) =>
            pattern === '**/pyproject.toml'
                ? Promise.resolve([Uri.file(siblingToml), Uri.file(owningToml)])
                : Promise.resolve([]),
        );

        const result = await getProjectInstallable(
            mockApi as PythonEnvironmentApi,
            [{ name: 'myapp', uri: Uri.file(projectRoot) }],
            automaticOptions(path.join(projectRoot, 'main')),
        );

        assert.deepStrictEqual(result.installables, []);
        assert.strictEqual(result.validationErrors[0]?.fileUri.fsPath, owningToml);
    });

    test('ignores a non-installable schema error from a sibling worktree', async () => {
        const owningToml = await writeToml('main', 'myapp');
        const siblingToml = await writeTomlContent(
            'copilot',
            ['[project]', 'name = "myapp"', 'optional-dependencies = ["pytest"]', ''].join('\n'),
        );
        findFilesStub.callsFake((pattern: string) =>
            pattern === '**/pyproject.toml'
                ? Promise.resolve([Uri.file(siblingToml), Uri.file(owningToml)])
                : Promise.resolve([]),
        );

        const result = await getProjectInstallable(
            mockApi as PythonEnvironmentApi,
            [{ name: 'myapp', uri: Uri.file(projectRoot) }],
            automaticOptions(path.join(projectRoot, 'main')),
        );

        assert.deepStrictEqual(result.installables.map((item) => item.args?.[1]), [path.join(projectRoot, 'main')]);
        assert.deepStrictEqual(result.validationErrors, []);
    });

    test('does not substitute a valid sibling when the owning pyproject.toml has a schema error', async () => {
        const owningToml = await writeTomlContent(
            'main',
            ['[project]', 'name = "myapp"', 'optional-dependencies = ["pytest"]', ''].join('\n'),
        );
        const siblingToml = await writeToml('copilot', 'myapp');
        findFilesStub.callsFake((pattern: string) =>
            pattern === '**/pyproject.toml'
                ? Promise.resolve([Uri.file(siblingToml), Uri.file(owningToml)])
                : Promise.resolve([]),
        );

        const result = await getProjectInstallable(
            mockApi as PythonEnvironmentApi,
            [{ name: 'myapp', uri: Uri.file(projectRoot) }],
            automaticOptions(path.join(projectRoot, 'main')),
        );

        assert.deepStrictEqual(result.installables, []);
        assert.strictEqual(result.validationErrors[0]?.fileUri.fsPath, owningToml);
    });

    test('ignores an installable schema-invalid sibling outside the creation root', async () => {
        const owningToml = await writeToml('main', 'myapp');
        const siblingToml = await writeTomlContent(
            'copilot',
            [
                'project = "not-a-table"',
                '',
                '[build-system]',
                'requires = ["setuptools"]',
                'build-backend = "setuptools.build_meta"',
                '',
            ].join('\n'),
        );
        findFilesStub.callsFake((pattern: string) =>
            pattern === '**/pyproject.toml'
                ? Promise.resolve([Uri.file(siblingToml), Uri.file(owningToml)])
                : Promise.resolve([]),
        );

        const result = await getProjectInstallable(
            mockApi as PythonEnvironmentApi,
            [{ name: 'myapp', uri: Uri.file(projectRoot) }],
            automaticOptions(path.join(projectRoot, 'main')),
        );

        assert.deepStrictEqual(result.installables.map((item) => item.args?.[1]), [path.join(projectRoot, 'main')]);
        assert.deepStrictEqual(result.validationErrors, []);
    });

    test('prefers a valid same-name descendant over a disjoint sibling before duplicate selection', async () => {
        const owningToml = await writeToml(path.join('main', 'pkg'), 'shared');
        const siblingToml = await writeToml('copilot', 'shared');
        findFilesStub.callsFake((pattern: string) =>
            pattern === '**/pyproject.toml'
                ? Promise.resolve([Uri.file(siblingToml), Uri.file(owningToml)])
                : Promise.resolve([]),
        );

        const result = await getProjectInstallable(
            mockApi as PythonEnvironmentApi,
            [{ name: 'myapp', uri: Uri.file(projectRoot) }],
            automaticOptions(path.join(projectRoot, 'main')),
        );

        assert.deepStrictEqual(result.installables.map((item) => item.args?.[1]), [
            path.join(projectRoot, 'main', 'pkg'),
        ]);
        assert.deepStrictEqual(result.validationErrors, []);
    });

    test('keeps a schema-invalid exact owner ahead of a valid same-name ancestor', async () => {
        const ancestorToml = await writeToml('main', 'shared');
        const owningToml = await writeTomlContent(
            path.join('main', 'pkg'),
            ['[project]', 'name = "shared"', 'optional-dependencies = ["pytest"]', ''].join('\n'),
        );
        findFilesStub.callsFake((pattern: string) =>
            pattern === '**/pyproject.toml'
                ? Promise.resolve([Uri.file(ancestorToml), Uri.file(owningToml)])
                : Promise.resolve([]),
        );

        const result = await getProjectInstallable(
            mockApi as PythonEnvironmentApi,
            [{ name: 'myapp', uri: Uri.file(projectRoot) }],
            automaticOptions(path.join(projectRoot, 'main', 'pkg')),
        );

        assert.deepStrictEqual(result.installables, []);
        assert.strictEqual(result.validationErrors[0]?.fileUri.fsPath, owningToml);
    });

    test('ignores a same-name invalid ancestor that emits no installable when an exact owner is selected', async () => {
        const ancestorToml = await writeTomlContent(
            'main',
            ['[project]', 'name = "shared"', 'optional-dependencies = ["pytest"]', ''].join('\n'),
        );
        const owningToml = await writeToml(path.join('main', 'pkg'), 'shared');
        findFilesStub.callsFake((pattern: string) =>
            pattern === '**/pyproject.toml'
                ? Promise.resolve([Uri.file(ancestorToml), Uri.file(owningToml)])
                : Promise.resolve([]),
        );

        const result = await getProjectInstallable(
            mockApi as PythonEnvironmentApi,
            [{ name: 'myapp', uri: Uri.file(projectRoot) }],
            automaticOptions(path.join(projectRoot, 'main', 'pkg')),
        );

        assert.deepStrictEqual(result.installables.map((item) => item.args?.[1]), [
            path.join(projectRoot, 'main', 'pkg'),
        ]);
        assert.deepStrictEqual(result.validationErrors, []);
    });

    test('lets an exact valid owner replace an invalid ancestor without changing disjoint eligibility', async () => {
        const ancestorToml = await writeTomlContent(
            'main',
            [
                '[project]',
                'name = "shared"',
                'dependencies = "requests"',
                '',
                '[build-system]',
                'requires = ["setuptools"]',
                'build-backend = "setuptools.build_meta"',
                '',
            ].join('\n'),
        );
        const owningToml = await writeToml(path.join('main', 'pkg'), 'shared');
        const siblingToml = await writeToml('copilot', 'other-package');
        findFilesStub.callsFake((pattern: string) =>
            pattern === '**/pyproject.toml'
                ? Promise.resolve([Uri.file(siblingToml), Uri.file(ancestorToml), Uri.file(owningToml)])
                : Promise.resolve([]),
        );

        const result = await getProjectInstallable(
            mockApi as PythonEnvironmentApi,
            [{ name: 'myapp', uri: Uri.file(projectRoot) }],
            automaticOptions(path.join(projectRoot, 'main', 'pkg')),
        );

        assert.deepStrictEqual(result.installables.map((item) => item.args?.[1]), [
            path.join(projectRoot, 'main', 'pkg'),
        ]);
        assert.deepStrictEqual(result.validationErrors, []);
    });

    test('keeps a schema-invalid same-name descendant eligible before duplicate selection', async () => {
        const owningToml = await writeTomlContent(
            path.join('main', 'pkg'),
            [
                '[project]',
                'name = "shared"',
                'dependencies = "requests"',
                '',
                '[build-system]',
                'requires = ["setuptools"]',
                'build-backend = "setuptools.build_meta"',
                '',
            ].join('\n'),
        );
        const siblingToml = await writeToml('copilot', 'shared');
        findFilesStub.callsFake((pattern: string) =>
            pattern === '**/pyproject.toml'
                ? Promise.resolve([Uri.file(siblingToml), Uri.file(owningToml)])
                : Promise.resolve([]),
        );

        const result = await getProjectInstallable(
            mockApi as PythonEnvironmentApi,
            [{ name: 'myapp', uri: Uri.file(projectRoot) }],
            automaticOptions(path.join(projectRoot, 'main')),
        );

        assert.deepStrictEqual(result.installables.map((item) => item.args?.[1]), [
            path.join(projectRoot, 'main', 'pkg'),
        ]);
        assert.strictEqual(result.validationErrors[0]?.fileUri.fsPath, owningToml);
    });

    test('ignores a schema-invalid same-name sibling before duplicate selection', async () => {
        const owningToml = await writeToml(path.join('main', 'pkg'), 'shared');
        const siblingToml = await writeTomlContent(
            'copilot',
            [
                '[project]',
                'name = "shared"',
                'dependencies = "requests"',
                '',
                '[build-system]',
                'requires = ["setuptools"]',
                'build-backend = "setuptools.build_meta"',
                '',
            ].join('\n'),
        );
        findFilesStub.callsFake((pattern: string) =>
            pattern === '**/pyproject.toml'
                ? Promise.resolve([Uri.file(siblingToml), Uri.file(owningToml)])
                : Promise.resolve([]),
        );

        const result = await getProjectInstallable(
            mockApi as PythonEnvironmentApi,
            [{ name: 'myapp', uri: Uri.file(projectRoot) }],
            automaticOptions(path.join(projectRoot, 'main')),
        );

        assert.deepStrictEqual(result.installables.map((item) => item.args?.[1]), [
            path.join(projectRoot, 'main', 'pkg'),
        ]);
        assert.deepStrictEqual(result.validationErrors, []);
    });

    test('omits ambiguous editable installs from sibling git worktrees', async () => {
        // Two git worktrees checked out as sibling folders under the project root,
        // both declaring the same package name (issue #1627).
        const mainToml = await writeToml('main', 'myapp');
        const copilotToml = await writeToml('copilot', 'myapp');

        findFilesStub.callsFake((pattern: string) => {
            if (pattern === '**/pyproject.toml') {
                return Promise.resolve([Uri.file(mainToml), Uri.file(copilotToml)]);
            }
            return Promise.resolve([]);
        });

        const projects = [{ name: 'myapp', uri: Uri.file(projectRoot) }];
        const result = (
            await getProjectInstallable(mockApi as PythonEnvironmentApi, projects, automaticOptions())
        ).installables;

        const editable = result.filter((r) => r.args?.[0] === '-e');
        assert.strictEqual(editable.length, 0, 'Quick Create should not choose an arbitrary worktree');
    });

    test('duplicate detection is case- and separator-insensitive (PEP 503)', async () => {
        const firstToml = await writeToml('main', 'My_App');
        const secondToml = await writeToml('worktree', 'my-app');

        findFilesStub.callsFake((pattern: string) => {
            if (pattern === '**/pyproject.toml') {
                return Promise.resolve([Uri.file(firstToml), Uri.file(secondToml)]);
            }
            return Promise.resolve([]);
        });

        const projects = [{ name: 'myapp', uri: Uri.file(projectRoot) }];
        const result = (
            await getProjectInstallable(mockApi as PythonEnvironmentApi, projects, automaticOptions())
        ).installables;

        const editable = result.filter((r) => r.args?.[0] === '-e');
        assert.strictEqual(
            editable.length,
            0,
            '"My_App" and "my-app" normalize to the same ambiguous package name',
        );
    });

    test('uses the candidate containing the creation root', async () => {
        const invalidToml = await writeTomlContent(
            'a-invalid',
            tomlFor('myapp').replace('version = "0.1.0"', 'version = "not a version"'),
        );
        const validToml = await writeToml('z-valid', 'myapp');

        findFilesStub.callsFake((pattern: string) => {
            if (pattern === '**/pyproject.toml') {
                return Promise.resolve([Uri.file(invalidToml), Uri.file(validToml)]);
            }
            return Promise.resolve([]);
        });

        const projects = [{ name: 'myapp', uri: Uri.file(projectRoot) }];
        const result = await getProjectInstallable(
            mockApi as PythonEnvironmentApi,
            projects,
            automaticOptions(path.join(projectRoot, 'z-valid')),
        );

        const editable = result.installables.filter((item) => item.args?.[0] === '-e');
        assert.strictEqual(editable.length, 1);
        assert.strictEqual(editable[0].args?.[1], path.join(projectRoot, 'z-valid'));
        assert.strictEqual(result.validationErrors[0], undefined, 'ignored duplicates should not surface validation errors');
    });

    test('reports validation from the preferred candidate instead of substituting another worktree', async () => {
        const invalidToml = await writeTomlContent(
            'main',
            tomlFor('myapp').replace('version = "0.1.0"', 'version = "not a version"'),
        );
        const validToml = await writeToml('copilot', 'myapp');

        findFilesStub.callsFake((pattern: string) => {
            if (pattern === '**/pyproject.toml') {
                return Promise.resolve([Uri.file(validToml), Uri.file(invalidToml)]);
            }
            return Promise.resolve([]);
        });

        const projects = [{ name: 'myapp', uri: Uri.file(projectRoot) }];
        const result = await getProjectInstallable(
            mockApi as PythonEnvironmentApi,
            projects,
            automaticOptions(path.join(projectRoot, 'main')),
        );

        const editable = result.installables.filter((item) => item.args?.[0] === '-e');
        assert.strictEqual(editable.length, 1);
        assert.strictEqual(editable[0].args?.[1], path.join(projectRoot, 'main'));
        assert.strictEqual(result.validationErrors[0]?.fileUri.fsPath, invalidToml);
    });

    test('does not let a metadata-only TOML with optional dependencies suppress an installable duplicate', async () => {
        const metadataToml = await writeTomlContent(
            'a-metadata',
            [
                '[project]',
                'name = "myapp"',
                'version = "0.1.0"',
                '',
                '[project.optional-dependencies]',
                'dev = ["pytest"]',
                '',
            ].join('\n'),
        );
        const installableToml = await writeToml('z-installable', 'myapp');

        findFilesStub.callsFake((pattern: string) => {
            if (pattern === '**/pyproject.toml') {
                return Promise.resolve([Uri.file(metadataToml), Uri.file(installableToml)]);
            }
            return Promise.resolve([]);
        });

        const projects = [{ name: 'myapp', uri: Uri.file(projectRoot) }];
        const result = (
            await getProjectInstallable(
                mockApi as PythonEnvironmentApi,
                projects,
                automaticOptions(path.join(projectRoot, 'z-installable')),
            )
        ).installables;

        const editable = result.filter((item) => item.args?.[0] === '-e');
        assert.strictEqual(editable.length, 1);
        assert.strictEqual(editable[0].args?.[1], path.join(projectRoot, 'z-installable'));
    });

    test('prefers metadata that emits optional dependencies over an empty peer', async () => {
        const emptyToml = await writeTomlContent(
            'a-empty',
            ['[project]', 'name = "myapp"', 'version = "0.1.0"', ''].join('\n'),
        );
        const optionalToml = await writeTomlContent(
            'z-optional',
            [
                '[project]',
                'name = "myapp"',
                'version = "0.1.0"',
                '',
                '[project.optional-dependencies]',
                'dev = ["pytest"]',
                '',
            ].join('\n'),
        );

        findFilesStub.callsFake((pattern: string) => {
            if (pattern === '**/pyproject.toml') {
                return Promise.resolve([Uri.file(emptyToml), Uri.file(optionalToml)]);
            }
            return Promise.resolve([]);
        });

        const projects = [{ name: 'myapp', uri: Uri.file(projectRoot) }];
        const result = (
            await getProjectInstallable(mockApi as PythonEnvironmentApi, projects, automaticOptions())
        ).installables;

        const editable = result.filter((item) => item.args?.[0] === '-e');
        assert.strictEqual(editable.length, 1);
        assert.strictEqual(editable[0].args?.[1], `${path.join(projectRoot, 'z-optional')}[dev]`);
    });

    test('prefers the containing worktree regardless of discovery order or path characters', async () => {
        const zToml = await writeToml('z-worktree', 'myapp');
        const accentedToml = await writeToml('ä-worktree', 'myapp');

        findFilesStub.callsFake((pattern: string) => {
            if (pattern === '**/pyproject.toml') {
                return Promise.resolve([Uri.file(accentedToml), Uri.file(zToml)]);
            }
            return Promise.resolve([]);
        });

        const projects = [{ name: 'myapp', uri: Uri.file(projectRoot) }];
        const result = (
            await getProjectInstallable(
                mockApi as PythonEnvironmentApi,
                projects,
                automaticOptions(path.join(projectRoot, 'z-worktree')),
            )
        ).installables;

        const editable = result.filter((item) => item.args?.[0] === '-e');
        assert.strictEqual(editable.length, 1);
        assert.strictEqual(editable[0].args?.[1], path.join(projectRoot, 'z-worktree'));
    });

    test('keeps distinct packages in a monorepo (different names are not de-duplicated)', async () => {
        const pkgAToml = await writeToml(path.join('packages', 'a'), 'pkg-a');
        const pkgBToml = await writeToml(path.join('packages', 'b'), 'pkg-b');

        findFilesStub.callsFake((pattern: string) => {
            if (pattern === '**/pyproject.toml') {
                return Promise.resolve([Uri.file(pkgAToml), Uri.file(pkgBToml)]);
            }
            return Promise.resolve([]);
        });

        const projects = [{ name: 'myapp', uri: Uri.file(projectRoot) }];
        const result = (
            await getProjectInstallable(mockApi as PythonEnvironmentApi, projects, automaticOptions())
        ).installables;

        const editableDirs = result.filter((r) => r.args?.[0] === '-e').map((r) => r.args?.[1]);
        assert.strictEqual(editableDirs.length, 2, 'Distinct package names should both be kept');
        assert.deepStrictEqual(
            editableDirs.sort(),
            [path.join(projectRoot, 'packages', 'a'), path.join(projectRoot, 'packages', 'b')].sort(),
        );
    });

    test('does not de-duplicate requirements.txt files by name', async () => {
        // requirements files are not project packages; identical basenames in
        // different folders must all be preserved.
        const rootReq = path.join(projectRoot, 'requirements.txt');
        const subReq = path.join(projectRoot, 'subdir', 'requirements.txt');

        findFilesStub.callsFake((pattern: string) => {
            if (pattern === '**/*requirements*.txt') {
                return Promise.resolve([Uri.file(subReq)]);
            }
            if (pattern === '*requirements*.txt') {
                return Promise.resolve([Uri.file(rootReq)]);
            }
            return Promise.resolve([]);
        });

        const projects = [{ name: 'myapp', uri: Uri.file(projectRoot) }];
        const result = (
            await getProjectInstallable(mockApi as PythonEnvironmentApi, projects, automaticOptions())
        ).installables;

        const reqs = result.filter((r) => r.args?.[0] === '-r');
        assert.strictEqual(reqs.length, 2, 'Both requirements.txt files should be preserved');
    });

    test('keeps same-named packages from separate projects in the manual picker', async () => {
        const firstProjectRoot = path.join(projectRoot, 'first');
        const secondProjectRoot = path.join(projectRoot, 'second');
        const firstToml = await writeToml('first', 'shared-name');
        const secondToml = await writeToml('second', 'shared-name');
        mockApi.getPythonProject = (uri: Uri) => {
            if (uri.fsPath.startsWith(firstProjectRoot)) {
                return { name: 'first', uri: Uri.file(firstProjectRoot) };
            }
            if (uri.fsPath.startsWith(secondProjectRoot)) {
                return { name: 'second', uri: Uri.file(secondProjectRoot) };
            }
            return undefined;
        };
        findFilesStub.callsFake((pattern: string) => {
            if (pattern === '**/pyproject.toml') {
                return Promise.resolve([Uri.file(firstToml), Uri.file(secondToml)]);
            }
            return Promise.resolve([]);
        });

        const projects = [
            { name: 'first', uri: Uri.file(firstProjectRoot) },
            { name: 'second', uri: Uri.file(secondProjectRoot) },
        ];
        const result = (await getProjectInstallable(mockApi as PythonEnvironmentApi, projects)).installables;

        assert.strictEqual(result.filter((item) => item.args?.[0] === '-e').length, 2);
    });
});
