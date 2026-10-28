// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import {
    CancellationError,
    CancellationTokenSource,
    FileType,
    LogOutputChannel,
    Uri,
} from 'vscode';
import {
    DidChangePackagesEventArgs,
    Package,
    PackageChangeKind,
    PythonEnvironment,
    PythonEnvironmentApi,
} from '../../../api';
import * as windowApis from '../../../common/window.apis';
import * as workspaceFs from '../../../common/workspace.fs.apis';
import { PythonToolError, pythonToolSupport } from '../../../internal/pythonToolSupport';
import { PackageManagerRequiresProjectError } from '../../../managers/common/errors';
import * as packageChanges from '../../../managers/common/packageChanges';
import * as runPoetryModule from '../../../managers/poetry/commands/runPoetry';
import { PoetryAddCommand } from '../../../managers/poetry/commands/add';
import { PoetryPackageManager } from '../../../managers/poetry/poetryPackageManager';
import { PoetryManager } from '../../../managers/poetry/poetryManager';
import * as poetryUtils from '../../../managers/poetry/poetryUtils';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

interface PoetryPackageManagerInternals {
    packages: Map<string, Package[]>;
    sharedState: {
        environmentOperations: Map<string, Promise<void>>;
        installedPackages: Map<string, Package[]>;
    };
}

