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

    test('PoetryAddCommand executes without error', async () => {
        const command = new PoetryAddCommand({ pythonExecutable: 'poetry', cwd: 'project', log: mockLog });

        await assert.doesNotReject(() => command.execute({ packages: [{ packageName: 'package' }] }));
    });

    test('PoetryRemoveCommand executes without error', async () => {
        const command = new PoetryRemoveCommand({ pythonExecutable: 'poetry', cwd: 'project', log: mockLog });

        await assert.doesNotReject(() => command.execute({ packages: [{ packageName: 'package' }] }));
    });

    test('PoetryShowCommand executes without error', async () => {
        runPoetryStub.resolves('package 1.0.0 description');
        const command = new PoetryShowCommand({ pythonExecutable: 'poetry', cwd: 'project', log: mockLog });

        await assert.doesNotReject(() => command.execute());
    });

    test('PoetryShowTopLevelCommand executes without error', async () => {
        runPoetryStub.resolves('package');
        const command = new PoetryShowTopLevelCommand({ pythonExecutable: 'poetry', cwd: 'project', log: mockLog });

        await assert.doesNotReject(() => command.execute());
    });

    test('PoetryVersionCommand executes without error', async () => {
        const command = new PoetryVersionCommand({ pythonExecutable: 'poetry', log: mockLog });

        await assert.doesNotReject(() => command.execute());
    });
});