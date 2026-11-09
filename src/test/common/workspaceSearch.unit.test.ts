import assert from 'assert';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { CancellationToken, CancellationTokenSource, RelativePattern, Uri, WorkspaceFolder } from 'vscode';
import * as logging from '../../common/logging';
import * as pathUtils from '../../common/utils/pathUtils';
import { isWindows } from '../../common/utils/platformUtils';
import * as wapi from '../../common/workspace.apis';
import { findFilesInWorkspace } from '../../common/workspaceSearch';

suite('findFilesInWorkspace', () => {
    const root = path.parse(process.cwd()).root;
    const home = path.join(root, 'home', 'tester');
    const work = path.join(root, 'work', 'repo');
    const options = { label: 'Test search', include: '**/pyproject.toml', exclude: '**/.venv/**', maxResults: 3 };
    let findFilesStub: sinon.SinonStub;
    let getWorkspaceFoldersStub: sinon.SinonStub;
    let traceLogStub: sinon.SinonStub;
    let traceWarnStub: sinon.SinonStub;
    let getUserHomeDirStub: sinon.SinonStub;

    function folder(fsPath: string, index = 0): WorkspaceFolder {
        return { uri: Uri.file(fsPath), name: path.basename(fsPath), index };
    }

    /**
     * Makes a findFiles fake that returns `uris` after `delayMs`. Like VS Code, it returns an empty
     * list as soon as its token is cancelled, not the matches found so far.
     */
    function resolvesUnlessCancelled(delayMs: number, uris: Uri[]) {
        return (_include: unknown, _exclude: unknown, _maxResults: unknown, token?: CancellationToken) =>
            new Promise<Uri[]>((resolve) => {
                token?.onCancellationRequested(() => resolve([]));
                setTimeout(() => resolve(uris), delayMs);
            });
    }

    setup(() => {
        findFilesStub = sinon.stub(wapi, 'findFiles').resolves([]);
        getWorkspaceFoldersStub = sinon.stub(wapi, 'getWorkspaceFolders').returns([folder(work)]);
        getUserHomeDirStub = sinon.stub(pathUtils, 'getUserHomeDir').returns(home);
        traceLogStub = sinon.stub(logging, 'traceLog');
        traceWarnStub = sinon.stub(logging, 'traceWarn');
    });

    teardown(() => {
        sinon.restore();
    });

    test('runs one search with the given pattern, cap and token when no folder is the home folder', async () => {
        const marker = Uri.file(path.join(work, 'pyproject.toml'));
        findFilesStub.resolves([marker]);
        const source = new CancellationTokenSource();

        try {
            const result = await findFilesInWorkspace({ ...options, token: source.token });

            assert.deepStrictEqual(result, [marker]);
            assert.strictEqual(findFilesStub.callCount, 1);
            const [include, exclude, maxResults, token] = findFilesStub.firstCall.args;
            assert.strictEqual(include, options.include);
            assert.strictEqual(exclude, options.exclude);
            assert.strictEqual(maxResults, options.maxResults);
            assert.strictEqual(token, source.token);
            assert.ok(traceLogStub.notCalled);
        } finally {
            source.dispose();
        }
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

    test('returns every match of a search that runs for minutes', async () => {
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const marker = Uri.file(path.join(work, 'pyproject.toml'));
            findFilesStub.callsFake(resolvesUnlessCancelled(10 * 60_000, [marker]));
            const pending = findFilesInWorkspace(options);

            await clock.tickAsync(10 * 60_000);

            assert.deepStrictEqual(await pending, [marker]);
            assert.ok(traceWarnStub.notCalled);
        } finally {
            clock.restore();
        }
    });

    test('passes the caller token to each search', async () => {
        const source = new CancellationTokenSource();
        try {
            getWorkspaceFoldersStub.returns([folder(home, 0), folder(work, 1), folder(path.join(root, 'other'), 2)]);

            await findFilesInWorkspace({ ...options, token: source.token });

            assert.strictEqual(findFilesStub.callCount, 2);
            for (const call of findFilesStub.getCalls()) {
                assert.strictEqual(call.args[3], source.token);
            }
        } finally {
            source.dispose();
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

    suite('needed folders inside a home folder workspace', () => {
        let diskHome: string;
        let app: string;

        /** Returns the normalized base folder of each findFiles call. */
        function searchedBases(): string[] {
            return findFilesStub.getCalls().map((call) => {
                const include = call.args[0];
                assert.ok(include instanceof RelativePattern, 'each search should be scoped to one folder');
                assert.strictEqual(include.pattern, options.include);
                return pathUtils.normalizePath(include.baseUri.fsPath);
            });
        }

        setup(async () => {
            diskHome = await fse.mkdtemp(path.join(os.tmpdir(), 'workspace-search-home-'));
            app = path.join(diskHome, 'code', 'app');
            await fse.ensureDir(path.join(app, 'sub'));
            getUserHomeDirStub.returns(diskHome);
            getWorkspaceFoldersStub.returns([folder(diskHome)]);
        });

        teardown(async () => {
            await fse.remove(diskHome);
        });

        test('searches only the needed folders inside it and logs why', async () => {
            const marker = Uri.file(path.join(app, 'pyproject.toml'));
            findFilesStub.resolves([marker]);

            const result = await findFilesInWorkspace({ ...options, neededFolders: [Uri.file(app)] });

            assert.deepStrictEqual(result, [marker]);
            assert.deepStrictEqual(searchedBases(), [pathUtils.normalizePath(app)]);
            assert.strictEqual(traceLogStub.callCount, 1);
            const message = String(traceLogStub.firstCall.args[0]);
            assert.ok(message.includes(Uri.file(diskHome).fsPath), message);
            assert.ok(message.includes(Uri.file(app).fsPath), message);
        });

        test('does not search a needed folder that is the home folder or contains it', async () => {
            const result = await findFilesInWorkspace({
                ...options,
                neededFolders: [Uri.file(diskHome), Uri.file(path.dirname(diskHome))],
            });

            assert.deepStrictEqual(result, []);
            assert.ok(findFilesStub.notCalled);
        });

        test('does not search a needed path that is a file or does not exist', async () => {
            const script = path.join(diskHome, 'script.py');
            await fse.outputFile(script, 'print(1)\n');

            await findFilesInWorkspace({
                ...options,
                neededFolders: [Uri.file(script), Uri.file(path.join(diskHome, 'missing'))],
            });

            assert.ok(findFilesStub.notCalled);
        });

        test('searches a folder once when it sits inside another needed folder or two home folders', async () => {
            getWorkspaceFoldersStub.returns([folder(path.dirname(diskHome), 0), folder(diskHome, 1)]);

            await findFilesInWorkspace({
                ...options,
                neededFolders: [Uri.file(path.join(app, 'sub')), Uri.file(app), Uri.file(app)],
            });

            assert.deepStrictEqual(searchedBases(), [pathUtils.normalizePath(app)]);
        });

        test('searches the other workspace folders whole', async () => {
            getWorkspaceFoldersStub.returns([folder(diskHome, 0), folder(work, 1)]);

            await findFilesInWorkspace({ ...options, neededFolders: [Uri.file(path.join(work, 'service'))] });

            assert.deepStrictEqual(searchedBases(), [pathUtils.normalizePath(work)]);
        });
    });
});
