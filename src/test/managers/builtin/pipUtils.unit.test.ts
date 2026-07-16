import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { CancellationToken, Progress, ProgressOptions, Uri } from 'vscode';
import * as fse from 'fs-extra';
import * as os from 'os';
import { PythonEnvironmentApi, PythonProject } from '../../../api';
import * as winapi from '../../../common/window.apis';
import * as wapi from '../../../common/workspace.apis';
import { getProjectInstallable } from '../../../managers/builtin/pipUtils';

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
                    { isCancellationRequested: false } as CancellationToken,
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
        assert.strictEqual(result.validationError, undefined, 'ignored duplicates should not surface validation errors');
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
        assert.strictEqual(result.validationError?.fileUri.fsPath, invalidToml);
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
