import * as assert from 'assert';
import * as sinon from 'sinon';
import { Terminal } from 'vscode';
import { PythonEnvironment } from '../../../api';
import * as commandApi from '../../../common/command.api';
import * as activation from '../../../features/common/activation';
import { setActivateMenuButtonContext } from '../../../features/terminal/activateMenuButton';
import * as utils from '../../../features/terminal/utils';

suite('Terminal - Activate Menu Button', () => {
    let executeCommandStub: sinon.SinonStub;
    let isTaskTerminalStub: sinon.SinonStub;
    let isActivatableEnvironmentStub: sinon.SinonStub;

    const mockTerminal = { name: 'test-terminal' } as Terminal;
    const mockEnv = {} as PythonEnvironment; // Stubbed, so no properties needed

    setup(() => {
        executeCommandStub = sinon.stub(commandApi, 'executeCommand').resolves();
        isTaskTerminalStub = sinon.stub(utils, 'isTaskTerminal');
        isActivatableEnvironmentStub = sinon.stub(activation, 'isActivatableEnvironment');
    });

    teardown(() => {
        sinon.restore();
    });

    test('should show activate icon when isTaskTerminal returns false', async () => {
        // Arrange: terminal is NOT a task terminal, env is activatable
        isTaskTerminalStub.returns(false);
        isActivatableEnvironmentStub.returns(true);

        // Act
        await setActivateMenuButtonContext(mockTerminal, mockEnv);

        // Assert: icon should be shown (pythonTerminalActivation = true)
        assert.ok(
            executeCommandStub.calledWith('setContext', 'pythonTerminalActivation', true),
            'Should set pythonTerminalActivation to true for non-task terminal',
        );
    });

    test('should hide activate icon when isTaskTerminal returns true', async () => {
        // Arrange: terminal IS a task terminal (even if env is activatable)
        isTaskTerminalStub.returns(true);
        isActivatableEnvironmentStub.returns(true);

        // Act
        await setActivateMenuButtonContext(mockTerminal, mockEnv);

        // Assert: icon should be hidden (pythonTerminalActivation = false)
        assert.ok(
            executeCommandStub.calledWith('setContext', 'pythonTerminalActivation', false),
            'Should set pythonTerminalActivation to false for task terminal',
        );
    });
});
