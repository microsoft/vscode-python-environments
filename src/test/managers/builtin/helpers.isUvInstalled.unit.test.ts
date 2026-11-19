import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { CancellationError, CancellationTokenSource, LogOutputChannel, Uri, WorkspaceFolder } from 'vscode';
import * as childProcessApis from '../../../common/childProcess.apis';
import * as workspaceApis from '../../../common/workspace.apis';
import { EventNames } from '../../../common/telemetry/constants';
import * as telemetrySender from '../../../common/telemetry/sender';
import {
    getUvExecutable,
    isUvInstalled,
    resetUvInstallationCache,
    runUV,
    setUvExecutable,
} from '../../../managers/builtin/helpers';
import { createMockLogOutputChannel } from '../../mocks/helper';
import { MockChildProcess } from '../../mocks/mockChildProcess';

suite('Helpers - isUvInstalled', () => {
    let mockLog: LogOutputChannel;
    let spawnStub: sinon.SinonStub;
    let sendTelemetryEventStub: sinon.SinonStub;

    setup(() => {
        // Reset UV installation cache before each test to ensure clean state
        setUvExecutable('uv');

        mockLog = createMockLogOutputChannel();

        // Stub childProcess.apis spawnProcess
        spawnStub = sinon.stub(childProcessApis, 'spawnProcess');

        // Stub telemetry
        sendTelemetryEventStub = sinon.stub(telemetrySender, 'sendTelemetryEvent');
    });

    teardown(() => {
        sinon.restore();
        setUvExecutable('uv');
    });

    test('retains a verified installation path across cache resets and uv operations', async () => {
        const executable = path.resolve('uv install', process.platform === 'win32' ? 'uv.exe' : 'uv');
        setUvExecutable(executable);
        const probe = new MockChildProcess(executable, ['--version']);
        spawnStub.withArgs(executable, ['--version']).returns(probe);
        const first = getUvExecutable(mockLog);
        probe.emit('exit', 0, null);
        assert.strictEqual(await first, executable);

        resetUvInstallationCache();
        const second = getUvExecutable(mockLog);
        probe.emit('exit', 0, null);
        assert.strictEqual(await second, executable);

        const operation = new MockChildProcess(executable, ['pip', 'list']);
        spawnStub.withArgs(executable, ['pip', 'list']).returns(operation);
        const result = runUV(['pip', 'list']);
        operation.stdout?.emit('data', '[]');
        operation.emit('exit', 0, null);
        operation.emit('close', 0, null);
        assert.strictEqual(await result, '[]');
        assert(spawnStub.alwaysCalledWith(executable));
    });

    test('does not let an old PATH probe overwrite availability after installation', async () => {
        const oldProcess = new MockChildProcess('uv', ['--version']);
        spawnStub.withArgs('uv', ['--version']).returns(oldProcess);
        const oldProbe = isUvInstalled();

        const executable = path.resolve('installed', process.platform === 'win32' ? 'uv.exe' : 'uv');
        setUvExecutable(executable);
        const installedProcess = new MockChildProcess(executable, ['--version']);
        spawnStub.withArgs(executable, ['--version']).returns(installedProcess);
        const installedProbe = isUvInstalled();
        oldProcess.emit('error', new Error('ENOENT'));
        installedProcess.emit('exit', 0, null);

        assert.strictEqual(await oldProbe, false);
        assert.strictEqual(await installedProbe, true);
        assert.strictEqual(await getUvExecutable(), executable);
    });

    test('does not report a missing installed executable as available', async () => {
        const executable = path.resolve('missing', process.platform === 'win32' ? 'uv.exe' : 'uv');
        setUvExecutable(executable);
        const proc = new MockChildProcess(executable, ['--version']);
        spawnStub.withArgs(executable, ['--version']).returns(proc);
        const result = getUvExecutable();
        proc.emit('error', new Error('ENOENT'));
        assert.strictEqual(await result, undefined);
    });

    test('should return true when uv --version succeeds', async () => {
        // Arrange - Create mock process that simulates successful uv --version
        const mockProcess = new MockChildProcess('uv', ['--version']);
        spawnStub.withArgs('uv', ['--version']).returns(mockProcess);

        // Act - Call isUvInstalled and simulate successful process
        const resultPromise = isUvInstalled(mockLog);

        // Simulate successful uv --version command
        setTimeout(() => {
            mockProcess.stdout?.emit('data', 'uv 0.1.0\n');
            mockProcess.emit('exit', 0, null);
        }, 10);

        const result = await resultPromise;

        // Assert
        assert.strictEqual(result, true);
        assert(
            sendTelemetryEventStub.calledWith(EventNames.VENV_USING_UV),
            'Should send telemetry event when UV is available',
        );
        assert(spawnStub.calledWith('uv', ['--version']), 'Should spawn uv --version command');
    });

    test('should return false when uv --version fails with non-zero exit code', async () => {
        // Arrange - Create mock process that simulates failed uv --version
        const mockProcess = new MockChildProcess('uv', ['--version']);
        spawnStub.withArgs('uv', ['--version']).returns(mockProcess);

        // Act - Call isUvInstalled and simulate failed process
        const resultPromise = isUvInstalled(mockLog);

        // Simulate failed uv --version command
        setTimeout(() => {
            mockProcess.emit('exit', 1, null);
        }, 10);

        const result = await resultPromise;

        // Assert
        assert.strictEqual(result, false);
        assert(sendTelemetryEventStub.notCalled, 'Should not send telemetry event when UV is not available');
        assert(spawnStub.calledWith('uv', ['--version']), 'Should spawn uv --version command');
    });

    test('should return false when uv command is not found (error event)', async () => {
        // Arrange - Create mock process that simulates command not found
        const mockProcess = new MockChildProcess('uv', ['--version']);
        spawnStub.withArgs('uv', ['--version']).returns(mockProcess);

        // Act - Call isUvInstalled and simulate error (command not found)
        const resultPromise = isUvInstalled(mockLog);

        // Simulate error event (e.g., command not found)
        setTimeout(() => {
            mockProcess.emit('error', new Error('spawn uv ENOENT'));
        }, 10);

        const result = await resultPromise;

        // Assert
        assert.strictEqual(result, false);
        assert(sendTelemetryEventStub.notCalled, 'Should not send telemetry event when UV command is not found');
        assert(spawnStub.calledWith('uv', ['--version']), 'Should spawn uv --version command');
    });

    test('should log uv --version command when logger provided', async () => {
        // Arrange - Create mock process
        const mockProcess = new MockChildProcess('uv', ['--version']);
        spawnStub.withArgs('uv', ['--version']).returns(mockProcess);

        // Act - Call isUvInstalled with logger
        const resultPromise = isUvInstalled(mockLog);

        // Simulate successful command with output
        setTimeout(() => {
            mockProcess.stdout?.emit('data', 'uv 0.1.0\n');
            mockProcess.emit('exit', 0, null);
        }, 10);

        await resultPromise;

        // Assert
        assert(
            (mockLog.info as sinon.SinonStub).calledWith('Running: uv --version'),
            'Should log the command being run',
        );
        assert((mockLog.info as sinon.SinonStub).calledWith('uv 0.1.0\n'), 'Should log the command output');
    });

    test('should work without logger', async () => {
        // Arrange - Create mock process
        const mockProcess = new MockChildProcess('uv', ['--version']);
        spawnStub.withArgs('uv', ['--version']).returns(mockProcess);

        // Act - Call isUvInstalled without logger
        const resultPromise = isUvInstalled();

        // Simulate successful command
        setTimeout(() => {
            mockProcess.stdout?.emit('data', 'uv 0.1.0\n');
            mockProcess.emit('exit', 0, null);
        }, 10);

        const result = await resultPromise;

        // Assert
        assert.strictEqual(result, true);
        assert(spawnStub.calledWith('uv', ['--version']), 'Should spawn uv --version command even without logger');
    });

    test('should return cached result on subsequent calls', async () => {
        // Arrange - Create mock process for first call
        const mockProcess = new MockChildProcess('uv', ['--version']);
        spawnStub.withArgs('uv', ['--version']).returns(mockProcess);

        // Act - First call
        const firstCallPromise = isUvInstalled(mockLog);

        // Simulate successful command
        setTimeout(() => {
            mockProcess.stdout?.emit('data', 'uv 0.1.0\n');
            mockProcess.emit('exit', 0, null);
        }, 10);

        const firstResult = await firstCallPromise;

        // Act - Second call (should use cached result)
        const secondResult = await isUvInstalled(mockLog);

        // Assert
        assert.strictEqual(firstResult, true);
        assert.strictEqual(secondResult, true);
        assert(spawnStub.calledOnce, 'Should only spawn process once, second call should use cached result');
    });

    test('should check uv installation again after cache reset', async () => {
        // Arrange - First call
        let mockProcess = new MockChildProcess('uv', ['--version']);
        spawnStub.withArgs('uv', ['--version']).returns(mockProcess);

        const firstCallPromise = isUvInstalled(mockLog);
        setTimeout(() => {
            mockProcess.stdout?.emit('data', 'uv 0.1.0\n');
            mockProcess.emit('exit', 0, null);
        }, 10);

        const firstResult = await firstCallPromise;

        // Act - Reset cache
        resetUvInstallationCache();

        // Arrange - Second call after reset
        mockProcess = new MockChildProcess('uv', ['--version']);
        spawnStub.withArgs('uv', ['--version']).returns(mockProcess);

        const secondCallPromise = isUvInstalled(mockLog);
        setTimeout(() => {
            mockProcess.emit('exit', 1, null); // Simulate failure this time
        }, 10);

        const secondResult = await secondCallPromise;

        // Assert
        assert.strictEqual(firstResult, true);
        assert.strictEqual(secondResult, false);
        assert(spawnStub.calledTwice, 'Should spawn process twice after cache reset');
    });

    test('falls back to the owning workspace pyprojectx executable when uv is not on PATH', async () => {
        const root = path.join(process.cwd(), 'project');
        const uvExecutable = path.join(Uri.file(root).fsPath, '.pyprojectx', 'main', process.platform === 'win32' ? 'uv.exe' : 'uv');
        sinon.stub(workspaceApis, 'isWorkspaceTrusted').returns(true);
        sinon.stub(workspaceApis, 'getWorkspaceFolder').returns({
            name: 'project',
            uri: Uri.file(root),
        } as WorkspaceFolder);
        const globalProc = new MockChildProcess('uv', ['--version']);
        const localProc = new MockChildProcess(uvExecutable, ['--version']);
        spawnStub.withArgs('uv', ['--version']).returns(globalProc);
        spawnStub.withArgs(uvExecutable, ['--version']).returns(localProc);

        const first = getUvExecutable(mockLog, path.join(root, '.venv'));
        globalProc.emit('error', new Error('ENOENT'));
        await new Promise<void>((resolve) => setImmediate(resolve));
        localProc.emit('exit', 0, null);
        assert.strictEqual(await first, uvExecutable);
        assert(spawnStub.calledWith(uvExecutable, ['--version']));
    });

    test('does not execute workspace binaries in an untrusted workspace', async () => {
        sinon.stub(workspaceApis, 'isWorkspaceTrusted').returns(false);
        const getWorkspaceFolder = sinon.stub(workspaceApis, 'getWorkspaceFolder');
        const globalProc = new MockChildProcess('uv', ['--version']);
        spawnStub.withArgs('uv', ['--version']).returns(globalProc);

        const result = getUvExecutable(mockLog, path.join(process.cwd(), 'project', '.venv'));
        globalProc.emit('error', new Error('ENOENT'));
        assert.strictEqual(await result, undefined);
        sinon.assert.notCalled(getWorkspaceFolder);
        sinon.assert.calledOnce(spawnStub);
    });

    test('does not probe uv for a pre-cancelled tool request', async () => {
        const source = new CancellationTokenSource();
        try {
            source.cancel();
            await assert.rejects(getUvExecutable(mockLog, process.cwd(), source.token), CancellationError);
            sinon.assert.notCalled(spawnStub);
        } finally {
            source.dispose();
        }
    });

    test('cancels a tool request while waiting for the workspace uv probe', async () => {
        const root = Uri.file(path.join(process.cwd(), 'project'));
        const executable = path.join(root.fsPath, '.pyprojectx', 'main', process.platform === 'win32' ? 'uv.exe' : 'uv');
        sinon.stub(workspaceApis, 'isWorkspaceTrusted').returns(true);
        sinon.stub(workspaceApis, 'getWorkspaceFolder').returns({ name: 'project', uri: root, index: 0 });
        const globalProc = new MockChildProcess('uv', ['--version']);
        const localProc = new MockChildProcess(executable, ['--version']);
        spawnStub.withArgs('uv', ['--version']).returns(globalProc);
        spawnStub.withArgs(executable, ['--version']).returns(localProc);
        const source = new CancellationTokenSource();
        try {
            const result = getUvExecutable(mockLog, root.fsPath, source.token);
            const rejected = assert.rejects(result, CancellationError);
            globalProc.emit('error', new Error('ENOENT'));
            await new Promise<void>((resolve) => setImmediate(resolve));
            sinon.assert.calledWith(spawnStub, executable, ['--version']);
            source.cancel();
            await rejected;
            localProc.emit('exit', 0, null);
        } finally {
            source.dispose();
        }
    });

    test('prefers uv on PATH without looking up a workspace executable', async () => {
        const getWorkspaceFolder = sinon.stub(workspaceApis, 'getWorkspaceFolder');
        const globalProc = new MockChildProcess('uv', ['--version']);
        spawnStub.withArgs('uv', ['--version']).returns(globalProc);

        const result = getUvExecutable(mockLog, path.join(process.cwd(), 'project', '.venv'));
        globalProc.emit('exit', 0, null);

        assert.strictEqual(await result, 'uv');
        sinon.assert.notCalled(getWorkspaceFolder);
        sinon.assert.calledOnce(spawnStub);
    });

    test('does not use a missing or failing workspace executable', async () => {
        const root = path.join(process.cwd(), 'project');
        const executable = path.join(Uri.file(root).fsPath, '.pyprojectx', 'main', process.platform === 'win32' ? 'uv.exe' : 'uv');
        sinon.stub(workspaceApis, 'isWorkspaceTrusted').returns(true);
        const workspaceFolder = sinon.stub(workspaceApis, 'getWorkspaceFolder');
        workspaceFolder.onFirstCall().returns(undefined);
        workspaceFolder.onSecondCall().returns({ name: 'project', uri: Uri.file(root) } as WorkspaceFolder);
        const globalProc = new MockChildProcess('uv', ['--version']);
        const localProc = new MockChildProcess(executable, ['--version']);
        spawnStub.withArgs('uv', ['--version']).returns(globalProc);
        spawnStub.withArgs(executable, ['--version']).returns(localProc);

        const missing = getUvExecutable(mockLog, path.join(root, '.venv'));
        globalProc.emit('error', new Error('ENOENT'));
        assert.strictEqual(await missing, undefined);

        const failing = getUvExecutable(mockLog, path.join(root, '.venv'));
        await new Promise<void>((resolve) => setImmediate(resolve));
        localProc.emit('exit', 1, null);
        assert.strictEqual(await failing, undefined);
    });

    test('resolves separate workspace executables for different roots', async () => {
        const roots = ['first', 'second'].map((name) => Uri.file(path.join(process.cwd(), name)).fsPath);
        const executables = roots.map((root) =>
            path.join(root, '.pyprojectx', 'main', process.platform === 'win32' ? 'uv.exe' : 'uv'),
        );
        sinon.stub(workspaceApis, 'isWorkspaceTrusted').returns(true);
        sinon.stub(workspaceApis, 'getWorkspaceFolder').callsFake((uri) => {
            const root = roots.find((candidate) => uri.fsPath.startsWith(`${candidate}${path.sep}`));
            return root ? ({ name: path.basename(root), uri: Uri.file(root) } as WorkspaceFolder) : undefined;
        });
        const globalProc = new MockChildProcess('uv', ['--version']);
        spawnStub.withArgs('uv', ['--version']).returns(globalProc);
        for (const [index, root] of roots.entries()) {
            const proc = new MockChildProcess(executables[index], ['--version']);
            spawnStub.withArgs(executables[index], ['--version']).returns(proc);
            const result = getUvExecutable(mockLog, path.join(root, '.venv'));
            if (index === 0) {
                globalProc.emit('error', new Error('ENOENT'));
            }
            await new Promise<void>((resolve) => setImmediate(resolve));
            proc.emit('exit', 0, null);
            assert.strictEqual(await result, executables[index]);
        }
    });
});
