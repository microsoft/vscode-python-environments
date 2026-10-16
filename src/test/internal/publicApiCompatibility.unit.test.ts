// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import { ChildProcess, type SpawnOptions } from 'child_process';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { PassThrough } from 'stream';
import { CancellationTokenSource, Disposable, EventEmitter, FileType, Uri } from 'vscode';
import { EnvironmentManager, PackageManager, PythonEnvironment, PythonEnvironmentApi } from '../../api';
import * as childProcessApis from '../../common/childProcess.apis';
import * as persistentState from '../../common/persistentState';
import * as windowApis from '../../common/window.apis';
import * as workspaceApis from '../../common/workspace.apis';
import * as workspaceFs from '../../common/workspace.fs.apis';
import { PythonEnvironmentApiImpl } from '../../extensionApi';
import * as managerReady from '../../features/common/managerReady';
import { pythonToolSupport } from '../../internal/pythonToolSupport';
import * as helpers from '../../managers/builtin/helpers';
import { PipPackageManager } from '../../managers/builtin/pipPackageManager';
import { VenvManager } from '../../managers/builtin/venvManager';
import * as packageChanges from '../../managers/common/packageChanges';
import { CondaPackageManager } from '../../managers/conda/condaPackageManager';
import * as condaUtils from '../../managers/conda/condaUtils';
import { PoetryManager } from '../../managers/poetry/poetryManager';
import { PoetryPackageManager } from '../../managers/poetry/poetryPackageManager';
import * as poetryUtils from '../../managers/poetry/poetryUtils';
import { createMockLogOutputChannel } from '../mocks/helper';

interface SpawnRecord {
    executable: string;
    args: string[];
    options: SpawnOptions;
    endInput: sinon.SinonSpy;
}