suite('PoetryPackageManager', () => {
    let environment: PythonEnvironment;
    let environmentPath: string;
    let logError: sinon.SinonStub;
    let manager: PoetryPackageManager;
    let mismatchPath: string;
    let packageChangesStub: sinon.SinonStub;
    let posixBackslashPath: string;
    let posixSlashPath: string;
    let progressSource: CancellationTokenSource;
    let projectManager: PoetryPackageManager;
    let projectRoot: string;
    let projectUri: Uri;
    let runPoetryStub: sinon.SinonStub;
    let statStub: sinon.SinonStub;
    let symlinkPath: string;
    let temp: string;

    suiteSetup(async () => {
        temp = await fs.mkdtemp(path.join(os.tmpdir(), 'poetry-package-manager-'));
        environmentPath = path.join(temp, 'selected environment');
        mismatchPath = path.join(temp, 'different environment');
        posixBackslashPath = path.join(temp, 'env\\prod');
        posixSlashPath = path.join(temp, 'env', 'prod');
        symlinkPath = path.join(temp, 'selected environment link');
        projectRoot = path.join(temp, 'project with spaces');
        projectUri = Uri.file(path.join(projectRoot, 'pyproject.toml'));
        await Promise.all([
            fs.ensureDir(environmentPath),
            fs.ensureDir(mismatchPath),
            fs.ensureDir(projectRoot),
            ...(process.platform === 'win32'
                ? []
                : [fs.ensureDir(posixBackslashPath), fs.ensureDir(posixSlashPath)]),
        ]);
        await fs.symlink(environmentPath, symlinkPath, process.platform === 'win32' ? 'junction' : 'dir');
    });

    suiteTeardown(async () => {
        await fs.remove(temp);
    });

    setup(() => {
        progressSource = new CancellationTokenSource();
        environment = createMockPythonEnvironment({
            envPath: environmentPath,
            managerId: 'ms-python.python:poetry',
        });
        const api = {
            createPackageItem: (pkg: Package, target: PythonEnvironment) => ({
                ...pkg,
                pkgId: {
                    id: pkg.name,
                    managerId: 'ms-python.python:poetry',
                    environmentId: target.envId.id,
                },
            }),
        } as unknown as PythonEnvironmentApi;
        logError = sinon.stub();
        const log = {
            append: sinon.stub(),
            error: logError,
            info: sinon.stub(),
            show: sinon.stub(),
        } as unknown as LogOutputChannel;

        sinon.stub(poetryUtils, 'getPoetry').resolves('poetry');
        sinon
            .stub(windowApis, 'withProgress')
            .callsFake((_options, task) => task({} as never, progressSource.token));
        packageChangesStub = sinon.stub(packageChanges, 'updatePackagesAndNotify').resolves([]);
        runPoetryStub = sinon
            .stub(runPoetryModule, 'runPoetry')
            .callsFake(async (args: string[]) => (args.includes('env') ? environmentPath : ''));
        statStub = sinon.stub(workspaceFs, 'stat');
        statStub.resolves({ type: FileType.File, ctime: 0, mtime: 0, size: 0 });
        manager = new PoetryPackageManager(api, log, {} as PoetryManager);
        projectManager = manager.createForProject({ name: 'project', uri: projectUri });
    });

    teardown(() => {
        progressSource.dispose();
        projectManager.dispose();
        manager.dispose();
        sinon.restore();
    });

    test('package management verifies, pins, and uses the project working directory', async () => {
        const expectedCwd = path.dirname(projectUri.fsPath);
        await projectManager.manage(environment, { install: ['requests'], uninstall: ['flask'] });

        assert.strictEqual(runPoetryStub.callCount, 4);
        assert.deepStrictEqual(runPoetryStub.firstCall.args[0], ['--no-ansi', 'env', 'info', '--path']);
        assert.deepStrictEqual(runPoetryStub.secondCall.args[0], ['--no-ansi', 'env', 'info', '--path']);
        assert.deepStrictEqual(runPoetryStub.thirdCall.args[0], ['remove', 'flask']);
        assert.deepStrictEqual(runPoetryStub.getCall(3).args[0], ['add', 'requests']);
        for (const call of runPoetryStub.getCalls()) {
            assert.strictEqual(call.args[1], expectedCwd);
        }
        for (const call of runPoetryStub.getCalls().slice(1)) {
            assert.strictEqual(call.args[5].VIRTUAL_ENV, environmentPath);
        }
    });

    test('direct package listing verifies, pins, and uses the project working directory', async () => {
        const expectedCwd = path.dirname(projectUri.fsPath);
        await projectManager.getDirectPackageNames(environment);

        assert.strictEqual(runPoetryStub.callCount, 3);
        assert.deepStrictEqual(runPoetryStub.firstCall.args[0], ['--no-ansi', 'env', 'info', '--path']);
        assert.deepStrictEqual(runPoetryStub.secondCall.args[0], ['--no-ansi', 'env', 'info', '--path']);
        assert.deepStrictEqual(runPoetryStub.thirdCall.args[0], ['show', '--no-ansi', '--top-level']);
        assert.ok(runPoetryStub.getCalls().every((call) => call.args[1] === expectedCwd));
        assert.strictEqual(runPoetryStub.thirdCall.args[5].VIRTUAL_ENV, environmentPath);
    });

    test('directory project URIs are used directly as the working directory', async () => {
        const directoryUri = Uri.file(projectRoot);
        statStub.withArgs(directoryUri).resolves({ type: FileType.Directory, ctime: 0, mtime: 0, size: 0 });
        const directoryManager = manager.createForProject({ name: 'directory-project', uri: directoryUri });

        try {
            await directoryManager.getDirectPackageNames(environment);
            assert.ok(runPoetryStub.getCalls().every((call) => call.args[1] === directoryUri.fsPath));
        } finally {
            directoryManager.dispose();
        }
    });

    test('symlinked directory project URIs are used directly as the working directory', async () => {
        const symlinkedProjectUri = Uri.file(path.join(temp, 'symlinked project'));
        statStub
            .withArgs(symlinkedProjectUri)
            .resolves({ type: FileType.Directory | FileType.SymbolicLink, ctime: 0, mtime: 0, size: 0 });
        const symlinkedProjectManager = manager.createForProject({
            name: 'symlinked-directory-project',
            uri: symlinkedProjectUri,
        });

        try {
            await symlinkedProjectManager.getDirectPackageNames(environment);
            assert.ok(runPoetryStub.getCalls().every((call) => call.args[1] === symlinkedProjectUri.fsPath));
        } finally {
            symlinkedProjectManager.dispose();
        }
    });

    test('inaccessible projects reject instead of falling back to the parent directory', async () => {
        const inaccessibleUri = Uri.file(path.join(temp, 'missing project'));
        statStub.withArgs(inaccessibleUri).rejects(new Error('access denied'));
        const inaccessibleManager = manager.createForProject({ name: 'missing', uri: inaccessibleUri });

        try {
            await assert.rejects(
                inaccessibleManager.manage(environment, { install: ['requests'] }),
                /Unable to access the Python project/,
            );
            assert.strictEqual(runPoetryStub.callCount, 0);
        } finally {
            inaccessibleManager.dispose();
        }
    });

    test('package loading preserves best-effort public behavior when poetry show fails', async () => {
        const showError = new Error('poetry show failed');
        runPoetryStub.callsFake(async (args: string[]) => {
            if (args.includes('env')) {
                return environmentPath;
            }
            throw showError;
        });

        assert.deepStrictEqual(await projectManager.getPackages(environment, { skipCache: true }), []);
        assert.ok(logError.calledOnceWithExactly(`Error refreshing packages with Poetry: ${showError}`));
    });

    test('rejects mismatched public mutations, reads, and direct-package queries', async () => {
        const add = sinon.stub(PoetryAddCommand.prototype, 'execute').resolves();
        const showErrorMessage = sinon.stub(windowApis, 'showErrorMessage').resolves(undefined);
        runPoetryStub.resolves(mismatchPath);
        const isMismatch = (error: unknown) =>
            error instanceof PythonToolError &&
            error.code === 'ENVIRONMENT_MISMATCH' &&
            error.message.includes('choose a compatible package manager');

        await assert.rejects(projectManager.manage(environment, { install: ['requests'] }), isMismatch);
        await assert.rejects(projectManager.getPackages(environment, { skipCache: true }), isMismatch);
        await assert.rejects(projectManager.getDirectPackageNames(environment), isMismatch);
        await flushImmediate();

        assert.strictEqual(runPoetryStub.callCount, 3, 'Each public operation should stop at its target probe');
        assert.ok(add.notCalled, 'No Poetry mutation should run after a target mismatch');
        assert.ok(packageChangesStub.notCalled, 'A mismatch must not refresh or emit package changes');
        assert.ok(showErrorMessage.calledOnce);
        assert.ok(
            showErrorMessage.calledWith(
                sinon.match(/targets .*not the selected environment.*compatible package manager/i),
                sinon.match.string,
            ),
        );

        runPoetryStub.callsFake(async (args: string[]) => (args.includes('env') ? environmentPath : ''));
        await projectManager.getPackages(environment, { skipCache: true });
    });

    test('refresh-first mismatch rejects once without also scheduling a manager notification', async () => {
        const showErrorMessage = sinon.stub(windowApis, 'showErrorMessage').resolves(undefined);
        runPoetryStub.resolves(mismatchPath);

        await assert.rejects(projectManager.refresh(environment), isEnvironmentMismatch);
        await flushImmediate();

        assert.ok(packageChangesStub.notCalled);
        assert.ok(showErrorMessage.notCalled);
    });

    test('deduplicates concurrent mismatch notifications but not a later explicit retry', async () => {
        let resolveFirstNotification!: () => void;
        const firstNotification = new Promise<void>((resolve) => {
            resolveFirstNotification = resolve;
        });
        const showErrorMessage = sinon
            .stub(windowApis, 'showErrorMessage')
            .onFirstCall()
            .returns(firstNotification as never)
            .resolves(undefined);
        runPoetryStub.resolves(mismatchPath);

        await Promise.all([
            assert.rejects(projectManager.manage(environment, { install: ['requests'] }), isEnvironmentMismatch),
            assert.rejects(projectManager.manage(environment, { install: ['flask'] }), isEnvironmentMismatch),
        ]);
        await flushImmediate();
        assert.strictEqual(showErrorMessage.callCount, 1);

        resolveFirstNotification();
        await flushImmediate();
        await assert.rejects(
            projectManager.manage(environment, { install: ['httpx'] }),
            isEnvironmentMismatch,
        );
        await flushImmediate();
        assert.strictEqual(showErrorMessage.callCount, 2);
    });

    test('rejects before mutation when a pinned target is not honored', async () => {
        const add = sinon.stub(PoetryAddCommand.prototype, 'execute').resolves();
        let targetProbe = 0;
        runPoetryStub.callsFake(async (args: string[]) => {
            if (args.includes('env')) {
                targetProbe += 1;
                return targetProbe === 1 ? environmentPath : mismatchPath;
            }
            return '';
        });

        await assert.rejects(
            projectManager.manage(environment, { install: ['requests'], runHeadless: true }),
            isEnvironmentMismatch,
        );

        assert.strictEqual(targetProbe, 2);
        assert.ok(add.notCalled);
        assert.ok(packageChangesStub.notCalled);
    });

    test('private tool manage and package queries reject mismatches without notifications', async () => {
        const source = new CancellationTokenSource();
        const add = sinon.stub(PoetryAddCommand.prototype, 'execute').resolves();
        const showErrorMessage = sinon.stub(windowApis, 'showErrorMessage').resolves(undefined);
        runPoetryStub.resolves(mismatchPath);

        try {
            await assert.rejects(
                projectManager[pythonToolSupport].manage(
                    environment,
                    { install: ['requests'] },
                    source.token,
                    Uri.file(projectRoot),
                ),
                isEnvironmentMismatch,
            );
            await assert.rejects(
                projectManager[pythonToolSupport].getPackages(
                    environment,
                    source.token,
                    Uri.file(projectRoot),
                ),
                isEnvironmentMismatch,
            );
        } finally {
            source.dispose();
        }
        await flushImmediate();

        assert.strictEqual(runPoetryStub.callCount, 2);
        assert.ok(add.notCalled);
        assert.ok(packageChangesStub.notCalled);
        assert.ok(showErrorMessage.notCalled);
    });

    test('matched package changes update the enriched cache before exact-attribution events', async () => {
        packageChangesStub.resetBehavior();
        packageChangesStub.callThrough();
        let showOutput = 'old-package 1.0.0 Existing package';
        runPoetryStub.callsFake(async (args: string[]) => {
            if (args.includes('env')) {
                return environmentPath;
            }
            if (args.includes('--top-level')) {
                return 'old-package';
            }
            if (args[0] === 'show') {
                return showOutput;
            }
            return '';
        });
        const before = await projectManager.getPackages(environment, { skipCache: true });
        assert.deepStrictEqual(before?.map((pkg) => pkg.name), ['old-package']);
        showOutput = [
            'old-package 1.0.0 Existing package',
            'new-package 2.0.0 Newly installed package',
        ].join('\n');
        const events: DidChangePackagesEventArgs[] = [];
        const cachedSnapshots: Promise<Package[] | undefined>[] = [];
        const subscription = projectManager.onDidChangePackages!((event) => {
            events.push(event);
            cachedSnapshots.push(projectManager.getPackages(environment));
        });

        try {
            await projectManager.manage(environment, { install: ['new-package'] });
            const snapshots = await Promise.all(cachedSnapshots);
            assert.deepStrictEqual(
                snapshots[0]?.map((pkg) => ({ name: pkg.name, isTransitive: pkg.isTransitive })),
                [
                    { name: 'old-package', isTransitive: false },
                    { name: 'new-package', isTransitive: true },
                ],
            );
            await projectManager.manage(environment, { install: ['new-package'] });
        } finally {
            subscription.dispose();
        }

        assert.strictEqual(events.length, 1, 'An unchanged second refresh must not repeat the first delta');
        assert.strictEqual(events[0].environment, environment);
        assert.strictEqual(events[0].manager, projectManager);
        assert.deepStrictEqual(
            events[0].changes.map((change) => ({
                kind: change.kind,
                name: change.pkg.name,
                isTransitive: change.pkg.isTransitive,
            })),
            [{ kind: PackageChangeKind.add, name: 'new-package', isTransitive: true }],
        );
    });

    test('private tool inventory and events use a separate exact-environment cache', async () => {
        packageChangesStub.resetBehavior();
        packageChangesStub.callThrough();
        const source = new CancellationTokenSource();
        const publicPackages = 'declared-package 9.0.0 Public lockfile package';
        let installed = [{ name: 'old-package', version: '1.0.0' }];
        runPoetryStub.callsFake(async (args: string[]) => {
            if (args.includes('env')) {
                return environmentPath;
            }
            if (args.includes('list')) {
                return JSON.stringify(installed);
            }
            if (args[0] === 'show') {
                return publicPackages;
            }
            return '';
        });
        assert.deepStrictEqual(
            (await projectManager.getPackages(environment, { skipCache: true }))?.map((pkg) => pkg.name),
            ['declared-package'],
        );
        await projectManager[pythonToolSupport].getPackages(environment, source.token, Uri.file(projectRoot));
        installed = [
            ...installed,
            { name: 'new-package', version: '2.0.0' },
        ];
        const events: DidChangePackagesEventArgs[] = [];
        const subscription = projectManager.onDidChangePackages!((event) => events.push(event));

        try {
            await projectManager[pythonToolSupport].manage(
                environment,
                { install: ['new-package'] },
                source.token,
                Uri.file(projectRoot),
            );
        } finally {
            subscription.dispose();
            source.dispose();
        }

        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].environment, environment);
        assert.strictEqual(events[0].manager, projectManager);
        assert.deepStrictEqual(
            events[0].changes.map((change) => change.pkg.name),
            ['new-package'],
        );
        assert.deepStrictEqual(
            (await projectManager.getPackages(environment))?.map((pkg) => pkg.name),
            ['declared-package'],
            'Private installed-distribution refreshes must not overwrite the public lockfile cache',
        );
        assert.strictEqual(
            runPoetryStub.getCalls().filter((call) => call.args[0][0] === 'show').length,
            2,
            'The public inventory must be refetched after a private mutation invalidates both caches',
        );
    });

    test('shares private inventory baselines across project-scoped managers for one environment', async () => {
        packageChangesStub.resetBehavior();
        packageChangesStub.callThrough();
        const secondProjectRoot = path.join(temp, 'second project');
        await fs.ensureDir(secondProjectRoot);
        const secondManager = manager.createForProject({
            name: 'second-project',
            uri: Uri.file(path.join(secondProjectRoot, 'pyproject.toml')),
        });
        const source = new CancellationTokenSource();
        let installed = [{ name: 'old-package', version: '1.0.0' }];
        runPoetryStub.callsFake(async (args: string[]) => {
            if (args.includes('env')) {
                return environmentPath;
            }
            if (args.includes('list')) {
                return JSON.stringify(installed);
            }
            return '';
        });
        await projectManager[pythonToolSupport].getPackages(environment, source.token, Uri.file(projectRoot));
        installed = [...installed, { name: 'new-package', version: '2.0.0' }];
        const events: DidChangePackagesEventArgs[] = [];
        const subscription = secondManager.onDidChangePackages!((event) => events.push(event));

        try {
            await secondManager[pythonToolSupport].manage(
                environment,
                { install: ['new-package'] },
                source.token,
                Uri.file(secondProjectRoot),
            );
        } finally {
            subscription.dispose();
            source.dispose();
            secondManager.dispose();
        }

        assert.strictEqual(events.length, 1);
        assert.deepStrictEqual(events[0].changes.map((change) => change.pkg.name), ['new-package']);
    });

    test('cancels a queued cross-project mutation without running it after the active read', async () => {
        const secondProjectRoot = path.join(temp, 'queued second project');
        await fs.ensureDir(secondProjectRoot);
        const secondManager = manager.createForProject({
            name: 'queued-second-project',
            uri: Uri.file(path.join(secondProjectRoot, 'pyproject.toml')),
        });
        const source = new CancellationTokenSource();
        let resolveRead!: (value: string) => void;
        const blockedRead = new Promise<string>((resolve) => {
            resolveRead = resolve;
        });
        runPoetryStub.callsFake(async (args: string[]) => {
            if (args.includes('env')) {
                return environmentPath;
            }
            if (args[0] === 'show') {
                return blockedRead;
            }
            return '';
        });
        const add = sinon.stub(PoetryAddCommand.prototype, 'execute').resolves();
        const pendingRead = projectManager.getPackages(environment, { skipCache: true });
        await flushImmediate();
        const pendingMutation = secondManager[pythonToolSupport].manage(
            environment,
            { install: ['requests'] },
            source.token,
            Uri.file(secondProjectRoot),
        );
        source.cancel();

        try {
            await assert.rejects(pendingMutation, CancellationError);
            assert.ok(add.notCalled);
            const laterMutation = secondManager.manage(environment, { install: ['flask'] });
            await flushImmediate();
            assert.ok(add.notCalled, 'Later work must remain queued behind the original read');
            resolveRead('old-package 1.0.0 Existing package');
            await pendingRead;
            await laterMutation;
            assert.ok(add.calledOnce, 'Only the non-canceled later mutation should run');
            assert.deepStrictEqual(add.firstCall.args[0].packages, [{ packageName: 'flask' }]);
        } finally {
            resolveRead('old-package 1.0.0 Existing package');
            source.dispose();
            secondManager.dispose();
        }
    });

    test('invalidates both inventories before a public mutation and keeps failed refreshes non-stale', async () => {
        packageChangesStub.resetBehavior();
        packageChangesStub.callThrough();
        const internals = projectManager as unknown as PoetryPackageManagerInternals;
        const installedCacheKey = await environmentIdentity(environmentPath);
        internals.packages.set(environment.envId.id, [{ name: 'stale-public', version: '1.0' } as Package]);
        internals.sharedState.installedPackages.set(installedCacheKey, [
            { name: 'stale-private', version: '1.0' } as Package,
        ]);
        runPoetryStub.callsFake(async (args: string[]) => {
            if (args.includes('env')) {
                return environmentPath;
            }
            if (args[0] === 'show') {
                throw new Error('transient poetry show failure');
            }
            return '';
        });

        await projectManager.manage(environment, { install: ['requests'] });

        assert.deepStrictEqual(internals.packages.get(environment.envId.id), []);
        assert.strictEqual(internals.sharedState.installedPackages.has(installedCacheKey), false);
    });

    test('serializes an older read ahead of mutation so it cannot repopulate stale cache', async () => {
        packageChangesStub.resetBehavior();
        packageChangesStub.callThrough();
        let resolveOldRead!: (value: string) => void;
        const oldRead = new Promise<string>((resolve) => {
            resolveOldRead = resolve;
        });
        let showCall = 0;
        runPoetryStub.callsFake(async (args: string[]) => {
            if (args.includes('env')) {
                return environmentPath;
            }
            if (args[0] === 'show') {
                showCall += 1;
                return showCall === 1 ? oldRead : 'new-package 2.0.0 Replacement package';
            }
            return '';
        });
        const add = sinon.stub(PoetryAddCommand.prototype, 'execute').resolves();

        const pendingRead = projectManager.getPackages(environment, { skipCache: true });
        await flushImmediate();
        const pendingMutation = projectManager.manage(environment, { install: ['new-package'] });
        await flushImmediate();
        assert.ok(add.notCalled, 'Mutation must wait for the in-flight read of the same environment');

        resolveOldRead('old-package 1.0.0 Existing package');
        await pendingRead;
        await pendingMutation;

        assert.ok(add.calledOnce);
        assert.deepStrictEqual(
            (await projectManager.getPackages(environment))?.map((pkg) => pkg.name),
            ['new-package'],
        );
    });

    test('invalidates a cached inventory when the Poetry target changes', async () => {
        let target = environmentPath;
        let showOutput = 'old-package 1.0.0 Existing package';
        runPoetryStub.callsFake(async (args: string[]) => {
            if (args.includes('env')) {
                return target;
            }
            if (args[0] === 'show') {
                return showOutput;
            }
            return '';
        });
        assert.deepStrictEqual(
            (await projectManager.getPackages(environment, { skipCache: true }))?.map((pkg) => pkg.name),
            ['old-package'],
        );

        target = mismatchPath;
        await assert.rejects(projectManager.getPackages(environment), isEnvironmentMismatch);

        target = environmentPath;
        showOutput = 'new-package 2.0.0 Replacement package';
        assert.deepStrictEqual(
            (await projectManager.getPackages(environment))?.map((pkg) => pkg.name),
            ['new-package'],
            'A mismatched cached read must discard the prior inventory',
        );
        assert.strictEqual(
            runPoetryStub.getCalls().filter((call) => call.args[0][0] === 'show').length,
            2,
        );
    });

    test('accepts symlink aliases and Windows casing differences for the same environment', async () => {
        const aliasedEnvironment = {
            ...environment,
            sysPrefix: process.platform === 'win32' ? symlinkPath.toUpperCase() : symlinkPath,
        };

        await projectManager.manage(aliasedEnvironment, { install: ['requests'], runHeadless: true });

        assert.strictEqual(runPoetryStub.getCall(1).args[5].VIRTUAL_ENV, environmentPath);
        assert.deepStrictEqual(runPoetryStub.getCall(2).args[0], ['add', 'requests']);
    });

    test('does not equate POSIX backslashes with path separators', async function () {
        if (process.platform === 'win32') {
            this.skip();
        }
        const backslashEnvironment = {
            ...environment,
            sysPrefix: posixBackslashPath,
        };
        runPoetryStub.resolves(posixSlashPath);

        await assert.rejects(
            projectManager.manage(backslashEnvironment, { install: ['requests'], runHeadless: true }),
            isEnvironmentMismatch,
        );
    });

    test('reports missing target and selected paths as actionable mismatches', async () => {
        const missingTarget = path.join(temp, 'missing target');
        runPoetryStub.resolves(missingTarget);
        await assert.rejects(
            projectManager.getPackages(environment),
            (error: unknown) =>
                isEnvironmentMismatch(error) &&
                error.message.includes(missingTarget) &&
                error.message.includes(environmentPath),
        );

        runPoetryStub.resolves(environmentPath);
        const missingSelected = {
            ...environment,
            sysPrefix: path.join(temp, 'missing selected environment'),
        };
        await assert.rejects(
            projectManager.getPackages(missingSelected),
            (error: unknown) =>
                isEnvironmentMismatch(error) &&
                error.message.includes(missingSelected.sysPrefix),
        );
        assert.ok(logError.called);
    });

    test('cancelling package input performs no target probe, mutation, refresh, or event', async () => {
        const showInputBox = sinon.stub(windowApis, 'showInputBox').resolves(undefined);
        const event = sinon.stub();
        const subscription = projectManager.onDidChangePackages!(event);

        try {
            await projectManager.manage(environment, { install: [], uninstall: [] });
        } finally {
            subscription.dispose();
        }

        assert.ok(showInputBox.calledOnce);
        assert.ok(runPoetryStub.notCalled);
        assert.ok(packageChangesStub.notCalled);
        assert.ok(event.notCalled);
    });

    test('cancels before target verification when progress is already cancelled', async () => {
        const source = new CancellationTokenSource();
        source.cancel();
        (windowApis.withProgress as sinon.SinonStub).callsFake((_options, task) => task({} as never, source.token));
        const showErrorMessage = sinon.stub(windowApis, 'showErrorMessage').resolves(undefined);
        try {
            await assert.rejects(
                projectManager.manage(environment, { install: ['requests'] }),
                (error: unknown) => error instanceof CancellationError,
            );
        } finally {
            source.dispose();
        }
        await flushImmediate();

        assert.ok(runPoetryStub.notCalled);
        assert.ok(packageChangesStub.notCalled);
        assert.ok(showErrorMessage.notCalled);
    });

    test('cancels after target verification but before mutation without a generic error', async () => {
        const source = new CancellationTokenSource();
        const add = sinon.stub(PoetryAddCommand.prototype, 'execute').resolves();
        const showErrorMessage = sinon.stub(windowApis, 'showErrorMessage').resolves(undefined);
        let targetProbe = 0;
        (windowApis.withProgress as sinon.SinonStub).callsFake((_options, task) => task({} as never, source.token));
        runPoetryStub.callsFake(async (args: string[]) => {
            if (args.includes('env')) {
                targetProbe += 1;
                if (targetProbe === 2) {
                    source.cancel();
                }
                return environmentPath;
            }
            return '';
        });

        try {
            await assert.rejects(
                projectManager.manage(environment, { install: ['requests'] }),
                (error: unknown) => error instanceof CancellationError,
            );
        } finally {
            source.dispose();
        }
        await flushImmediate();

        assert.strictEqual(targetProbe, 2);
        assert.ok(add.notCalled);
        assert.ok(packageChangesStub.notCalled);
        assert.ok(showErrorMessage.notCalled);
    });

    test('project-sensitive reads are unavailable without a project', async () => {
        assert.strictEqual(await manager.getPackages(environment), undefined);
        assert.strictEqual(await manager.getDirectPackageNames(environment), undefined);
        assert.strictEqual(runPoetryStub.callCount, 0);
    });

    test('package management rejects operations without a project', async () => {
        await assert.rejects(
            manager.manage(environment, { install: ['requests'] }),
            /require a Python project/,
        );
        assert.strictEqual(runPoetryStub.callCount, 0);
    });

    test('unbound package management rejects before no-op exits or prompts', async () => {
        const showInputBox = sinon.stub(windowApis, 'showInputBox');

        await assert.rejects(
            manager.manage(environment, { install: [], runHeadless: true }),
            /require a Python project/,
        );
        await assert.rejects(manager.manage(environment, { install: [] }), /require a Python project/);

        assert.ok(showInputBox.notCalled);
        assert.strictEqual(runPoetryStub.callCount, 0);
    });

    test('refresh rejects without a project', async () => {
        await assert.rejects(manager.refresh(environment), PackageManagerRequiresProjectError);
        assert.strictEqual(runPoetryStub.callCount, 0);
    });

    function isEnvironmentMismatch(error: unknown): error is PythonToolError {
        return error instanceof PythonToolError && error.code === 'ENVIRONMENT_MISMATCH';
    }

    async function flushImmediate(): Promise<void> {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }

    async function environmentIdentity(envPath: string): Promise<string> {
        const canonical = await fs.realpath(envPath);
        const stat = await fs.stat(canonical, { bigint: true });
        return stat.ino !== BigInt(0)
            ? `${stat.dev.toString()}:${stat.ino.toString()}`
            : path.resolve(canonical);
    }
});
