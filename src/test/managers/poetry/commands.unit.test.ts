import assert from 'assert';
import * as sinon from 'sinon';
import { CancellationTokenSource, LogOutputChannel, Uri } from 'vscode';
import * as childProcessApis from '../../../common/childProcess.apis';
import * as workspaceApis from '../../../common/workspace.apis';
import { PoetryAddCommand } from '../../../managers/poetry/commands/add';
import { PoetryRemoveCommand } from '../../../managers/poetry/commands/remove';
import * as poetryRunner from '../../../managers/poetry/commands/runPoetry';
import { PoetryShowCommand } from '../../../managers/poetry/commands/show';
import { PoetryShowTopLevelCommand } from '../../../managers/poetry/commands/showTopLevel';
import { PoetryVersionCommand } from '../../../managers/poetry/commands/version';
import * as poetryUtils from '../../../managers/poetry/poetryUtils';
import { createMockLogOutputChannel } from '../../mocks/helper';
import { MockChildProcess } from '../../mocks/mockChildProcess';

suite('Poetry commands', () => {
    let cwd: string;
    let mockLog: LogOutputChannel;
    let runPoetryStub: sinon.SinonStub;

    setup(() => {
        cwd = Uri.file('project').fsPath;
        mockLog = createMockLogOutputChannel();
        sinon.stub(workspaceApis, 'getConfiguration').returns({
            get: () => undefined,
        } as unknown as ReturnType<typeof workspaceApis.getConfiguration>);
        runPoetryStub = sinon.stub(poetryRunner, 'runPoetry').resolves('');
        sinon.stub(poetryUtils, 'getPoetryVersion').resolves('1.8.2');
    });

    teardown(() => {
        sinon.restore();
    });

    test('PoetryAddCommand builds versioned arguments and preserves cwd', async () => {
        const env = { VIRTUAL_ENV: Uri.file('environment').fsPath };
        const command = new PoetryAddCommand({ pythonExecutable: 'poetry', cwd, log: mockLog });

        await command.execute({ packages: [{ packageName: 'requests', version: '2.32.0' }], env });

        assert.deepStrictEqual(runPoetryStub.firstCall.args.slice(0, 2), [['add', 'requests@2.32.0'], cwd]);
        assert.strictEqual(runPoetryStub.firstCall.args[5], env);
    });

    test('PoetryRemoveCommand builds arguments and preserves cwd', async () => {
        const command = new PoetryRemoveCommand({ pythonExecutable: 'poetry', cwd, log: mockLog });

        await command.execute({ packages: [{ packageName: 'requests' }] });

        assert.deepStrictEqual(runPoetryStub.firstCall.args.slice(0, 2), [['remove', 'requests'], cwd]);
    });

    test('PoetryShowCommand parses packages and preserves cwd', async () => {
        runPoetryStub.resolves(['requests 2.31.0 Python HTTP for Humans.', ''].join('\n'));
        const command = new PoetryShowCommand({ pythonExecutable: 'poetry', cwd, log: mockLog });

        const result = await command.execute();

        assert.deepStrictEqual(runPoetryStub.firstCall.args.slice(0, 2), [['show', '--no-ansi'], cwd]);
        assert.deepStrictEqual(
            result.map((pkg) => ({ name: pkg.name, version: pkg.version, description: pkg.description })),
            [{ name: 'requests', version: '2.31.0', description: '2.31.0 - Python HTTP for Humans.' }],
        );
    });

    test('PoetryShowTopLevelCommand returns normalized names', async () => {
        runPoetryStub.resolves(['Flask_Thing', 'requests'].join('\n'));
        const command = new PoetryShowTopLevelCommand({ pythonExecutable: 'poetry', cwd, log: mockLog });

        const result = await command.execute();

        assert.deepStrictEqual(runPoetryStub.firstCall.args.slice(0, 2), [
            ['show', '--no-ansi', '--top-level'],
            cwd,
        ]);
        assert.deepStrictEqual([...result], ['flask-thing', 'requests']);
    });

    test('runPoetry returns stdout without mixing warning stderr into paths or JSON', async () => {
        runPoetryStub.restore();
        sinon.stub(poetryUtils, 'getPoetry').resolves('poetry');
        const spawnProcess = sinon.stub(childProcessApis, 'spawnProcess').callsFake((_command, args) => {
            const process = new MockChildProcess('poetry', args);
            setImmediate(() => {
                process.stdout?.emit('data', Buffer.from(`${cwd}\n`));
                process.stderr?.emit('data', Buffer.from('A benign Poetry warning\n'));
                process.emit('close', 0, null);
            });
            return process as unknown as ReturnType<typeof childProcessApis.spawnProcess>;
        });

        const output = await poetryRunner.runPoetry(['--no-ansi', 'env', 'info', '--path'], cwd, mockLog);

        assert.strictEqual(output, `${cwd}\n`);
        assert.ok(spawnProcess.calledOnce);
        assert.ok((mockLog.append as sinon.SinonStub).calledWith('poetry: A benign Poetry warning\n'));
    });

    test('runPoetry tool execution returns stdout without mixing warning stderr', async () => {
        runPoetryStub.restore();
        sinon.stub(poetryUtils, 'getPoetry').resolves('poetry');
        const source = new CancellationTokenSource();
        const spawnProcess = sinon.stub(childProcessApis, 'spawnProcess').callsFake((_command, args) => {
            const process = new MockChildProcess('poetry', args);
            setImmediate(() => {
                process.stdout?.emit('data', Buffer.from('{"name":"requests"}\n'));
                process.stderr?.emit('data', Buffer.from('A benign Poetry warning\n'));
                process.emit('close', 0, null);
            });
            return process as unknown as ReturnType<typeof childProcessApis.spawnProcess>;
        });

        try {
            const output = await poetryRunner.runPoetry(
                ['run', 'pip', 'list', '--format=json'],
                cwd,
                mockLog,
                source.token,
                true,
            );

            assert.strictEqual(output, '{"name":"requests"}\n');
            assert.deepStrictEqual(spawnProcess.firstCall.args[1], [
                '--no-interaction',
                'run',
                'pip',
                'list',
                '--format=json',
            ]);
            assert.ok((mockLog.append as sinon.SinonStub).calledWith('A benign Poetry warning\n'));
        } finally {
            source.dispose();
        }
    });

    test('PoetryVersionCommand parses the configured Poetry version', async () => {
        const command = new PoetryVersionCommand({ pythonExecutable: 'poetry', log: mockLog });

        const result = await command.execute();

        assert.ok((poetryUtils.getPoetryVersion as sinon.SinonStub).calledOnceWithExactly('poetry'));
        assert.strictEqual(result?.public, '1.8.2');
    });
});
