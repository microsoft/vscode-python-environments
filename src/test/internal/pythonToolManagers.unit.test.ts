// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { CancellationError, CancellationTokenSource, FileType, Uri } from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi } from '../../api';
import * as windowApis from '../../common/window.apis';
import * as workspaceApis from '../../common/workspace.apis';
import * as workspaceFs from '../../common/workspace.fs.apis';
import { normalizePath } from '../../common/utils/pathUtils';
import {
    PythonToolError,
    pythonToolSupport,
    resolveToolProjectEnvironment,
} from '../../internal/pythonToolSupport';
import * as cache from '../../managers/builtin/cache';
import { PipInstallCommand, PipListCommand } from '../../managers/builtin/commands';
import * as helpers from '../../managers/builtin/helpers';
import { PipPackageManager } from '../../managers/builtin/pipPackageManager';
import * as pythonInstaller from '../../managers/builtin/pythonInstaller';
import { SysPythonManager } from '../../managers/builtin/sysPythonManager';
import * as builtinUtils from '../../managers/builtin/utils';
import { VenvManager } from '../../managers/builtin/venvManager';
import * as venvUtils from '../../managers/builtin/venvUtils';
import {
    NativeInfo,
    NativePythonEnvironmentKind,
    NativePythonFinder,
} from '../../managers/common/nativePythonFinder';
import { PipenvManager } from '../../managers/pipenv/pipenvManager';
import { CondaInstallCommand, CondaListCommand } from '../../managers/conda/commands';
import { CondaEnvManager } from '../../managers/conda/condaEnvManager';
import { CondaPackageManager } from '../../managers/conda/condaPackageManager';
import * as condaUtils from '../../managers/conda/condaUtils';
import { PoetryAddCommand, PoetryShowCommand } from '../../managers/poetry/commands';
import * as poetryRunner from '../../managers/poetry/commands/runPoetry';
import { PoetryManager } from '../../managers/poetry/poetryManager';
import { PoetryPackageManager } from '../../managers/poetry/poetryPackageManager';
import * as poetryUtils from '../../managers/poetry/poetryUtils';
import { createMockLogOutputChannel } from '../mocks/helper';

