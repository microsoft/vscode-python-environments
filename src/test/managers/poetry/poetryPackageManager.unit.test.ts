// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { FileType, LogOutputChannel, Uri } from 'vscode';
import { PythonEnvironmentApi } from '../../../api';
import * as windowApis from '../../../common/window.apis';
import * as workspaceFs from '../../../common/workspace.fs.apis';
import * as packageChanges from '../../../managers/common/packageChanges';
import * as runPoetryModule from '../../../managers/poetry/commands/runPoetry';
import { PoetryPackageManager } from '../../../managers/poetry/poetryPackageManager';
import { PoetryManager } from '../../../managers/poetry/poetryManager';
import * as poetryUtils from '../../../managers/poetry/poetryUtils';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

suite('PoetryPackageManager', () => {
    const environment = createMockPythonEnvironment({
        envPath: path.join(process.cwd(), '.venv'),
        managerId: 'ms-python.python:poetry',
    });
    let logError: sinon.SinonStub;
    let manager: PoetryPackageManager;
    let projectManager: PoetryPackageManager;
    let runPoetryStub: sinon.SinonStub;
    let statStub: sinon.SinonStub;
    const projectUri = Uri.file(path.join(process.cwd(), 'project', 'pyproject.toml'));

    setup(() => {
        const api = {} as PythonEnvironmentApi;
        logError = sinon.stub();
        const log = {
            append: sinon.stub(),
            error: logError,
            info: sinon.stub(),
            show: sinon.stub(),
        } as unknown as LogOutputChannel;

        sinon.stub(poetryUtils, 'getPoetry').resolves('poetry');
        sinon.stub(windowApis, 'withProgress').callsFake((_options, task) => task({} as never, {} as never));
        sinon.stub(packageChanges, 'updatePackagesAndNotify').resolves([]);
        runPoetryStub = sinon.stub(runPoetryModule, 'runPoetry').resolves('');
        statStub = sinon.stub(workspaceFs, 'stat');
        statStub.resolves({ type: FileType.File, ctime: 0, mtime: 0, size: 0 });
        manager = new PoetryPackageManager(api, log, {} as PoetryManager);
        projectManager = manager.createForProject({ name: 'project', uri: projectUri });
    });

    teardown(() => {
        manager.dispose();
        sinon.restore();
    });

    test('package management uses the project working directory', async () => {
        await projectManager.manage(environment, { install: ['requests'], uninstall: ['flask'] });

        assert.strictEqual(runPoetryStub.callCount, 2);
        assert.strictEqual(runPoetryStub.firstCall.args[1], path.dirname(projectUri.fsPath));
        assert.strictEqual(runPoetryStub.secondCall.args[1], path.dirname(projectUri.fsPath));
    });

    test('direct package listing uses the project working directory', async () => {
        await projectManager.getDirectPackageNames(environment);

        assert.strictEqual(runPoetryStub.callCount, 1);
        assert.strictEqual(runPoetryStub.firstCall.args[1], path.dirname(projectUri.fsPath));
    });

    test('directory project URIs are used directly as the working directory', async () => {
        const directoryUri = Uri.file(process.cwd());
        statStub.withArgs(directoryUri).resolves({ type: FileType.Directory, ctime: 0, mtime: 0, size: 0 });
        const directoryManager = manager.createForProject({ name: 'directory-project', uri: directoryUri });

        await directoryManager.getDirectPackageNames(environment);

        assert.strictEqual(runPoetryStub.callCount, 1);
        assert.strictEqual(runPoetryStub.firstCall.args[1], directoryUri.fsPath);
    });

    test('symlinked directory project URIs are used directly as the working directory', async () => {
        const symlinkedDirectoryUri = Uri.file(path.join(process.cwd(), 'symlinked-project'));
        statStub
            .withArgs(symlinkedDirectoryUri)
            .resolves({ type: FileType.Directory | FileType.SymbolicLink, ctime: 0, mtime: 0, size: 0 });
        const symlinkedDirectoryManager = manager.createForProject({
            name: 'symlinked-directory-project',
            uri: symlinkedDirectoryUri,
        });

        await symlinkedDirectoryManager.getDirectPackageNames(environment);

        assert.strictEqual(runPoetryStub.callCount, 1);
        assert.strictEqual(runPoetryStub.firstCall.args[1], symlinkedDirectoryUri.fsPath);
    });

    test('inaccessible projects reject instead of falling back to the parent directory', async () => {
        const inaccessibleUri = Uri.file(path.join(process.cwd(), 'missing-project'));
        statStub.withArgs(inaccessibleUri).rejects(new Error('access denied'));
        const inaccessibleManager = manager.createForProject({ name: 'missing', uri: inaccessibleUri });

        await assert.rejects(
            inaccessibleManager.manage(environment, { install: ['requests'] }),
            /Unable to access the Python project/,
        );

        assert.strictEqual(runPoetryStub.callCount, 0);
    });

    test('package loading returns an empty list when poetry show fails', async () => {
        const showError = new Error('poetry show failed');
        runPoetryStub.rejects(showError);

        const packages = await projectManager.getPackages(environment, { skipCache: true });

        assert.deepStrictEqual(packages, []);
        assert.ok(logError.calledOnceWithExactly(`Error refreshing packages with Poetry: ${showError}`));
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

    test('refresh is a no-op without a project', async () => {
        await manager.refresh(environment);
        assert.strictEqual(runPoetryStub.callCount, 0);
    });
});
