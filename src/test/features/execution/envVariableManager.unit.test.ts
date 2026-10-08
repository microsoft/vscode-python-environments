import * as assert from 'assert';
import fsapi from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import * as workspaceApis from '../../../common/workspace.apis';
import * as envVarUtils from '../../../features/execution/envVarUtils';
import { PythonEnvVariableManager } from '../../../features/execution/envVariableManager';
import type { PythonProjectManager } from '../../../features/projectManager';

type StatResult = 'file' | 'directory' | NodeJS.ErrnoException;

function errnoError(code: string): NodeJS.ErrnoException {
    const error = new Error(code) as NodeJS.ErrnoException;
    error.code = code;
    return error;
}

suite('PythonEnvVariableManager.getEnvironmentVariables', () => {
    let sandbox: sinon.SinonSandbox;
    let parseEnvFileStub: sinon.SinonStub;
    let configuredEnvFile: string | undefined;
    let manager: PythonEnvVariableManager;

    const projectRoot = path.resolve('/workspace/project');
    const projectUri = Uri.file(projectRoot);
    const projectEnvFile = path.normalize(path.join(projectRoot, '.env'));
    const configuredFile = path.normalize(path.resolve('/config/custom.env'));

    function parsedPaths(): string[] {
        return parseEnvFileStub.getCalls().map((c) => (c.args[0] as Uri).fsPath);
    }

    function stubStat(results: Map<string, StatResult>): void {
        sandbox.stub(fsapi, 'stat').callsFake((async (p: string) => {
            const result = results.get(path.normalize(p)) ?? errnoError('ENOENT');
            if (result === 'file' || result === 'directory') {
                return { isFile: () => result === 'file' } as fsapi.Stats;
            }
            throw result;
        }) as unknown as typeof fsapi.stat);
    }

    setup(() => {
        sandbox = sinon.createSandbox();
        configuredEnvFile = undefined;

        const mockWatcher = {
            onDidCreate: () => ({ dispose: () => {} }),
            onDidChange: () => ({ dispose: () => {} }),
            onDidDelete: () => ({ dispose: () => {} }),
            dispose: () => {},
        };
        sandbox.stub(workspaceApis, 'createFileSystemWatcher').returns(mockWatcher as never);
        sandbox.stub(workspaceApis, 'getWorkspaceFolder').returns(undefined);
        sandbox.stub(workspaceApis, 'getWorkspaceFolders').returns(undefined);
        sandbox.stub(workspaceApis, 'getConfiguration').returns({
            get: (key: string) => (key === 'envFile' ? configuredEnvFile : undefined),
        } as never);

        parseEnvFileStub = sandbox.stub(envVarUtils, 'parseEnvFile');
        parseEnvFileStub.callsFake(async (uri: Uri) => {
            const p = path.normalize(uri.fsPath);
            if (p === projectEnvFile) {
                return { PROJECT_VAR: 'project', SHARED: 'from-project' };
            }
            return { CONFIG_VAR: 'config', SHARED: 'from-config' };
        });

        const pm = {
            get: () => ({ name: 'project', uri: projectUri }),
        } as unknown as PythonProjectManager;
        manager = new PythonEnvVariableManager(pm);
    });

    teardown(() => {
        manager.dispose();
        sandbox.restore();
    });

    test('project .env directory with missing configured file does not throw and leaves base unchanged', async () => {
        configuredEnvFile = configuredFile;
        stubStat(new Map<string, StatResult>([[projectEnvFile, 'directory']]));
        const base = { BASE: 'base' };

        const env = await manager.getEnvironmentVariables(projectUri, undefined, base);

        assert.deepStrictEqual(env, { BASE: 'base' });
        assert.deepStrictEqual(parsedPaths(), []);
    });

    test('configured env file that is a directory is skipped while project .env still loads', async () => {
        configuredEnvFile = configuredFile;
        stubStat(
            new Map<string, StatResult>([
                [configuredFile, 'directory'],
                [projectEnvFile, 'file'],
            ]),
        );

        const env = await manager.getEnvironmentVariables(projectUri, undefined, { BASE: 'base' });

        assert.deepStrictEqual(parsedPaths(), [projectEnvFile]);
        assert.strictEqual(env.PROJECT_VAR, 'project');
        assert.strictEqual(env.CONFIG_VAR, undefined);
    });

    test('valid configured file is loaded when project .env is a directory', async () => {
        configuredEnvFile = configuredFile;
        stubStat(
            new Map<string, StatResult>([
                [configuredFile, 'file'],
                [projectEnvFile, 'directory'],
            ]),
        );

        const env = await manager.getEnvironmentVariables(projectUri, undefined, { BASE: 'base' });

        assert.deepStrictEqual(parsedPaths(), [configuredFile]);
        assert.strictEqual(env.CONFIG_VAR, 'config');
        assert.strictEqual(env.SHARED, 'from-config');
    });

    test('when both are regular files, configured file is applied before project .env', async () => {
        configuredEnvFile = configuredFile;
        stubStat(
            new Map<string, StatResult>([
                [configuredFile, 'file'],
                [projectEnvFile, 'file'],
            ]),
        );

        const env = await manager.getEnvironmentVariables(projectUri, undefined, { BASE: 'base' });

        assert.deepStrictEqual(parsedPaths(), [configuredFile, projectEnvFile]);
        assert.strictEqual(env.SHARED, 'from-project');
        assert.strictEqual(env.PROJECT_VAR, 'project');
    });

    test('missing paths and ENOTDIR are skipped without parsing', async () => {
        configuredEnvFile = configuredFile;
        stubStat(new Map<string, StatResult>([[configuredFile, errnoError('ENOTDIR')]]));
        const base = { BASE: 'base' };

        const env = await manager.getEnvironmentVariables(projectUri, undefined, base);

        assert.deepStrictEqual(env, { BASE: 'base' });
        assert.deepStrictEqual(parsedPaths(), []);
    });

    test('unexpected stat errors such as EACCES are propagated', async () => {
        stubStat(new Map<string, StatResult>([[projectEnvFile, errnoError('EACCES')]]));

        await assert.rejects(
            manager.getEnvironmentVariables(projectUri, undefined, { BASE: 'base' }),
            (err: NodeJS.ErrnoException) => err.code === 'EACCES',
        );
        assert.deepStrictEqual(parsedPaths(), []);
    });

    suite('symlinks', () => {
        let tmpDir: string;

        setup(async () => {
            tmpDir = await fsapi.mkdtemp(path.join(os.tmpdir(), 'envvarmgr-'));
        });

        teardown(async () => {
            await fsapi.remove(tmpDir);
        });

        async function trySymlink(target: string, link: string, type: 'file' | 'dir'): Promise<boolean> {
            try {
                await fsapi.symlink(target, link, type);
                return true;
            } catch {
                return false;
            }
        }

        test('symlink to a regular file is accepted', async function () {
            const target = path.join(tmpDir, 'real.env');
            const link = path.join(tmpDir, 'link.env');
            await fsapi.writeFile(target, 'CONFIG_VAR=config\n');
            if (!(await trySymlink(target, link, 'file'))) {
                this.skip();
            }
            configuredEnvFile = link;

            const env = await manager.getEnvironmentVariables(projectUri, undefined, { BASE: 'base' });

            assert.deepStrictEqual(parsedPaths(), [path.normalize(link)]);
            assert.strictEqual(env.CONFIG_VAR, 'config');
        });

        test('symlink to a directory is skipped', async function () {
            const target = path.join(tmpDir, 'realdir');
            const link = path.join(tmpDir, 'linkdir');
            await fsapi.mkdir(target);
            if (!(await trySymlink(target, link, 'dir'))) {
                this.skip();
            }
            configuredEnvFile = link;

            const env = await manager.getEnvironmentVariables(projectUri, undefined, { BASE: 'base' });

            assert.deepStrictEqual(env, { BASE: 'base' });
            assert.deepStrictEqual(parsedPaths(), []);
        });
    });
});
