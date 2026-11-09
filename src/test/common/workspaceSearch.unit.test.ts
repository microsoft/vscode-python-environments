import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { CancellationToken, CancellationTokenSource, RelativePattern, Uri, WorkspaceFolder } from 'vscode';
import * as logging from '../../common/logging';
import * as pathUtils from '../../common/utils/pathUtils';
import { isWindows } from '../../common/utils/platformUtils';
import * as wapi from '../../common/workspace.apis';
import { findFilesInWorkspace, WORKSPACE_SEARCH_TIMEOUT_MS } from '../../common/workspaceSearch';

suite('findFilesInWorkspace', () => {
    const root = path.parse(process.cwd()).root;
    const home = path.join(root, 'home', 'tester');
    const work = path.join(root, 'work', 'repo');
    const options = { label: 'Test search', include: '**/pyproject.toml', exclude: '**/.venv/**', maxResults: 3 };
    let findFilesStub: sinon.SinonStub;
    let getWorkspaceFoldersStub: sinon.SinonStub;
    let traceLogStub: sinon.SinonStub;
    let traceWarnStub: sinon.SinonStub;

    function folder(fsPath: string, index = 0): WorkspaceFolder {
        return { uri: Uri.file(fsPath), name: path.basename(fsPath), index };
    }

    /** Makes findFiles return a search that only ends when its token is cancelled. */
    function searchUntilCancelled(): void {
        findFilesStub.callsFake(
            (_include, _exclude, _maxResults, token: CancellationToken) =>
                new Promise<Uri[]>((resolve) => token.onCancellationRequested(() => resolve([]))),
        );
    }

    setup(() => {
        findFilesStub = sinon.stub(wapi, 'findFiles').resolves([]);
        getWorkspaceFoldersStub = sinon.stub(wapi, 'getWorkspaceFolders').returns([folder(work)]);
        sinon.stub(pathUtils, 'getUserHomeDir').returns(home);
        traceLogStub = sinon.stub(logging, 'traceLog');
        traceWarnStub = sinon.stub(logging, 'traceWarn');
    });

    teardown(() => {
        sinon.restore();
    });

    test('runs one search with the given pattern, cap and a live token when no folder is the home folder', async () => {
        const marker = Uri.file(path.join(work, 'pyproject.toml'));
        findFilesStub.resolves([marker]);

        const result = await findFilesInWorkspace(options);

        assert.deepStrictEqual(result, [marker]);
        assert.strictEqual(findFilesStub.callCount, 1);
        const [include, exclude, maxResults, token] = findFilesStub.firstCall.args;
        assert.strictEqual(include, options.include);
        assert.strictEqual(exclude, options.exclude);
        assert.strictEqual(maxResults, options.maxResults);
        assert.ok(token, 'the search should get a token');
        assert.ok(traceLogStub.notCalled);
    });

    [
        { name: 'is the home folder', fsPath: home },
        { name: 'contains the home folder', fsPath: path.dirname(home) },
        {
            name: 'is the home folder written with a trailing separator or another case',
            fsPath: (isWindows() ? home.toUpperCase() : home) + path.sep,
        },
    ].forEach(({ name, fsPath }) => {
        test(`skips a workspace folder that ${name} and logs why`, async () => {
            getWorkspaceFoldersStub.returns([folder(fsPath)]);

            const result = await findFilesInWorkspace(options);

            assert.deepStrictEqual(result, []);
            assert.ok(findFilesStub.notCalled, 'the folder should not be searched');
            assert.strictEqual(traceLogStub.callCount, 1);
            const message = String(traceLogStub.firstCall.args[0]);
            assert.ok(message.includes(Uri.file(fsPath).fsPath), message);
            assert.ok(message.includes('home folder'), message);
        });
    });

    test('searches a folder inside the home folder', async () => {
        getWorkspaceFoldersStub.returns([folder(path.join(home, 'code', 'app'))]);

        await findFilesInWorkspace(options);

        assert.strictEqual(findFilesStub.callCount, 1);
        assert.ok(traceLogStub.notCalled);
    });

    test('searches each other workspace folder on its own and caps the merged results', async () => {
        const other = path.join(root, 'work', 'other');
        getWorkspaceFoldersStub.returns([folder(home, 0), folder(work, 1), folder(other, 2)]);
        findFilesStub.callsFake((include: RelativePattern) =>
            Promise.resolve([
                Uri.file(path.join(include.baseUri.fsPath, 'a', 'pyproject.toml')),
                Uri.file(path.join(include.baseUri.fsPath, 'b', 'pyproject.toml')),
            ]),
        );

        const result = await findFilesInWorkspace(options);

        const bases = findFilesStub.getCalls().map((call) => {
            const include = call.args[0];
            assert.ok(include instanceof RelativePattern, 'each search should be scoped to one folder');
            assert.strictEqual(include.pattern, options.include);
            return pathUtils.normalizePath(include.baseUri.fsPath);
        });
        assert.deepStrictEqual(bases, [pathUtils.normalizePath(work), pathUtils.normalizePath(other)]);
        assert.strictEqual(result.length, options.maxResults);
        assert.ok(traceWarnStub.calledOnce, 'reaching the cap should be logged');
    });

    test('cancels the search at the time limit and logs it', async () => {
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            searchUntilCancelled();
            const pending = findFilesInWorkspace(options);
            const token: CancellationToken = findFilesStub.firstCall.args[3];

            await clock.tickAsync(WORKSPACE_SEARCH_TIMEOUT_MS - 1);
            assert.strictEqual(token.isCancellationRequested, false);
            await clock.tickAsync(1);

            assert.strictEqual(token.isCancellationRequested, true);
            assert.deepStrictEqual(await pending, []);
            assert.ok(traceWarnStub.calledOnce, 'the time limit should be logged');
        } finally {
            clock.restore();
        }
    });

    test('cancels the search with the caller token and clears the time limit', async () => {
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const source = new CancellationTokenSource();
        try {
            searchUntilCancelled();
            const pending = findFilesInWorkspace({ ...options, token: source.token });
            const token: CancellationToken = findFilesStub.firstCall.args[3];
            assert.notStrictEqual(token, source.token, 'the time limit needs its own token');

            source.cancel();

            assert.strictEqual(token.isCancellationRequested, true);
            assert.deepStrictEqual(await pending, []);
            assert.strictEqual(clock.countTimers(), 0);
            assert.ok(traceWarnStub.notCalled, 'a caller cancel is not a time limit');
        } finally {
            source.dispose();
            clock.restore();
        }
    });

    test('passes a cancelled token when the caller token is already cancelled', async () => {
        const source = new CancellationTokenSource();
        source.cancel();
        try {
            await findFilesInWorkspace({ ...options, token: source.token });

            assert.strictEqual(findFilesStub.firstCall.args[3].isCancellationRequested, true);
        } finally {
            source.dispose();
        }
    });
});