suite('Public package API execution policy', () => {
    let source: CancellationTokenSource;
    let temp: string;
    let scope: Uri;
    let environment: PythonEnvironment;
    let calls: SpawnRecord[];
    let progress: sinon.SinonStub;
    let timers: sinon.SinonSpy;
    let disposables: Disposable[];

    setup(async () => {
        source = new CancellationTokenSource();
        temp = await fs.mkdtemp(path.join(os.tmpdir(), 'python-api-compat-'));
        scope = Uri.file(temp);
        const prefix = path.join(temp, '.venv');
        await fs.ensureDir(prefix);
        const executable = path.join(prefix, process.platform === 'win32' ? 'python.exe' : 'python');
        environment = {
            envId: { id: 'test', managerId: 'ms-python.python:venv' },
            name: 'test',
            displayName: 'test',
            displayPath: executable,
            environmentPath: Uri.file(prefix),
            sysPrefix: prefix,
            execInfo: { run: { executable } },
            version: '3.13.0',
        };
        const conda = path.join(temp, 'conda');
        await fs.outputFile(conda, '');
        await condaUtils.clearCondaCache();
        sinon.stub(persistentState, 'getWorkspacePersistentState').resolves({
            get: sinon.stub().resolves(conda),
            set: sinon.stub().resolves(),
            clear: sinon.stub().resolves(),
        });
        sinon.stub(workspaceApis, 'getConfiguration').returns({
            get: <T>(key: string, fallback?: T): T => (key === 'condaPath' ? conda : fallback) as T,
            inspect: () => undefined,
            has: () => false,
            update: async () => {},
        });
        sinon.stub(poetryUtils, 'getPoetry').resolves(path.join(temp, 'poetry'));
        sinon.stub(workspaceFs, 'stat').resolves({ type: FileType.Directory, ctime: 0, mtime: 0, size: 0 });
        sinon.stub(managerReady, 'waitForEnvManagerId').resolves();
        sinon.stub(packageChanges, 'updatePackagesAndNotify').resolves([]);
        progress = sinon.stub(windowApis, 'withProgress').callsFake(async (_options, task) =>
            task({ report: () => {} }, source.token),
        );
        calls = [];
        disposables = [];
        sinon.stub(childProcessApis, 'spawnProcess').callsFake((command, args, options) => {
            const child = Object.assign(new ChildProcess(), {
                stdout: new PassThrough(),
                stderr: new PassThrough(),
                stdin: new PassThrough(),
            });
            const endInput = sinon.spy(child.stdin, 'end');
            calls.push({ executable: command, args, options: options ?? {}, endInput });
            setImmediate(() => {
                const output = args.includes('info') ? prefix : args.includes('list') ? '[]' : '';
                child.stdout.emit('data', Buffer.from(output));
                child.emit('exit', 0, null);
                child.emit('close', 0, null);
            });
            return child;
        });
        timers = sinon.spy(global, 'setTimeout');
    });

    teardown(async () => {
        disposables.forEach((item) => item.dispose());
        source.dispose();
        sinon.restore();
        await condaUtils.clearCondaCache();
        await fs.remove(temp);
    });

    function publicApi(manager: PackageManager): PythonEnvironmentApi {
        const event = () => {
            const emitter = new EventEmitter<void>();
            disposables.push(emitter);
            return emitter.event;
        };
        type Args = ConstructorParameters<typeof PythonEnvironmentApiImpl>;
        return new PythonEnvironmentApiImpl(
            {
                onDidChangeActiveEnvironment: event(),
                onDidChangePackageProviderPackages: event(),
                getPackageManager: () => manager,
            } as unknown as Args[0],
            { getProjects: () => [], onDidChangeProjects: event() } as unknown as Args[1],
            {} as Args[2],
            {} as Args[3],
            { onDidChangeEnvironmentVariables: event() } as unknown as Args[4],
            disposables,
        );
    }

    for (const kind of ['pip', 'uv', 'conda', 'poetry'] as const) {
        function manager() {
            const api = {} as PythonEnvironmentApi;
            const log = createMockLogOutputChannel();
            if (kind === 'conda') {
                return new CondaPackageManager(api, log);
            }
            if (kind === 'poetry') {
                return new PoetryPackageManager(api, log, {} as PoetryManager).createForProject({
                    name: 'project',
                    uri: scope,
                });
            }
            sinon.stub(helpers, 'shouldUseUv').resolves(kind === 'uv');
            sinon.stub(helpers, 'getUvExecutable').resolves(path.join(temp, '.pyprojectx', 'main', 'uv'));
            return new PipPackageManager(api, log, {} as VenvManager);
        }

        test(`${kind}: public progress tokens do not enable agent process policy`, async () => {
            await publicApi(manager()).managePackages(environment, { install: ['requests'] });
            assert.ok(progress.calledOnce);
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].options.timeout, undefined);
            assert.strictEqual(calls[0].options.env, undefined);
            assert.strictEqual(calls[0].options.detached, undefined);
            assert.ok(calls[0].endInput.notCalled);
            assert.ok(!calls[0].args.includes('--no-interaction'));
            assert.ok(!timers.getCalls().some((call) => call.args[1] === 300_000));
            if (kind === 'uv') {
                assert.strictEqual(calls[0].executable, path.join(temp, '.pyprojectx', 'main', 'uv'));
            }
        });

        test(`${kind}: private capabilities explicitly enable agent process policy`, async () => {
            await manager()[pythonToolSupport].manage(environment, { install: ['requests'] }, source.token, scope);
            assert.ok(progress.notCalled);
            assert.ok(calls.length >= 1);
            for (const call of calls) {
                assert.strictEqual(call.options.env?.PIP_NO_INPUT, '1');
                assert.ok(call.endInput.calledOnce);
                if (kind === 'poetry') {
                    assert.strictEqual(call.args[0], '--no-interaction');
                }
                if (kind === 'uv') {
                    assert.strictEqual(call.executable, path.join(temp, '.pyprojectx', 'main', 'uv'));
                }
            }
            if (kind === 'poetry') {
                assert.ok(calls.some((call) => call.args.includes('install') && call.args.includes('--no-root')));
            }
            assert.ok(timers.getCalls().some((call) => call.args[1] === 300_000));
        });
    }

    test('an existing explicit public process timeout is preserved without opting into tool policy', async () => {
        await helpers.runPython('python', ['-c', 'pass'], temp, undefined, source.token, 42);
        assert.strictEqual(calls[0].options.timeout, 42);
        assert.strictEqual(calls[0].options.env, undefined);
        assert.ok(calls[0].endInput.notCalled);
    });

    for (const toolExecution of [false, true]) {
        test(`Conda quick-create ${toolExecution ? 'preserves the tool base version' : 'keeps public version selection unchanged'}`, async () => {
            const prefix = path.join(temp, '.conda');
            await fs.outputJson(path.join(prefix, 'conda-meta', 'python-3.13.0-0.json'), { version: '3.13.0' });
            const api: Partial<PythonEnvironmentApi> = {
                createPythonEnvironmentItem: sinon.stub().returns(environment),
            };
            await condaUtils.quickCreateConda(
                api as PythonEnvironmentApi,
                createMockLogOutputChannel(),
                { name: 'conda' } as EnvironmentManager,
                temp,
                '.conda',
                undefined,
                toolExecution
                    ? {
                          token: source.token,
                          baseEnvironment: environment,
                          getGlobalEnvironments: sinon.stub().resolves([]),
                          managePackages: sinon.stub().resolves(),
                      }
                    : undefined,
            );
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].args.at(-1), toolExecution ? 'python=3.13' : 'python');
            assert.strictEqual(progress.callCount, toolExecution ? 0 : 1);
        });
    }
});
