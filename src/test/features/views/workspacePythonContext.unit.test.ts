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
    RESCAN_DEBOUNCE_MS,
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
    let clock: sinon.SinonFakeTimers;
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
    /** Runs the debounced rescan, then lets the scan it starts settle. */
    const settle = async () => {
        await clock.tickAsync(RESCAN_DEBOUNCE_MS);
        await flush();
    };
    const tokenOfScan = (index: number) => findFilesStub.getCall(index).args[3];

    setup(() => {
        // Only timers are faked, so `flush` (setImmediate) still lets promises settle.
        clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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
        disposables.forEach((d) => d.dispose());
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
            const [include, exclude, maxResults, token] = findFilesStub.firstCall.args;
            assert.strictEqual(include, MARKER_GLOB);
            assert.ok(String(exclude).includes('site-packages'));
            assert.ok(String(exclude).includes('node_modules'));
            assert.strictEqual(maxResults, 1);
            assert.ok(token, 'the scan should be cancellable');
        });

        test('registers its watcher and listeners for disposal', () => {
            registerWorkspacePythonContext(disposables);
            assert.ok(disposables.includes(watcher));
            assert.strictEqual(disposables.length, 6);
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
        test('creating the first marker turns the context on without a rescan', async () => {
            registerWorkspacePythonContext(disposables);
            await flush();
            fireCreate('/ws/app/main.py');
            await settle();
            assert.deepStrictEqual(contextValues(), [false, true]);
            assert.strictEqual(findFilesStub.callCount, 1);
        });

        test('deleting the last marker turns the context off after the debounce', async () => {
            findFilesStub.resolves([marker('/ws/main.py')]);
            registerWorkspacePythonContext(disposables);
            await flush();
            findFilesStub.resolves([]);
            fireDelete('/ws/main.py');
            await flush();
            assert.strictEqual(findFilesStub.callCount, 1, 'the rescan should wait for the debounce');
            await settle();
            assert.deepStrictEqual(contextValues(), [true, false]);
        });

        test('changing workspace folders re-evaluates the context', async () => {
            registerWorkspacePythonContext(disposables);
            await flush();
            findFilesStub.resolves([marker('/other/requirements.txt')]);
            fireFoldersChanged();
            await settle();
            assert.deepStrictEqual(contextValues(), [false, true]);
        });

        test('opening a Python document turns the context on without a rescan', async () => {
            registerWorkspacePythonContext(disposables);
            await flush();
            fireDocOpened('python');
            await settle();
            assert.deepStrictEqual(contextValues(), [false, true]);
            assert.strictEqual(findFilesStub.callCount, 1);
        });

        test('opening a non-Python document does not trigger a rescan', async () => {
            registerWorkspacePythonContext(disposables);
            await flush();
            fireDocOpened('markdown');
            await settle();
            assert.strictEqual(findFilesStub.callCount, 1);
            assert.deepStrictEqual(contextValues(), [false]);
        });

        test('only updates the context when the value changes', async () => {
            findFilesStub.resolves([marker('/ws/main.py')]);
            registerWorkspacePythonContext(disposables);
            await flush();
            fireDelete('/ws/old.py');
            await settle();
            fireCreate('/ws/new.py');
            fireDocOpened('python');
            await flush();
            assert.strictEqual(findFilesStub.callCount, 2);
            assert.deepStrictEqual(contextValues(), [true]);
        });
    });

    suite('event bursts', () => {
        test('a burst of creates does not scan the workspace', async () => {
            registerWorkspacePythonContext(disposables);
            await flush();
            for (let i = 0; i < 1000; i++) {
                fireCreate(`/ws/pkg/mod${i}.py`);
            }
            await settle();
            assert.strictEqual(findFilesStub.callCount, 1, 'only the initial scan should have run');
            assert.deepStrictEqual(contextValues(), [false, true]);
        });

        test('a burst of deletes is coalesced into one rescan', async () => {
            findFilesStub.resolves([marker('/ws/main.py')]);
            registerWorkspacePythonContext(disposables);
            await flush();
            for (let i = 0; i < 1000; i++) {
                fireDelete(`/ws/pkg/mod${i}.py`);
            }
            await clock.tickAsync(RESCAN_DEBOUNCE_MS - 1);
            assert.strictEqual(findFilesStub.callCount, 1);
            await clock.tickAsync(1);
            await flush();
            assert.strictEqual(findFilesStub.callCount, 2);
            await settle();
            assert.strictEqual(findFilesStub.callCount, 2);
        });

        test('deletes are ignored while the workspace has no Python', async () => {
            registerWorkspacePythonContext(disposables);
            await flush();
            for (let i = 0; i < 1000; i++) {
                fireDelete(`/ws/pkg/mod${i}.py`);
            }
            await settle();
            assert.strictEqual(findFilesStub.callCount, 1);
            assert.deepStrictEqual(contextValues(), [false]);
        });

        test('a burst of workspace folder changes is coalesced into one rescan', async () => {
            registerWorkspacePythonContext(disposables);
            await flush();
            for (let i = 0; i < 50; i++) {
                fireFoldersChanged();
            }
            await settle();
            assert.strictEqual(findFilesStub.callCount, 2);
        });

        test('a create cancels a pending rescan', async () => {
            findFilesStub.resolves([marker('/ws/main.py')]);
            registerWorkspacePythonContext(disposables);
            await flush();
            fireDelete('/ws/old/main.py');
            fireCreate('/ws/new/main.py');
            await settle();
            assert.strictEqual(findFilesStub.callCount, 1);
            assert.deepStrictEqual(contextValues(), [true]);
        });
    });

    suite('overlapping scans', () => {
        test('deletes during a scan rerun it once after it finishes, never concurrently', async () => {
            let inFlight = 0;
            let maxInFlight = 0;
            const pending: { resolve: (value: any[]) => void }[] = [];
            findFilesStub.callsFake(() => {
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                const deferred = makeDeferred<any[]>();
                pending.push(deferred);
                return deferred.promise.finally(() => inFlight--);
            });

            registerWorkspacePythonContext(disposables);
            pending[0].resolve([marker('/ws/main.py')]);
            await flush();

            fireDelete('/ws/a.py');
            await settle();
            assert.strictEqual(findFilesStub.callCount, 2, 'the debounced rescan should be running');

            for (let i = 0; i < 1000; i++) {
                fireDelete(`/ws/pkg/mod${i}.py`);
            }
            await settle();
            assert.strictEqual(findFilesStub.callCount, 2, 'no second scan while one is running');

            pending[1].resolve([marker('/ws/main.py')]);
            await flush();
            assert.strictEqual(findFilesStub.callCount, 3, 'exactly one follow up scan');
            pending[2].resolve([]);
            await settle();

            assert.strictEqual(findFilesStub.callCount, 3);
            assert.strictEqual(maxInFlight, 1);
            assert.deepStrictEqual(contextValues(), [true, false]);
        });

        test('a create during a scan wins over a stale empty result', async () => {
            const initial = makeDeferred<any[]>();
            findFilesStub.returns(initial.promise);

            registerWorkspacePythonContext(disposables);
            fireCreate('/ws/main.py');
            await flush();
            assert.deepStrictEqual(contextValues(), [true]);
            assert.strictEqual(tokenOfScan(0).isCancellationRequested, true, 'the stale scan should be cancelled');

            initial.resolve([]);
            await settle();
            assert.deepStrictEqual(contextValues(), [true]);
            assert.strictEqual(findFilesStub.callCount, 1);
        });

        test('a delete racing a scan is rechecked even while the context is off', async () => {
            const folderScan = makeDeferred<any[]>();
            registerWorkspacePythonContext(disposables);
            await flush();
            findFilesStub.onSecondCall().returns(folderScan.promise);
            findFilesStub.onThirdCall().resolves([]);

            fireFoldersChanged();
            await settle();
            fireDelete('/other/main.py'); // removed after the running scan already listed it
            folderScan.resolve([marker('/other/main.py')]);
            await flush();
            await settle();

            assert.strictEqual(findFilesStub.callCount, 3);
            assert.deepStrictEqual(contextValues(), [false, true, false]);
        });
    });

    suite('exclusions', () => {
        [
            '/ws/.venv/lib/python3.12/site-packages/pkg/mod.py',
            'C:\\ws\\.venv\\Lib\\site-packages\\pkg\\mod.py',
            '/ws/node_modules/tool/setup.py',
            '/ws/.git/hooks/pre-commit.py',
        ].forEach((excluded) => {
            test(`ignores create events under ${excluded}`, async () => {
                registerWorkspacePythonContext(disposables);
                await flush();
                fireCreate(excluded);
                await settle();
                assert.strictEqual(findFilesStub.callCount, 1, 'only the initial scan should have run');
                assert.deepStrictEqual(contextValues(), [false]);
            });

            test(`ignores delete events under ${excluded}`, async () => {
                findFilesStub.resolves([marker('/ws/main.py')]);
                registerWorkspacePythonContext(disposables);
                await flush();
                fireDelete(excluded);
                await settle();
                assert.strictEqual(findFilesStub.callCount, 1, 'only the initial scan should have run');
                assert.deepStrictEqual(contextValues(), [true]);
            });
        });

        test('does not ignore folders that merely look similar to an excluded one', async () => {
            registerWorkspacePythonContext(disposables);
            await flush();
            fireCreate('/ws/my-site-packages-notes/main.py');
            await flush();
            assert.deepStrictEqual(contextValues(), [false, true]);
        });
    });

    suite('disposal', () => {
        test('cancels a pending rescan', async () => {
            findFilesStub.resolves([marker('/ws/main.py')]);
            registerWorkspacePythonContext(disposables);
            await flush();
            fireDelete('/ws/main.py');
            disposables.forEach((d) => d.dispose());
            assert.strictEqual(clock.countTimers(), 0);
            await settle();
            fireDelete('/ws/other.py');
            await settle();
            assert.strictEqual(findFilesStub.callCount, 1);
        });

        test('cancels the running scan and ignores its result', async () => {
            const scan = makeDeferred<any[]>();
            findFilesStub.returns(scan.promise);
            registerWorkspacePythonContext(disposables);
            disposables.forEach((d) => d.dispose());
            assert.strictEqual(tokenOfScan(0).isCancellationRequested, true);
            scan.resolve([marker('/ws/main.py')]);
            await flush();
            assert.strictEqual(executeCommandStub.callCount, 0);
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
            fireCreate('/ws/main.py');
            await flush();
            assert.deepStrictEqual(contextValues(), [true]);
        });
    });
});