suite('Python tool manager capabilities', () => {
    let source: CancellationTokenSource;
    let api: PythonEnvironmentApi;
    let environment: PythonEnvironment;
    let scope: Uri;
    let progress: sinon.SinonStub;
    let errors: sinon.SinonStub;
    let temp: string | undefined;

    setup(() => {
        temp = undefined;
        source = new CancellationTokenSource();
        scope = Uri.file(path.join(process.cwd(), 'project with spaces'));
        const executable = path.join(scope.fsPath, '.venv', 'python.exe');
        environment = {
            envId: { id: 'test', managerId: 'ms-python.python:venv' },
            name: 'test',
            displayName: 'test',
            displayPath: executable,
            environmentPath: Uri.file(executable),
            execInfo: { run: { executable } },
            sysPrefix: path.dirname(executable),
            version: '3.12.4',
        };
        const partialApi: Partial<PythonEnvironmentApi> = {
            createPackageItem: sinon.stub().callsFake((info) => info),
            getPythonProjects: sinon.stub().returns([]),
        };
        api = partialApi as PythonEnvironmentApi;
        progress = sinon.stub(windowApis, 'withProgress').throws(new Error('Unexpected progress UI'));
        errors = sinon.stub(windowApis, 'showErrorMessage').throws(new Error('Unexpected error question'));
        sinon.stub(workspaceApis, 'getConfiguration').returns({
            get: <T>(_key: string, defaultValue?: T): T => defaultValue as T,
            inspect: () => undefined,
            update: async () => {},
            has: () => false,
        });
    });

    teardown(async () => {
        source.dispose();
        sinon.restore();
        if (temp) {
            await fs.remove(temp);
        }
    });

    test('pip mutations and their inventory refresh receive the tool token without public UI', async () => {
        const pip = new PipPackageManager(api, createMockLogOutputChannel(), {} as VenvManager);
        sinon.stub(helpers, 'shouldUseUv').resolves(false);
        const install = sinon.stub(PipInstallCommand.prototype, 'execute').resolves();
        const list = sinon.stub(PipListCommand.prototype, 'execute').resolves([]);
        const direct = sinon.stub(pip, 'getDirectPackageNames').rejects(new Error('Unexpected unscoped query'));
        await pip[pythonToolSupport].manage(environment, { install: ['requests'] }, source.token, scope);
        assert.strictEqual(install.firstCall.args[0].cancellationToken, source.token);
        assert.strictEqual(install.firstCall.args[0].toolExecution, true);
        assert.strictEqual(Reflect.get(install.firstCall.thisValue, 'cwd'), scope.fsPath);
        assert.strictEqual(list.firstCall.args[0]?.cancellationToken, source.token);
        assert.strictEqual(list.firstCall.args[0]?.strict, true);
        assert.strictEqual(list.firstCall.args[0]?.toolExecution, true);
        assert.ok(direct.notCalled);
        assert.ok(progress.notCalled && errors.notCalled);
    });

    test('pip private inventory rejects failure rather than returning stale packages', async () => {
        const pip = new PipPackageManager(api, createMockLogOutputChannel(), {} as VenvManager);
        sinon.stub(helpers, 'shouldUseUv').resolves(false);
        const list = sinon
            .stub(PipListCommand.prototype, 'execute')
            .resolves([{ name: 'pip', displayName: 'pip', version: '25.0' }]);
        await pip.getPackages(environment);
        list.rejects(new Error('list failed'));
        await assert.rejects(pip[pythonToolSupport].getPackages(environment, source.token, scope), /list failed/);
        assert.ok(errors.notCalled);
    });

    test('pip strict list rejects malformed output but public list behavior is unchanged', async () => {
        sinon.stub(helpers, 'runPython').resolves('not json');
        const command = new PipListCommand({ pythonExecutable: environment.execInfo.run.executable });
        await assert.rejects(command.execute({ strict: true, cancellationToken: source.token }));
        assert.deepStrictEqual(await command.execute(), []);
    });

    test('Conda headless install and query use the real cancellation token', async () => {
        const conda = new CondaPackageManager(api, createMockLogOutputChannel());
        const install = sinon.stub(CondaInstallCommand.prototype, 'execute').resolves();
        const list = sinon.stub(CondaListCommand.prototype, 'execute').resolves([]);
        await conda[pythonToolSupport].manage(environment, { install: ['requests'] }, source.token, scope);
        assert.strictEqual(install.firstCall.args[0].cancellationToken, source.token);
        assert.strictEqual(install.firstCall.args[0].toolExecution, true);
        assert.strictEqual(list.firstCall.args[0]?.cancellationToken, source.token);
        assert.strictEqual(list.firstCall.args[0]?.toolExecution, true);
        list.rejects(new Error('Conda list failed'));
        await assert.rejects(
            conda[pythonToolSupport].getPackages(environment, source.token, scope),
            /Conda list failed/,
        );
        assert.ok(progress.notCalled && errors.notCalled);
    });

    test('Conda private descriptors have standalone execution without mutating the shared descriptor', async () => {
        const manager = new CondaEnvManager({} as NativePythonFinder, api, createMockLogOutputChannel());
        const executable = path.join(scope.fsPath, 'conda install', 'conda.exe');
        sinon.stub(condaUtils, 'getCondaForTools').resolves(executable);
        const original = environment.execInfo;
        const descriptor = await manager[pythonToolSupport].describe!(environment, source.token);
        assert.notStrictEqual(descriptor, environment);
        assert.strictEqual(environment.execInfo, original);
        assert.strictEqual(environment.execInfo.activatedRun, undefined);
        assert.deepStrictEqual(descriptor.execInfo.activatedRun, {
            executable,
            args: [
                'run',
                '--prefix',
                environment.sysPrefix,
                '--no-capture-output',
                environment.execInfo.run.executable,
            ],
        });
    });

    test('Conda tool descriptors resolve a bare configured command to an absolute PATH executable', async () => {
        temp = await fs.mkdtemp(path.join(os.tmpdir(), 'conda-tool-command-'));
        const name = 'conda-tool-fixture';
        const commandDirectory = process.platform === 'win32' ? path.join(temp, 'condabin') : temp;
        const command = path.join(commandDirectory, process.platform === 'win32' ? `${name}.cmd` : name);
        const executable =
            process.platform === 'win32' ? path.join(temp, 'Scripts', 'conda.exe') : command;
        await fs.outputFile(
            command,
            process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n',
        );
        if (process.platform === 'win32') {
            await fs.outputFile(executable, '');
        }
        if (process.platform !== 'win32') {
            await fs.chmod(command, 0o755);
        }
        const config = workspaceApis.getConfiguration('python');
        sinon
            .stub(config, 'get')
            .callsFake(<T>(key: string, fallback?: T) => (key === 'condaPath' ? name : fallback) as T);
        const previousPath = process.env.PATH;
        process.env.PATH = `${commandDirectory}${path.delimiter}${previousPath ?? ''}`;
        try {
            const manager = new CondaEnvManager({} as NativePythonFinder, api, createMockLogOutputChannel());
            const described = await manager[pythonToolSupport].describe!(environment, source.token);
            assert.strictEqual(await condaUtils.getConda(), name, 'Public settings behavior is unchanged');
            assert.ok(path.isAbsolute(described.execInfo.activatedRun!.executable));
            assert.strictEqual(normalizePath(described.execInfo.activatedRun!.executable), normalizePath(executable));
            assert.strictEqual(environment.execInfo.activatedRun, undefined);
        } finally {
            if (previousPath === undefined) {
                delete process.env.PATH;
            } else {
                process.env.PATH = previousPath;
            }
        }
    });

    test('Poetry private operations use the requested project directory and token, not cached API routing', async () => {
        temp = await fs.mkdtemp(path.join(os.tmpdir(), 'poetry-tool-target-'));
        scope = Uri.file(temp);
        environment = { ...environment, sysPrefix: path.join(temp, 'selected') };
        await fs.ensureDir(environment.sysPrefix);
        const poetry = new PoetryPackageManager(api, createMockLogOutputChannel(), {} as PoetryManager);
        sinon.stub(poetryUtils, 'getPoetry').resolves(path.join(scope.fsPath, 'poetry'));
        const add = sinon.stub(PoetryAddCommand.prototype, 'execute').resolves();
        const show = sinon.stub(PoetryShowCommand.prototype, 'execute').resolves([]);
        const target = sinon
            .stub(poetryRunner, 'runPoetry')
            .callsFake(async (args) => (args[0] === 'env' ? environment.sysPrefix : '[]'));
        await poetry[pythonToolSupport].manage(environment, { install: ['requests'] }, source.token, scope);
        assert.deepStrictEqual(target.firstCall.args[0], ['env', 'info', '--path']);
        assert.strictEqual(target.firstCall.args[1], scope.fsPath);
        assert.strictEqual(target.firstCall.args[3], source.token);
        assert.strictEqual(target.firstCall.args[4], true);
        assert.strictEqual(add.firstCall.args[0].cancellationToken, source.token);
        assert.strictEqual(add.firstCall.args[0].toolExecution, true);
        assert.strictEqual(Reflect.get(add.firstCall.thisValue, 'cwd'), scope.fsPath);
        assert.deepStrictEqual(target.secondCall.args[0], ['install', '--no-root']);
        assert.deepStrictEqual(target.thirdCall.args[0], [
            'run',
            'pip',
            'list',
            '--format=json',
            '--disable-pip-version-check',
        ]);
        for (const call of target.getCalls()) {
            assert.strictEqual(call.args[1], scope.fsPath);
            assert.strictEqual(call.args[3], source.token);
            assert.strictEqual(call.args[4], true);
        }
        assert.ok(show.notCalled);
        assert.ok((api.getPythonProjects as sinon.SinonStub).notCalled);
        assert.ok(progress.notCalled && errors.notCalled);
    });

    test('Poetry private inventory is strict installed JSON while public inventory retains poetry show', async () => {
        temp = await fs.mkdtemp(path.join(os.tmpdir(), 'poetry-tool-inventory-'));
        scope = Uri.file(temp);
        environment = { ...environment, sysPrefix: path.join(temp, 'selected') };
        await fs.ensureDir(environment.sysPrefix);
        const poetry = new PoetryPackageManager(api, createMockLogOutputChannel(), {} as PoetryManager);
        let output = '[{"name":"installed-only","version":"1.0.0"}]';
        const runner = sinon
            .stub(poetryRunner, 'runPoetry')
            .callsFake(async (args) => (args[0] === 'env' ? environment.sysPrefix : output));
        sinon.stub(poetryUtils, 'getPoetry').resolves(path.join(temp, 'poetry'));
        const show = sinon
            .stub(PoetryShowCommand.prototype, 'execute')
            .resolves([{ name: 'locked-only', displayName: 'locked-only', version: '2.0.0' }]);
        const installed = await poetry[pythonToolSupport].getPackages(environment, source.token, scope);
        assert.deepStrictEqual(
            installed.map((pkg) => pkg.name),
            ['installed-only'],
        );
        assert.ok(show.notCalled);
        assert.ok(runner.secondCall.args[0].includes('--disable-pip-version-check'));
        sinon.stub(workspaceFs, 'stat').resolves({ type: FileType.Directory, ctime: 0, mtime: 0, size: 0 });
        const scopedPoetry = poetry.createForProject({ name: 'project', uri: scope });
        const publicPackages = await scopedPoetry.getPackages(environment, { skipCache: true });
        assert.deepStrictEqual(
            publicPackages?.map((pkg) => pkg.name),
            ['locked-only'],
        );
        assert.ok(show.calledOnce);
        for (output of ['not json', '{}', '[{"name":"invalid"}]', '[{"name":"","version":"1.0"}]']) {
            await assert.rejects(poetry[pythonToolSupport].getPackages(environment, source.token, scope));
        }
        output = '[]';
        assert.deepStrictEqual(await poetry[pythonToolSupport].getPackages(environment, source.token, scope), []);
        assert.ok(progress.notCalled && errors.notCalled);
    });

    test('Poetry private queries and mutations reject a different selected environment before running package commands', async () => {
        temp = await fs.mkdtemp(path.join(os.tmpdir(), 'poetry-tool-mismatch-'));
        scope = Uri.file(temp);
        environment = { ...environment, sysPrefix: path.join(temp, 'selected') };
        const poetry = new PoetryPackageManager(api, createMockLogOutputChannel(), {} as PoetryManager);
        const wrongPrefix = path.join(scope.fsPath, 'different-environment');
        await Promise.all([fs.ensureDir(environment.sysPrefix), fs.ensureDir(wrongPrefix)]);
        const target = sinon.stub(poetryRunner, 'runPoetry').resolves(wrongPrefix);
        const add = sinon.stub(PoetryAddCommand.prototype, 'execute').resolves();
        const show = sinon.stub(PoetryShowCommand.prototype, 'execute').resolves([]);
        const isMismatch = (error: unknown) =>
            error instanceof PythonToolError && error.code === 'ENVIRONMENT_MISMATCH';
        await assert.rejects(
            poetry[pythonToolSupport].manage(environment, { install: ['requests'] }, source.token, scope),
            isMismatch,
        );
        await assert.rejects(poetry[pythonToolSupport].getPackages(environment, source.token, scope), isMismatch);
        assert.strictEqual(target.callCount, 2);
        assert.ok(add.notCalled && show.notCalled);
        assert.ok(progress.notCalled && errors.notCalled);
    });

    test('Conda private readiness exposes real PET failure even when human initialization already completed', async () => {
        const failure = new Error('PET discovery unavailable');
        const finder: Partial<NativePythonFinder> = { refresh: sinon.stub().rejects(failure) };
        const manager = new CondaEnvManager(finder as NativePythonFinder, api, createMockLogOutputChannel());
        progress.callsFake(async (_options, task) => task({ report: () => {} }, source.token));
        sinon.stub(condaUtils, 'getConda').resolves(path.join(scope.fsPath, 'conda.exe'));
        sinon.stub(condaUtils, 'getCondaForGlobal').resolves(undefined);
        const create = sinon
            .stub(condaUtils, 'quickCreateConda')
            .rejects(new Error('Must not create during failed discovery'));
        await assert.doesNotReject(manager.initialize());
        await assert.rejects(manager[pythonToolSupport].initialize(), (error) => error === failure);
        assert.ok(create.notCalled);
        const human = await condaUtils.refreshCondaEnvs(false, finder as NativePythonFinder, api, manager.log, manager);
        assert.deepStrictEqual(human, [], 'Human helper retains its best-effort default');
        await assert.doesNotReject(manager.refresh(undefined), 'Public refresh remains best-effort');
        await assert.rejects(manager[pythonToolSupport].initialize(), (error) => error === failure);
        sinon.stub(condaUtils, 'refreshCondaEnvs').resolves([]);
        await manager.refresh(undefined);
        await assert.doesNotReject(
            manager[pythonToolSupport].initialize(),
            'Successful refresh clears the private error',
        );
    });

    test('Conda strict discovery rejects malformed PET data instead of reporting empty discovery', async () => {
        const finder: Partial<NativePythonFinder> = { refresh: sinon.stub().resolves(undefined) };
        const manager = new CondaEnvManager(finder as NativePythonFinder, api, createMockLogOutputChannel());
        await assert.rejects(
            condaUtils.refreshCondaEnvs(false, finder as NativePythonFinder, api, manager.log, manager, true),
            /invalid data/,
        );
    });

    test('pre-cancelled package requests do not start a command', async () => {
        const pip = new PipPackageManager(api, createMockLogOutputChannel(), {} as VenvManager);
        const run = sinon.stub(helpers, 'runPython').resolves('');
        source.cancel();
        await assert.rejects(
            pip[pythonToolSupport].manage(environment, { install: ['requests'] }, source.token, scope),
            CancellationError,
        );
        assert.ok(run.notCalled);
    });

    for (const hasSelectedBase of [true, false]) {
        test(`venv creation uses ${
            hasSelectedBase ? 'the selected base' : 'the newest discovered Python 3'
        }`, async () => {
            temp = await fs.mkdtemp(path.join(os.tmpdir(), 'venv-tool-base-'));
            scope = Uri.file(temp);
            const selected = { ...environment, version: '3.11.9' };
            const newest = { ...environment, version: '3.14.3.final.0' };
            const created = { ...environment, sysPrefix: path.join(temp, '.venv') };
            await fs.ensureDir(created.sysPrefix);
            const create = sinon.stub(venvUtils, 'quickCreateVenv').resolves({ environment: created });
            const globals = sinon.stub().resolves([{ ...environment, version: '2.7.18' }, selected, newest]);
            const system = new SysPythonManager({} as NativePythonFinder, api, createMockLogOutputChannel());
            const manager = new VenvManager({} as NativePythonFinder, api, system, createMockLogOutputChannel());
            const result = await manager[pythonToolSupport].create!(scope, {
                token: source.token,
                baseEnvironment: hasSelectedBase ? selected : undefined,
                getGlobalEnvironments: globals,
                managePackages: sinon.stub().resolves(),
            });
            assert.strictEqual(result, created);
            assert.strictEqual(create.firstCall.args[4], hasSelectedBase ? selected : newest);
            assert.strictEqual(globals.callCount, hasSelectedBase ? 0 : 1);
            assert.ok(progress.notCalled && errors.notCalled);
        });
    }

    for (const kind of [NativePythonEnvironmentKind.poetry, NativePythonEnvironmentKind.pipenv]) {
        test(`${kind} tool configuration resolves an associated cache outside the workspace without public initialization`, async () => {
            const project = path.join(scope.fsPath, 'service');
            const executable = path.join(scope.fsPath, 'cache', 'python');
            const data: NativeInfo[] = [
                { kind, project: scope.fsPath, prefix: path.join(scope.fsPath, 'parent-cache'), executable: 'parent' },
                { kind, project, prefix: path.dirname(executable), executable },
                { kind, project: path.join(scope.fsPath, 'other'), prefix: 'other', executable: 'other' },
            ];
            const finder = { refresh: sinon.stub().resolves(data) } as Partial<NativePythonFinder> as NativePythonFinder;
            const manager = kind === NativePythonEnvironmentKind.poetry
                ? new PoetryManager(finder, api)
                : new PipenvManager(finder, api);
            const initialize = sinon.stub(manager, 'initialize').throws(new Error('Public onboarding must not run'));
            const resolve = sinon.stub(manager, 'resolve').resolves(environment);
            const result = await manager[pythonToolSupport].resolveProject!(Uri.file(path.join(project, 'main.py')));
            assert.strictEqual(result, environment);
            assert.strictEqual(resolve.firstCall.args[0].fsPath, Uri.file(executable).fsPath);
            assert.strictEqual(resolve.firstCall.args[1], true);
            assert.ok(initialize.notCalled);
        });
    }

    test('cached project resolution rejects ambiguity rather than choosing an unrelated environment', async () => {
        const kind = NativePythonEnvironmentKind.poetry;
        const data: NativeInfo[] = ['first', 'second'].map((name) => ({
            kind, project: scope.fsPath, prefix: path.join(scope.fsPath, name),
            executable: path.join(scope.fsPath, name, 'python'),
        }));
        const finder = { refresh: sinon.stub().resolves(data) } as Partial<NativePythonFinder> as NativePythonFinder;
        const resolve = sinon.stub().resolves(environment);
        await assert.rejects(
            resolveToolProjectEnvironment(scope, kind, finder, resolve),
            (error) => error instanceof PythonToolError && error.code === 'AMBIGUOUS_ENVIRONMENT',
        );
        assert.ok(resolve.notCalled);
        data.splice(0, data.length, { kind, project: path.join(scope.fsPath, 'sibling'), prefix: 'other', executable: 'other' });
        assert.strictEqual(await resolveToolProjectEnvironment(scope, kind, finder, resolve), undefined);
        assert.ok(resolve.notCalled);
    });

    test('an unsupported selected base is not silently replaced with a different Python version', async () => {
        const system = new SysPythonManager({} as NativePythonFinder, api, createMockLogOutputChannel());
        const manager = new VenvManager({} as NativePythonFinder, api, system, createMockLogOutputChannel());
        const create = sinon.stub(venvUtils, 'quickCreateVenv').resolves({ environment });
        const globals = sinon.stub().resolves([environment]);
        await assert.rejects(
            manager[pythonToolSupport].create!(scope, {
                token: source.token,
                baseEnvironment: { ...environment, version: '2.7.18' },
                getGlobalEnvironments: globals,
                managePackages: sinon.stub().resolves(),
            }),
            (error) => error instanceof PythonToolError && error.code === 'MISSING_PYTHON',
        );
        assert.ok(create.notCalled && globals.notCalled);
    });

    test('cold private discovery with no Python never starts installation onboarding', async () => {
        progress.callsFake(async (_options, task) => task({ report: () => {} }, source.token));
        sinon.stub(cache, 'getSystemEnvForGlobal').resolves(undefined);
        sinon.stub(cache, 'getSystemEnvForWorkspace').resolves(undefined);
        sinon.stub(builtinUtils, 'refreshPythons').resolves([]);
        sinon.stub(venvUtils, 'findVirtualEnvironments').resolves([]);
        sinon.stub(venvUtils, 'getVenvForGlobal').resolves(undefined);
        const prompt = sinon.stub(pythonInstaller, 'promptInstallPython').throws(new Error('Unexpected onboarding'));
        const installPicker = sinon.stub(pythonInstaller, 'selectAndInstallPython').resolves(undefined);
        const system = new SysPythonManager({} as NativePythonFinder, api, createMockLogOutputChannel());
        const venv = new VenvManager({} as NativePythonFinder, api, system, createMockLogOutputChannel());
        await venv[pythonToolSupport].initialize();
        assert.deepStrictEqual(await system[pythonToolSupport].getEnvironments('global'), []);
        assert.ok(prompt.notCalled && installPicker.notCalled && errors.notCalled);
        await system.create('global');
        assert.ok(installPicker.calledOnce, 'Explicit human install keeps its version picker');
    });
});
