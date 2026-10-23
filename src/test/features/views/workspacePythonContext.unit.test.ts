/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as commandApis from '../../../common/command.api';
import * as logging from '../../../common/logging';
import * as workspaceApis from '../../../common/workspace.apis';
import {
    MARKER_GLOB,
    PYTHON_WORKSPACE_KEY,
    registerWorkspacePythonContext,
} from '../../../features/views/workspacePythonContext';

type Listener<T> = (e: T) => void;

function makeDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
}

/** Lets every pending promise continuation run. */
function flush(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

const marker = (fsPath: string) => ({ fsPath }) as any;

suite('Workspace Python context', () => {
    let findFilesStub: sinon.SinonStub;
    let openDocsStub: sinon.SinonStub;
    let executeCommandStub: sinon.SinonStub;
    let traceErrorStub: sinon.SinonStub;
    let watcher: { dispose: sinon.SinonStub; onDidCreate: sinon.SinonStub; onDidDelete: sinon.SinonStub };
    let foldersStub: sinon.SinonStub;
    let openStub: sinon.SinonStub;
    let disposables: any[];

    const fireCreate = (fsPath: string) => (watcher.onDidCreate.firstCall.args[0] as Listener<any>)(marker(fsPath));
    const fireDelete = (fsPath: string) => (watcher.onDidDelete.firstCall.args[0] as Listener<any>)(marker(fsPath));
    const fireFoldersChanged = () => (foldersStub.firstCall.args[0] as Listener<any>)({});
    const fireDocOpened = (languageId: string) => (openStub.firstCall.args[0] as Listener<any>)({ languageId });
    const contextValues = () =>
        executeCommandStub.getCalls().map((c) => {
            assert.strictEqual(c.args[0], 'setContext');
            assert.strictEqual(c.args[1], PYTHON_WORKSPACE_KEY);
            return c.args[2];
        });

    setup(() => {
        findFilesStub = sinon.stub(workspaceApis, 'findFiles').resolves([]);
        openDocsStub = sinon.stub(workspaceApis, 'getOpenTextDocuments').returns([]);
        executeCommandStub = sinon.stub(commandApis, 'executeCommand').resolves(undefined);
        traceErrorStub = sinon.stub(logging, 'traceError');

        const disposable = { dispose: sinon.stub() };
        watcher = {
            dispose: sinon.stub(),
            onDidCreate: sinon.stub().returns(disposable),
            onDidDelete: sinon.stub().returns(disposable),
        };
        sinon.stub(workspaceApis, 'createFileSystemWatcher').returns(watcher as any);
        foldersStub = sinon.stub(workspaceApis, 'onDidChangeWorkspaceFolders').returns(disposable as any);
        openStub = sinon.stub(workspaceApis, 'onDidOpenTextDocument').returns(disposable as any);
        disposables = [];
    });

    teardown(() => {
        sinon.restore();
    });

    suite('initial state', () => {
        test('is true when a marker file exists in the workspace', async () => {
            findFilesStub.resolves([marker('/ws/pyproject.toml')]);
            registerWorkspacePythonContext(disposables);
            await flush();
            assert.deepStrictEqual(contextValues(), [true]);
        });

        test('is false when there is no marker file and no Python document is open', async () => {
            registerWorkspacePythonContext(disposables);
            await flush();
            assert.deepStrictEqual(contextValues(), [false]);
        });

        test('is true for a standalone Python file opened without a folder', async () => {
            openDocsStub.returns([{ languageId: 'markdown' }, { languageId: 'python' }]);
            registerWorkspacePythonContext(disposables);
            await flush();
            assert.deepStrictEqual(contextValues(), [true]);
        });

        test('searches for a single hit, excluding dependency folders', async () => {
            registerWorkspacePythonContext(disposables);
            await flush();
            const [include, exclude, maxResults] = findFilesStub.firstCall.args;
            assert.strictEqual(include, MARKER_GLOB);
            assert.ok(String(exclude).includes('site-packages'));
            assert.ok(String(exclude).includes('node_modules'));
            assert.strictEqual(maxResults, 1);
        });

        test('registers its watcher and listeners for disposal', () => {
            registerWorkspacePythonContext(disposables);
            assert.ok(disposables.includes(watcher));
            assert.strictEqual(disposables.length, 5);
        });
    });

    suite('marker taxonomy', () => {
        test('covers notebooks, stubs and virtual environment markers', () => {
            for (const expected of ['*.py', '*.pyi', '*.ipynb', 'pyproject.toml', 'requirements.txt', 'pyvenv.cfg']) {
                assert.ok(MARKER_GLOB.includes(expected), `${expected} should be a marker`);
            }
        });

        test('does not rely on directory names that findFiles can never return', () => {
            assert.ok(!MARKER_GLOB.includes('.venv'));
            assert.ok(!MARKER_GLOB.includes('.conda'));
        });
    });

    suite('transitions', () => {
        test('creating the first marker turns the context on', async () => {
            registerWorkspacePythonContext(disposables);
            await flush();
            findFilesStub.resolves([marker('/ws/app/main.py')]);
            fireCreate('/ws/app/main.py');
            await flush();
            assert.deepStrictEqual(contextValues(), [false, true]);
        });

        test('deleting the last marker turns the context off', async () => {
            findFilesStub.resolves([marker('/ws/main.py')]);
            registerWorkspacePythonContext(disposables);
            await flush();
            findFilesStub.resolves([]);
            fireDelete('/ws/main.py');
            await flush();
            assert.deepStrictEqual(contextValues(), [true, false]);
        });

        test('changing workspace folders re-evaluates the context', async () => {
            registerWorkspacePythonContext(disposables);
            await flush();
            findFilesStub.resolves([marker('/other/requirements.txt')]);
            fireFoldersChanged();
            await flush();
            assert.deepStrictEqual(contextValues(), [false, true]);
        });

        test('opening a Python document re-evaluates the context', async () => {
            registerWorkspacePythonContext(disposables);
            await flush();
            openDocsStub.returns([{ languageId: 'python' }]);
            fireDocOpened('python');
            await flush();
            assert.deepStrictEqual(contextValues(), [false, true]);
        });

        test('opening a non-Python document does not trigger a rescan', async () => {
            registerWorkspacePythonContext(disposables);
            await flush();
            fireDocOpened('markdown');
            await flush();
            assert.strictEqual(findFilesStub.callCount, 1);
        });
    });

    suite('exclusions', () => {
        [
            '/ws/.venv/lib/python3.12/site-packages/pkg/mod.py',
            'C:\\ws\\.venv\\Lib\\site-packages\\pkg\\mod.py',
            '/ws/node_modules/tool/setup.py',
            '/ws/.git/hooks/pre-commit.py',
        ].forEach((excluded) => {
            test(`ignores create and delete events under ${excluded}`, async () => {
                registerWorkspacePythonContext(disposables);
                await flush();
                fireCreate(excluded);
                fireDelete(excluded);
                await flush();
                assert.strictEqual(findFilesStub.callCount, 1, 'only the initial scan should have run');
                assert.strictEqual(executeCommandStub.callCount, 1);
            });
        });

        test('does not ignore folders that merely look similar to an excluded one', async () => {
            registerWorkspacePythonContext(disposables);
            await flush();
            fireCreate('/ws/my-site-packages-notes/main.py');
            await flush();
            assert.strictEqual(findFilesStub.callCount, 2);
        });
    });

    suite('overlapping refreshes', () => {
        test('an older scan that finishes last does not overwrite newer state', async () => {
            const older = makeDeferred<any[]>();
            const newer = makeDeferred<any[]>();
            findFilesStub.onFirstCall().returns(older.promise);
            findFilesStub.onSecondCall().returns(newer.promise);

            registerWorkspacePythonContext(disposables); // older scan: started first, still running
            fireDelete('/ws/main.py'); // newer scan: started second

            newer.resolve([]); // newer result (false) arrives first...
            await flush();
            older.resolve([marker('/ws/main.py')]); // ...then the stale result (true) arrives
            await flush();

            assert.deepStrictEqual(contextValues(), [false]);
        });

        test('the newest scan wins when scans finish in order', async () => {
            const older = makeDeferred<any[]>();
            const newer = makeDeferred<any[]>();
            findFilesStub.onFirstCall().returns(older.promise);
            findFilesStub.onSecondCall().returns(newer.promise);

            registerWorkspacePythonContext(disposables);
            fireCreate('/ws/main.py');

            older.resolve([]);
            await flush();
            newer.resolve([marker('/ws/main.py')]);
            await flush();

            assert.deepStrictEqual(contextValues(), [true]);
        });
    });

    suite('error handling', () => {
        test('a failing search is logged and does not reject', async () => {
            const error = new Error('search failed');
            findFilesStub.rejects(error);
            registerWorkspacePythonContext(disposables);
            await flush();
            assert.ok(traceErrorStub.calledOnce);
            assert.strictEqual(traceErrorStub.firstCall.args[1], error);
            assert.strictEqual(executeCommandStub.callCount, 0);
        });

        test('a failing setContext is logged and does not reject', async () => {
            const error = new Error('setContext failed');
            executeCommandStub.rejects(error);
            registerWorkspacePythonContext(disposables);
            await flush();
            assert.ok(traceErrorStub.calledOnce);
            assert.strictEqual(traceErrorStub.firstCall.args[1], error);
        });

        test('keeps working after a failed refresh', async () => {
            findFilesStub.onFirstCall().rejects(new Error('boom'));
            registerWorkspacePythonContext(disposables);
            await flush();
            findFilesStub.resolves([marker('/ws/main.py')]);
            fireCreate('/ws/main.py');
            await flush();
            assert.deepStrictEqual(contextValues(), [true]);
        });
    });
});