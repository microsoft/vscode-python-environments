/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from 'assert';
import * as sinon from 'sinon';
import { FileType, Uri } from 'vscode';
import * as commandApis from '../../../common/command.api';
import * as logging from '../../../common/logging';
import * as workspaceApis from '../../../common/workspace.apis';
import * as workspaceFs from '../../../common/workspace.fs.apis';
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

const marker = (fsPath: string) => Uri.file(fsPath);

suite('Workspace Python context', () => {
    let clock: sinon.SinonFakeTimers;
    let findFilesStub: sinon.SinonStub;
    let openDocsStub: sinon.SinonStub;
    let executeCommandStub: sinon.SinonStub;
    let traceErrorStub: sinon.SinonStub;
    let statStub: sinon.SinonStub;
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
        statStub = sinon.stub(workspaceFs, 'stat').callsFake((uri: any) =>
            Promise.resolve({
                type: uri.fsPath.endsWith('tools.py') ? FileType.Directory : FileType.File,
                ctime: 0,
                mtime: 0,
                size: 0,
            }),
        );

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

        test('publishes the initial search despite deletes of other markers', async () => {
            const pending = makeDeferred<any[]>();
            findFilesStub.onFirstCall().returns(pending.promise);
            registerWorkspacePythonContext(disposables);
            for (let i = 0; i < 10; i++) {
                fireDelete(`/ws/tmp${i}.py`);
                await clock.tickAsync(RESCAN_DEBOUNCE_MS);
            }
            pending.resolve([marker('/ws/main.py')]);
            await settle();
            assert.deepStrictEqual(contextValues(), [true]);
            assert.strictEqual(findFilesStub.callCount, 1);
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

        test('creating a marker-named directory does not turn the context on', async () => {
            registerWorkspacePythonContext(disposables);
            await flush();
            fireCreate('/ws/tools.py');
            await flush();
            assert.deepStrictEqual(contextValues(), [false]);
            assert.strictEqual(findFilesStub.callCount, 1);
        });

        test('a delete after create cancels an unconfirmed file event', async () => {
            registerWorkspacePythonContext(disposables);
            await flush();
            fireCreate('/ws/main.py');
            fireDelete('/ws/main.py');
            await flush();
            assert.deepStrictEqual(contextValues(), [false]);
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

        test('deleting other markers does not search while the found marker remains', async () => {
            findFilesStub.resolves([marker('/ws/main.pyi')]);
            registerWorkspacePythonContext(disposables);
            await flush();
            for (let i = 0; i < 5; i++) {
                fireCreate(`/ws/tmp${i}.py`);
                await settle();
                fireDelete(`/ws/tmp${i}.py`);
                await settle();
            }
            fireDelete('/ws/main.py'); // a prefix of the found marker's path, but neither it nor a parent folder
            await settle();
            assert.strictEqual(findFilesStub.callCount, 1);
            const inspected = new Set(statStub.getCalls().map((c) => c.args[0].toString()));
            assert.deepStrictEqual(
                [...inspected],
                [marker('/ws/main.pyi').toString()],
                'only the found marker is re-checked',
            );
            assert.deepStrictEqual(contextValues(), [true]);
        });

        test('a found marker removed without a delete event is caught by a later delete', async () => {
            findFilesStub.resolves([marker('/ws/scripts/main.py')]);
            registerWorkspacePythonContext(disposables);
            await flush();
            // Deleting `scripts` is not reported, because the folder name does not match the glob.
            statStub.rejects(Object.assign(new Error('gone'), { code: 'FileNotFound' }));
            findFilesStub.resolves([]);
            fireDelete('/ws/other.py');
            await settle(); // re-checks the found marker
            await settle(); // rescans
            assert.strictEqual(findFilesStub.callCount, 2);
            assert.strictEqual(traceErrorStub.callCount, 0);
            assert.deepStrictEqual(contextValues(), [true, false]);
        });

        test('deleting the folder containing the found marker turns the context off', async () => {
            findFilesStub.resolves([marker('/ws/tools.py/main.py')]);
            registerWorkspacePythonContext(disposables);
            await flush();
            findFilesStub.resolves([]);
            fireDelete('/ws/tools.py');
            await settle();
            assert.deepStrictEqual(contextValues(), [true, false]);
        });

        test('a delete only invalidates the pending check for the same URI', async () => {
            const pending = makeDeferred<any>();
            statStub.returns(pending.promise);
            const created = marker('/ws/main.py').with({ scheme: 'vscode-remote', authority: 'first' });
            registerWorkspacePythonContext(disposables);
            await flush();
            (watcher.onDidCreate.firstCall.args[0] as Listener<any>)(created);
            (watcher.onDidDelete.firstCall.args[0] as Listener<any>)(created.with({ authority: 'second' }));
            pending.resolve({ type: FileType.File, ctime: 0, mtime: 0, size: 0 });
            await flush();
            assert.deepStrictEqual(contextValues(), [false, true]);
        });

        test('changing workspace folders re-evaluates the context', async () => {
            registerWorkspacePythonContext(disposables);
            await flush();
            findFilesStub.resolves([marker('/other/requirements.txt')]);
            fireFoldersChanged();
            await settle();
            assert.deepStrictEqual(contextValues(), [false, true]);
        });

        test('a workspace change invalidates pending marker checks', async () => {
            const pending = makeDeferred<any>();
            statStub.returns(pending.promise);
            registerWorkspacePythonContext(disposables);
            await flush();
            fireCreate('/ws/main.py');
            fireFoldersChanged();
            pending.resolve({ type: FileType.File, ctime: 0, mtime: 0, size: 0 });
            await settle();
            assert.deepStrictEqual(contextValues(), [false]);
            assert.strictEqual(findFilesStub.callCount, 2);
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
            fireDelete('/ws/main.py');
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

        test('creates are not inspected while the workspace is known to have Python', async () => {
            findFilesStub.resolves([marker('/ws/main.py')]);
            registerWorkspacePythonContext(disposables);
            await flush();
            for (let i = 0; i < 1000; i++) {
                fireCreate(`/ws/pkg/mod${i}.py`);
            }
            await settle();
            assert.strictEqual(statStub.callCount, 0);
            assert.strictEqual(findFilesStub.callCount, 1);
        });

        test('repeated create events for the same marker are inspected once', async () => {
            const pending = makeDeferred<any>();
            statStub.returns(pending.promise);
            registerWorkspacePythonContext(disposables);
            await flush();
            fireCreate('/ws/main.py');
            fireCreate('/ws/main.py');
            assert.strictEqual(statStub.callCount, 1);
            pending.resolve({ type: FileType.File, ctime: 0, mtime: 0, size: 0 });
            await flush();
            assert.deepStrictEqual(contextValues(), [false, true]);
        });

        test('a burst of deletes is coalesced into one rescan', async () => {
            findFilesStub.resolves([marker('/ws/main.py')]);
            registerWorkspacePythonContext(disposables);
            await flush();
            for (let i = 0; i < 1000; i++) {
                fireDelete(i === 0 ? '/ws/main.py' : `/ws/pkg/mod${i}.py`);
            }
            await clock.tickAsync(RESCAN_DEBOUNCE_MS - 1);
            assert.strictEqual(findFilesStub.callCount, 1);
            await clock.tickAsync(1);
            await flush();
            assert.strictEqual(findFilesStub.callCount, 2);
            await settle();
            assert.strictEqual(findFilesStub.callCount, 2);
        });

        test('a burst of deletes re-checks the found marker once', async () => {
            findFilesStub.resolves([marker('/ws/main.py')]);
            registerWorkspacePythonContext(disposables);
            await flush();
            for (let i = 0; i < 1000; i++) {
                fireDelete(`/ws/pkg/mod${i}.py`);
            }
            await settle();
            await settle();
            assert.strictEqual(statStub.callCount, 1);
            assert.strictEqual(findFilesStub.callCount, 1);
            assert.deepStrictEqual(contextValues(), [true]);
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
            fireDelete('/ws/main.py');
            fireCreate('/ws/new/main.py');
            await settle();
            assert.strictEqual(findFilesStub.callCount, 1);
            assert.deepStrictEqual(contextValues(), [true]);

            findFilesStub.resolves([]);
            fireDelete('/ws/new/main.py');
            await settle();
            assert.strictEqual(findFilesStub.callCount, 2);
            assert.deepStrictEqual(contextValues(), [true, false]);
        });
    });

    suite('overlapping scans', () => {
        test('a result deleted during its scan is rechecked once, never concurrently', async () => {
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

            fireDelete('/ws/main.py');
            await settle();
            assert.strictEqual(findFilesStub.callCount, 2, 'the debounced rescan should be running');

            for (let i = 0; i < 1000; i++) {
                fireDelete(`/ws/pkg/mod${i}.py`);
            }
            await settle();
            assert.strictEqual(findFilesStub.callCount, 2, 'no second scan while one is running');

            pending[1].resolve([marker('/ws/pkg/mod0.py')]);
            await settle();
            assert.strictEqual(findFilesStub.callCount, 3, 'exactly one follow up scan');
            pending[2].resolve([]);
            await settle();

            assert.strictEqual(findFilesStub.callCount, 3);
            assert.strictEqual(maxInFlight, 1);
            assert.deepStrictEqual(contextValues(), [true, false]);
        });

        test('an empty result is kept when other markers are deleted during its scan', async () => {
            const rescan = makeDeferred<any[]>();
            findFilesStub.onFirstCall().resolves([marker('/ws/main.py')]);
            findFilesStub.onSecondCall().returns(rescan.promise);
            registerWorkspacePythonContext(disposables);
            await flush();
            fireDelete('/ws/main.py');
            await settle();
            fireDelete('/ws/other.py');
            rescan.resolve([]);
            await settle();
            assert.strictEqual(findFilesStub.callCount, 2);
            assert.deepStrictEqual(contextValues(), [true, false]);
        });

        test('a slow search is never abandoned', async () => {
            const slowScan = makeDeferred<any[]>();
            registerWorkspacePythonContext(disposables);
            await flush();
            findFilesStub.onSecondCall().returns(slowScan.promise);
            fireFoldersChanged();
            await settle();
            await clock.tickAsync(60_000);
            assert.strictEqual(tokenOfScan(1).isCancellationRequested, false);
            slowScan.resolve([marker('/other/main.py')]);
            await flush();
            assert.deepStrictEqual(contextValues(), [false, true]);
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

        test('deleting a created marker while its cancelled scan finishes triggers a rescan', async () => {
            const initial = makeDeferred<any[]>();
            findFilesStub.onFirstCall().returns(initial.promise);
            findFilesStub.onSecondCall().resolves([]);
            registerWorkspacePythonContext(disposables);
            fireCreate('/ws/main.py');
            await flush();
            fireDelete('/ws/main.py');
            initial.resolve([]);
            await settle();
            assert.strictEqual(findFilesStub.callCount, 2);
            assert.deepStrictEqual(contextValues(), [true, false]);
        });

        test('a delete while a cancelled scan finishes triggers a rescan', async () => {
            const initial = makeDeferred<any[]>();
            findFilesStub.onFirstCall().returns(initial.promise);
            findFilesStub.onSecondCall().resolves([]);
            registerWorkspacePythonContext(disposables);
            fireDocOpened('python');
            await flush();
            assert.strictEqual(tokenOfScan(0).isCancellationRequested, true);

            fireDelete('/ws/main.py');
            initial.resolve([]);
            await settle();
            assert.strictEqual(findFilesStub.callCount, 2);
            assert.deepStrictEqual(contextValues(), [true, false]);
        });

        test('a workspace change cancels a scan for the previous workspace', async () => {
            const staleScan = makeDeferred<any[]>();
            findFilesStub.onFirstCall().resolves([marker('/old/main.py')]);
            findFilesStub.onSecondCall().returns(staleScan.promise);
            findFilesStub.onThirdCall().resolves([]);
            registerWorkspacePythonContext(disposables);
            await flush();

            fireFoldersChanged();
            await settle();
            fireFoldersChanged();
            assert.strictEqual(tokenOfScan(1).isCancellationRequested, true);
            staleScan.resolve([marker('/old/main.py')]);
            await flush();
            fireCreate('/new/main.py');
            await flush();
            fireDelete('/new/main.py');
            await settle();
            assert.strictEqual(findFilesStub.callCount, 3);
            assert.deepStrictEqual(contextValues(), [true, false]);
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
            assert.deepStrictEqual(contextValues(), [false]);
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
            fireDelete('/ws/other.py');
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
            assert.strictEqual(clock.countTimers(), 0);
            scan.resolve([marker('/ws/main.py')]);
            await flush();
            assert.strictEqual(executeCommandStub.callCount, 0);
        });

        test('ignores a marker stat that finishes after disposal', async () => {
            const pending = makeDeferred<any>();
            statStub.returns(pending.promise);
            registerWorkspacePythonContext(disposables);
            await flush();
            fireCreate('/ws/main.py');
            disposables.forEach((d) => d.dispose());
            pending.resolve({ type: FileType.File, ctime: 0, mtime: 0, size: 0 });
            await flush();
            assert.deepStrictEqual(contextValues(), [false]);
        });
    });

    suite('context updates', () => {
        test('a slow update is never applied after a newer one', async () => {
            const applied: boolean[] = [];
            const firstUpdate = makeDeferred<void>();
            let calls = 0;
            executeCommandStub.callsFake(async (_command: string, _key: string, value: boolean) => {
                if (++calls === 1) {
                    await firstUpdate.promise;
                }
                applied.push(value);
            });
            registerWorkspacePythonContext(disposables);
            await flush();
            fireCreate('/ws/main.py');
            await flush();
            firstUpdate.resolve();
            await flush();
            assert.deepStrictEqual(applied, [false, true]);
        });

        test('only the latest value is sent after a slow update', async () => {
            const firstUpdate = makeDeferred<void>();
            executeCommandStub.onFirstCall().returns(firstUpdate.promise);
            registerWorkspacePythonContext(disposables);
            await flush();
            fireCreate('/ws/main.py');
            await flush();
            fireDelete('/ws/main.py');
            await settle();
            firstUpdate.resolve();
            await flush();
            assert.deepStrictEqual(contextValues(), [false]);
        });

        test('no update is sent after disposal', async () => {
            const firstUpdate = makeDeferred<void>();
            executeCommandStub.onFirstCall().returns(firstUpdate.promise);
            registerWorkspacePythonContext(disposables);
            await flush();
            fireCreate('/ws/main.py');
            await flush();
            disposables.forEach((d) => d.dispose());
            firstUpdate.resolve();
            await flush();
            assert.deepStrictEqual(contextValues(), [false]);
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

        test('retries setContext after a failed create update', async () => {
            executeCommandStub.onSecondCall().rejects(new Error('setContext failed'));
            registerWorkspacePythonContext(disposables);
            await flush();
            fireCreate('/ws/main.py');
            await flush();
            fireCreate('/ws/main.py');
            await flush();
            assert.deepStrictEqual(contextValues(), [false, true, true]);
            assert.strictEqual(traceErrorStub.callCount, 1);
        });

        test('keeps working after a failed refresh', async () => {
            findFilesStub.onFirstCall().rejects(new Error('boom'));
            registerWorkspacePythonContext(disposables);
            await flush();
            fireCreate('/ws/main.py');
            await flush();
            assert.deepStrictEqual(contextValues(), [true]);
        });

        test('a marker that cannot be inspected is found by a rescan', async () => {
            statStub.rejects(new Error('stat failed'));
            registerWorkspacePythonContext(disposables);
            await flush();
            findFilesStub.resolves([marker('/ws/main.py')]);
            fireCreate('/ws/main.py');
            await flush();
            await settle();
            assert.strictEqual(traceErrorStub.callCount, 1);
            assert.deepStrictEqual(contextValues(), [false, true]);
        });

        test('a marker deleted before it is inspected is ignored', async () => {
            statStub.rejects(Object.assign(new Error('gone'), { code: 'FileNotFound' }));
            registerWorkspacePythonContext(disposables);
            await flush();
            fireCreate('/ws/tmp.py');
            await flush();
            await settle();
            assert.strictEqual(traceErrorStub.callCount, 0);
            assert.strictEqual(findFilesStub.callCount, 1);
            assert.deepStrictEqual(contextValues(), [false]);
        });

        test('a found marker that cannot be re-checked is logged and searched for', async () => {
            findFilesStub.resolves([marker('/ws/main.py')]);
            registerWorkspacePythonContext(disposables);
            await flush();
            const error = new Error('stat failed');
            statStub.rejects(error);
            fireDelete('/ws/other.py');
            await settle(); // re-checks the found marker
            await settle(); // rescans
            assert.ok(traceErrorStub.calledOnce);
            assert.strictEqual(traceErrorStub.firstCall.args[1], error);
            assert.strictEqual(findFilesStub.callCount, 2);
            assert.deepStrictEqual(contextValues(), [true]);
        });
    });
});
