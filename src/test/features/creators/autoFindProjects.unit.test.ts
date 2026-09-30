import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as typmoq from 'typemoq';
import { Uri, WorkspaceFolder } from 'vscode';
import { PythonEnvironment, PythonProject } from '../../../api';
import { SYSTEM_MANAGER_ID, VENV_MANAGER_ID } from '../../../common/constants';
import { timeout } from '../../../common/utils/asyncUtils';
import { createDeferred } from '../../../common/utils/deferred';
import * as winapi from '../../../common/window.apis';
import * as wapi from '../../../common/workspace.apis';
import { AutoFindProjects } from '../../../features/creators/autoFindProjects';
import type { EnvironmentManagers } from '../../../features/envManagers';
import type { PythonProjectManager } from '../../../features/projectManager';

suite('Auto Find Project tests', () => {
    let findFilesStub: sinon.SinonStub;
    let showErrorMessageStub: sinon.SinonStub;
    let showQuickPickWithButtonsStub: sinon.SinonStub;
    let showWarningMessageStub: sinon.SinonStub;
    let getWorkspaceFoldersStub: sinon.SinonStub;
    let projectManager: typmoq.IMock<PythonProjectManager>;
    let envManagers: typmoq.IMock<EnvironmentManagers>;

    setup(() => {
        findFilesStub = sinon.stub(wapi, 'findFiles');
        showErrorMessageStub = sinon.stub(winapi, 'showErrorMessage');
        showQuickPickWithButtonsStub = sinon.stub(winapi, 'showQuickPickWithButtons');
        showQuickPickWithButtonsStub.callsFake((items) => items);
        showWarningMessageStub = sinon.stub(winapi, 'showWarningMessage');
        getWorkspaceFoldersStub = sinon.stub(wapi, 'getWorkspaceFolders').returns(undefined);

        projectManager = typmoq.Mock.ofType<PythonProjectManager>();
        envManagers = typmoq.Mock.ofType<EnvironmentManagers>();
    });

    teardown(() => {
        sinon.restore();
    });

    test('No projects found', async () => {
        findFilesStub.resolves([]);

        const deferred = createDeferred();

        let errorShown = false;
        showErrorMessageStub.callsFake(() => {
            errorShown = true;
            deferred.resolve();
        });

        const autoFindProjects = new AutoFindProjects(projectManager.object, envManagers.object);
        const result = await autoFindProjects.create();
        assert.equal(result, undefined, 'Result should be undefined');

        await Promise.race([deferred.promise, timeout(100)]);
        assert.ok(errorShown, 'Error message should have been shown');
    });

    test('No projects found (undefined)', async () => {
        findFilesStub.resolves(undefined);

        const deferred = createDeferred();

        let errorShown = false;
        showErrorMessageStub.callsFake(() => {
            errorShown = true;
            deferred.resolve();
        });

        const autoFindProjects = new AutoFindProjects(projectManager.object, envManagers.object);
        const result = await autoFindProjects.create();
        assert.equal(result, undefined, 'Result should be undefined');

        await Promise.race([deferred.promise, timeout(100)]);
        assert.ok(errorShown, 'Error message should have been shown');
    });

    test('Projects found', async () => {
        findFilesStub.resolves([
            Uri.file('/usr/home/root/a/pyproject.toml'),
            Uri.file('/usr/home/root/b/pyproject.toml'),
        ]);

        projectManager.setup((pm) => pm.get(typmoq.It.isAny())).returns(() => undefined);

        const autoFindProjects = new AutoFindProjects(projectManager.object, envManagers.object);
        const result = await autoFindProjects.create();

        const expected: PythonProject[] = [
            {
                name: 'a',
                uri: Uri.file('/usr/home/root/a'),
            },
            {
                name: 'b',
                uri: Uri.file('/usr/home/root/b'),
            },
        ];

        assert.ok(Array.isArray(result), 'Result should be an array');
        assert.equal(result.length, expected.length, `Result should have ${expected.length} items`);

        expected.forEach((item) => {
            assert.ok(
                result.some((r) => r.name === item.name && r.uri.fsPath === item.uri.fsPath),
                'Item not found in result',
            );
        });
        result.forEach((item) => {
            assert.ok(
                expected.some((r) => r.name === item.name && r.uri.fsPath === item.uri.fsPath),
                'Item not found in expected',
            );
        });
    });

    test('Projects found (with duplicates)', async () => {
        findFilesStub.resolves([
            Uri.file('/usr/home/root/a/pyproject.toml'),
            Uri.file('/usr/home/root/b/pyproject.toml'),
            Uri.file('/usr/home/root/c/pyproject.toml'),
            Uri.file('/usr/home/root/d/pyproject.toml'),
        ]);

        projectManager
            .setup((pm) => pm.get(typmoq.It.isAny()))
            .returns((uri) => {
                const basename = path.basename(uri.fsPath);
                if (basename === 'pyproject.toml') {
                    const parent = path.dirname(uri.fsPath);
                    const name = path.basename(parent);
                    if (name === 'a' || name === 'd') {
                        return { name, uri: Uri.file(parent) };
                    }
                }
            });

        const autoFindProjects = new AutoFindProjects(projectManager.object, envManagers.object);
        const result = await autoFindProjects.create();

        const expected: PythonProject[] = [
            {
                name: 'b',
                uri: Uri.file('/usr/home/root/b'),
            },
            {
                name: 'c',
                uri: Uri.file('/usr/home/root/c'),
            },
        ];

        assert.ok(Array.isArray(result), 'Result should be an array');
        assert.equal(result.length, expected.length, `Result should have ${expected.length} items`);

        expected.forEach((item) => {
            assert.ok(
                result.some((r) => r.name === item.name && r.uri.fsPath === item.uri.fsPath),
                'Item not found in result',
            );
        });
        result.forEach((item) => {
            assert.ok(
                expected.some((r) => r.name === item.name && r.uri.fsPath === item.uri.fsPath),
                'Item not found in expected',
            );
        });
    });

    test('Projects found (with all duplicates)', async () => {
        findFilesStub.resolves([
            Uri.file('/usr/home/root/a/pyproject.toml'),
            Uri.file('/usr/home/root/b/pyproject.toml'),
            Uri.file('/usr/home/root/c/pyproject.toml'),
            Uri.file('/usr/home/root/d/pyproject.toml'),
        ]);

        projectManager
            .setup((pm) => pm.get(typmoq.It.isAny()))
            .returns((uri) => {
                const basename = path.basename(uri.fsPath);
                if (basename === 'pyproject.toml') {
                    const parent = path.dirname(uri.fsPath);
                    const name = path.basename(parent);
                    return { name, uri: Uri.file(parent) };
                }
            });

        const autoFindProjects = new AutoFindProjects(projectManager.object, envManagers.object);
        const result = await autoFindProjects.create();

        assert.equal(result, undefined, 'Result should be undefined');
    });

    test('Projects found no selection', async () => {
        findFilesStub.resolves([
            Uri.file('/usr/home/root/a/pyproject.toml'),
            Uri.file('/usr/home/root/b/pyproject.toml'),
        ]);

        projectManager.setup((pm) => pm.get(typmoq.It.isAny())).returns(() => undefined);

        showQuickPickWithButtonsStub.callsFake(() => []);

        const autoFindProjects = new AutoFindProjects(projectManager.object, envManagers.object);
        const result = await autoFindProjects.create();

        assert.equal(result, undefined, 'Result should be undefined');
    });

    test('Projects found with no selection (user hit escape in picker)', async () => {
        findFilesStub.resolves([
            Uri.file('/usr/home/root/a/pyproject.toml'),
            Uri.file('/usr/home/root/b/pyproject.toml'),
        ]);

        projectManager.setup((pm) => pm.get(typmoq.It.isAny())).returns(() => undefined);

        showQuickPickWithButtonsStub.callsFake(() => undefined);

        const autoFindProjects = new AutoFindProjects(projectManager.object, envManagers.object);
        const result = await autoFindProjects.create();

        assert.equal(result, undefined, 'Result should be undefined');
    });

    test('Projects found with selection', async () => {
        findFilesStub.resolves([
            Uri.file('/usr/home/root/a/pyproject.toml'),
            Uri.file('/usr/home/root/b/pyproject.toml'),
            Uri.file('/usr/home/root/c/pyproject.toml'),
            Uri.file('/usr/home/root/d/pyproject.toml'),
        ]);

        projectManager
            .setup((pm) => pm.get(typmoq.It.isAny()))
            .returns((uri) => {
                const basename = path.basename(uri.fsPath);
                if (basename === 'pyproject.toml') {
                    const parent = path.dirname(uri.fsPath);
                    const name = path.basename(parent);
                    if (name === 'c') {
                        return { name, uri: Uri.file(parent) };
                    }
                }
            });

        showQuickPickWithButtonsStub.callsFake((items) => {
            return [items[0], items[2]];
        });

        const expected: PythonProject[] = [
            {
                name: 'a',
                uri: Uri.file('/usr/home/root/a'),
            },
            {
                name: 'd',
                uri: Uri.file('/usr/home/root/d'),
            },
        ];

        const autoFindProjects = new AutoFindProjects(projectManager.object, envManagers.object);
        const result = await autoFindProjects.create();

        assert.ok(Array.isArray(result), 'Result should be an array');
        assert.equal(result.length, expected.length, `Result should have ${expected.length} items`);

        expected.forEach((item) => {
            assert.ok(
                result.some((r) => r.name === item.name && r.uri.fsPath === item.uri.fsPath),
                'Item not found in result',
            );
        });
        result.forEach((item) => {
            assert.ok(
                expected.some((r) => r.name === item.name && r.uri.fsPath === item.uri.fsPath),
                'Item not found in expected',
            );
        });
    });
    suite('Selected environment sysPrefix exclusion', () => {
        const root = Uri.file(path.join(path.parse(process.cwd()).root, 'usr', 'home', 'root')).fsPath;
        const root2 = Uri.file(path.join(path.parse(process.cwd()).root, 'usr', 'home', 'root2')).fsPath;
        const broadPrefix = Uri.file(path.join(path.parse(root).root, 'usr')).fsPath;

        function folder(fsPath: string, index: number): WorkspaceFolder {
            return { uri: Uri.file(fsPath), name: path.basename(fsPath), index };
        }

        function setupEnvironments(prefixes: Map<string, string | undefined | Error>, managerId = VENV_MANAGER_ID): void {
            getWorkspaceFoldersStub.returns(Array.from(prefixes.keys()).map((p, i) => folder(p, i)));
            envManagers
                .setup((em) => em.getEnvironment(typmoq.It.isAny()))
                .returns(async (scope: Uri) => {
                    const value = prefixes.get(scope.fsPath);
                    if (value instanceof Error) {
                        throw value;
                    }
                    return value === undefined
                        ? undefined
                        : ({ sysPrefix: value, envId: { id: value, managerId } } as PythonEnvironment);
                });
        }

        function names(result: PythonProject | PythonProject[] | undefined): string[] {
            assert.ok(Array.isArray(result), 'Result should be an array');
            return result.map((r) => r.name).sort();
        }

        test('Excludes markers under a custom-named selected environment, keeps real projects', async () => {
            const envPrefix = path.join(root, 'custom-env');
            setupEnvironments(new Map([[root, envPrefix]]));
            findFilesStub.resolves([
                Uri.file(path.join(root, 'app', 'pyproject.toml')),
                Uri.file(path.join(root, 'custom-env-project', 'setup.py')),
                Uri.file(path.join(envPrefix, 'pyproject.toml')),
                Uri.file(path.join(envPrefix, 'lib', 'site-packages', 'pkg1', 'pyproject.toml')),
                Uri.file(path.join(envPrefix, 'lib', 'site-packages', 'pkg2', 'setup.py')),
            ]);
            projectManager.setup((pm) => pm.get(typmoq.It.isAny())).returns(() => undefined);

            const autoFindProjects = new AutoFindProjects(projectManager.object, envManagers.object);
            const result = await autoFindProjects.create();

            assert.deepStrictEqual(names(result), ['app', 'custom-env-project']);
            const items = showQuickPickWithButtonsStub.firstCall.args[0] as { label: string }[];
            assert.deepStrictEqual(items.map((i) => i.label).sort(), ['app', 'custom-env-project']);
        });

        test('Keeps workspace projects when the selected system Python prefix contains the workspace', async () => {
            setupEnvironments(new Map([[root, broadPrefix]]), SYSTEM_MANAGER_ID);
            findFilesStub.resolves([
                Uri.file(path.join(root, 'pyproject.toml')),
                Uri.file(path.join(root, 'app', 'setup.py')),
            ]);
            projectManager.setup((pm) => pm.get(typmoq.It.isAny())).returns(() => undefined);

            const autoFindProjects = new AutoFindProjects(projectManager.object, envManagers.object);
            assert.deepStrictEqual(names(await autoFindProjects.create()), ['app', path.basename(root)]);
        });

        test('Excludes a workspace-local virtual environment resolved by the system manager', async () => {
            const envPrefix = path.join(root, 'custom-env');
            setupEnvironments(new Map([[root, envPrefix]]), SYSTEM_MANAGER_ID);
            findFilesStub.resolves([
                Uri.file(path.join(root, 'app', 'pyproject.toml')),
                Uri.file(path.join(envPrefix, 'lib', 'pkg', 'setup.py')),
            ]);
            projectManager.setup((pm) => pm.get(typmoq.It.isAny())).returns(() => undefined);

            const autoFindProjects = new AutoFindProjects(projectManager.object, envManagers.object);
            assert.deepStrictEqual(names(await autoFindProjects.create()), ['app']);
        });

        test('Keeps workspace projects when a selected prefix contains or equals the workspace', async () => {
            setupEnvironments(new Map([[root, broadPrefix], [root2, root2]]));
            findFilesStub.resolves([
                Uri.file(path.join(root, 'app', 'pyproject.toml')),
                Uri.file(path.join(root2, 'setup.py')),
            ]);
            projectManager.setup((pm) => pm.get(typmoq.It.isAny())).returns(() => undefined);

            const autoFindProjects = new AutoFindProjects(projectManager.object, envManagers.object);
            assert.deepStrictEqual(names(await autoFindProjects.create()), ['app', path.basename(root2)]);
        });

        test('Keeps a nested workspace root selected as the parent workspace environment prefix', async () => {
            const nested = path.join(root, 'nested');
            const nestedEnv = path.join(nested, 'custom-env');
            setupEnvironments(new Map([[root, nested], [nested, nestedEnv]]));
            findFilesStub.resolves([
                Uri.file(path.join(root, 'app', 'setup.py')),
                Uri.file(path.join(nested, 'pyproject.toml')),
                Uri.file(path.join(nestedEnv, 'lib', 'pkg', 'setup.py')),
            ]);
            projectManager.setup((pm) => pm.get(typmoq.It.isAny())).returns(() => undefined);

            const autoFindProjects = new AutoFindProjects(projectManager.object, envManagers.object);
            assert.deepStrictEqual(names(await autoFindProjects.create()), ['app', 'nested']);
        });

        test('Applies each workspace folder selected environment prefix independently', async () => {
            const env1 = path.join(root, 'env-one');
            const env2 = path.join(root2, 'env-two');
            setupEnvironments(
                new Map([
                    [root, env1],
                    [root2, env2],
                ]),
            );
            findFilesStub.resolves([
                Uri.file(path.join(root, 'a', 'pyproject.toml')),
                Uri.file(path.join(env1, 'lib', 'pkg', 'setup.py')),
                Uri.file(path.join(root2, 'b', 'pyproject.toml')),
                Uri.file(path.join(env2, 'lib', 'pkg', 'pyproject.toml')),
            ]);
            projectManager.setup((pm) => pm.get(typmoq.It.isAny())).returns(() => undefined);

            const autoFindProjects = new AutoFindProjects(projectManager.object, envManagers.object);
            const result = await autoFindProjects.create();

            assert.deepStrictEqual(names(result), ['a', 'b']);
            envManagers.verify((em) => em.getEnvironment(typmoq.It.isAny()), typmoq.Times.exactly(2));
        });

        test('Excludes a selected environment inside a different workspace folder', async () => {
            const envPrefix = path.join(root2, 'shared-env');
            setupEnvironments(new Map([[root, envPrefix], [root2, undefined]]));
            findFilesStub.resolves([
                Uri.file(path.join(root, 'app', 'pyproject.toml')),
                Uri.file(path.join(root2, 'other', 'pyproject.toml')),
                Uri.file(path.join(envPrefix, 'lib', 'pkg', 'setup.py')),
            ]);
            projectManager.setup((pm) => pm.get(typmoq.It.isAny())).returns(() => undefined);

            const autoFindProjects = new AutoFindProjects(projectManager.object, envManagers.object);
            assert.deepStrictEqual(names(await autoFindProjects.create()), ['app', 'other']);
        });

        test('Missing, relative, or failed environment lookups preserve existing behavior', async () => {
            const root3 = Uri.file(path.join(path.parse(root).root, 'usr', 'home', 'root3')).fsPath;
            setupEnvironments(
                new Map<string, string | undefined | Error>([
                    [root, undefined],
                    [root2, 'relative-env'],
                    [root3, new Error('lookup failed')],
                ]),
            );
            findFilesStub.resolves([
                Uri.file(path.join(root, 'a', 'pyproject.toml')),
                Uri.file(path.join(root2, 'relative-env', 'setup.py')),
                Uri.file(path.join(root3, 'c', 'pyproject.toml')),
            ]);
            projectManager.setup((pm) => pm.get(typmoq.It.isAny())).returns(() => undefined);

            const autoFindProjects = new AutoFindProjects(projectManager.object, envManagers.object);
            const result = await autoFindProjects.create();

            assert.deepStrictEqual(names(result), ['a', 'c', 'relative-env']);
        });

        test('All markers inside selected environments shows no projects found without picker', async () => {
            const envPrefix = path.join(root, 'custom-env');
            setupEnvironments(new Map([[root, envPrefix]]));
            findFilesStub.resolves([
                Uri.file(path.join(envPrefix, 'lib', 'pkg1', 'pyproject.toml')),
                Uri.file(path.join(envPrefix, 'lib', 'pkg2', 'setup.py')),
            ]);

            const deferred = createDeferred();
            showErrorMessageStub.callsFake(() => deferred.resolve());

            const autoFindProjects = new AutoFindProjects(projectManager.object, envManagers.object);
            const result = await autoFindProjects.create();

            assert.equal(result, undefined, 'Result should be undefined');
            await Promise.race([deferred.promise, timeout(100)]);
            assert.ok(showErrorMessageStub.calledOnce, 'No projects found error should have been shown');
            assert.ok(showWarningMessageStub.notCalled, 'Already registered warning should not be shown');
            assert.ok(showQuickPickWithButtonsStub.notCalled, 'Picker should not be shown');
            projectManager.verify((pm) => pm.add(typmoq.It.isAny()), typmoq.Times.never());
        });
    });
});
