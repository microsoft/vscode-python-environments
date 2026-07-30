import assert from 'assert';
import * as sinon from 'sinon';
import { LogOutputChannel } from 'vscode';
import * as workspaceApis from '../../../common/workspace.apis';
import { PoetryAddCommand } from '../../../managers/poetry/commands/add';
import { PoetryRemoveCommand } from '../../../managers/poetry/commands/remove';
import * as poetryRunner from '../../../managers/poetry/commands/runPoetry';
import { PoetryShowCommand } from '../../../managers/poetry/commands/show';
import { PoetryShowTopLevelCommand } from '../../../managers/poetry/commands/showTopLevel';
import { PoetryVersionCommand } from '../../../managers/poetry/commands/version';
import * as poetryUtils from '../../../managers/poetry/poetryUtils';
import { createMockLogOutputChannel } from '../../mocks/helper';

suite('Poetry commands', () => {
    let mockLog: LogOutputChannel;
    let runPoetryStub: sinon.SinonStub;

    setup(() => {
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

    // Mutation commands have no output to parse; unit coverage is a smoke test that
    // execute() resolves. Their concrete command strings are exercised by integration tests.
    suite('mutation commands execute without error', () => {
        test('PoetryAddCommand', async () => {
            const command = new PoetryAddCommand({ pythonExecutable: 'poetry', cwd: 'project', log: mockLog });
            await assert.doesNotReject(() => command.execute({ packages: [{ packageName: 'package' }] }));
        });

        test('PoetryRemoveCommand', async () => {
            const command = new PoetryRemoveCommand({ pythonExecutable: 'poetry', cwd: 'project', log: mockLog });
            await assert.doesNotReject(() => command.execute({ packages: [{ packageName: 'package' }] }));
        });
    });

    test('PoetryShowCommand parses name, version and description', async () => {
        runPoetryStub.resolves(['requests 2.31.0 Python HTTP for Humans.', ''].join('\n'));
        const command = new PoetryShowCommand({ pythonExecutable: 'poetry', cwd: 'project', log: mockLog });

        const result = await command.execute();

        assert.deepStrictEqual(
            result.map((p) => ({ name: p.name, version: p.version, description: p.description })),
            [{ name: 'requests', version: '2.31.0', description: '2.31.0 - Python HTTP for Humans.' }],
        );
    });

    test('PoetryShowTopLevelCommand returns normalized names', async () => {
        runPoetryStub.resolves(['Flask_Thing', 'requests'].join('\n'));
        const command = new PoetryShowTopLevelCommand({ pythonExecutable: 'poetry', cwd: 'project', log: mockLog });

        const result = await command.execute();

        assert.deepStrictEqual([...result], ['flask-thing', 'requests']);
    });

    test('PoetryVersionCommand parses the poetry version', async () => {
        const command = new PoetryVersionCommand({ pythonExecutable: 'poetry', log: mockLog });

        const result = await command.execute();

        assert.strictEqual(result?.public, '1.8.2');
    });
});
