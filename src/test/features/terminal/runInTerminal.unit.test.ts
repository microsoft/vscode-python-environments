import assert from 'assert';
import * as sinon from 'sinon';
import { Terminal, TerminalShellIntegration } from 'vscode';
import { runInTerminal } from '../../../features/terminal/runInTerminal';
import { PythonEnvironment, PythonTerminalExecutionOptions } from '../../../api';
import * as shellDetector from '../../../features/common/shellDetector';
import { ShellConstants } from '../../../features/common/shellConstants';

suite('runInTerminal Tests', () => {
    let mockTerminal: sinon.SinonStubbedInstance<Terminal>;
    let mockShellIntegration: sinon.SinonStubbedInstance<TerminalShellIntegration>;
    let mockEnvironment: PythonEnvironment;
    let identifyTerminalShellStub: sinon.SinonStub;

    setup(() => {
        mockTerminal = {
            show: sinon.stub(),
            sendText: sinon.stub(),
            shellIntegration: undefined,
        } as any;

        mockShellIntegration = {
            executeCommand: sinon.stub().returns({} as any),
        } as any;

        mockEnvironment = {
            execInfo: {
                run: {
                    executable: 'C:\\Program Files\\Python\\python.exe',
                    args: [],
                },
            },
        } as any;

        identifyTerminalShellStub = sinon.stub(shellDetector, 'identifyTerminalShell');
    });

    teardown(() => {
        sinon.restore();
    });

    test('PowerShell terminal with shell integration should use sendText instead of executeCommand', async () => {
        // Arrange
        (mockTerminal as any).shellIntegration = mockShellIntegration;
        identifyTerminalShellStub.returns(ShellConstants.PWSH);
        
        const options: PythonTerminalExecutionOptions = {
            args: ['test.py'],
            show: true,
            cwd: 'C:\\workspace',
        };

        // Act
        await runInTerminal(mockEnvironment, mockTerminal, options);

        // Assert
        assert.strictEqual(mockTerminal.show?.callCount, 1);
        assert.strictEqual(mockShellIntegration.executeCommand?.callCount, 0);
        assert.strictEqual(mockTerminal.sendText?.callCount, 1);
        
        const sentText = (mockTerminal.sendText as sinon.SinonStub).getCall(0).args[0];
        assert.ok(sentText.includes('&'));
        assert.ok(sentText.includes('"C:\\Program Files\\Python\\python.exe"'));
        assert.ok(sentText.includes('test.py')); // Without quotes since no spaces
    });

    test('PowerShell terminal without shell integration should use sendText with & prefix', async () => {
        // Arrange
        (mockTerminal as any).shellIntegration = undefined;
        identifyTerminalShellStub.returns(ShellConstants.PWSH);
        
        const options: PythonTerminalExecutionOptions = {
            args: ['test file.py'],
            show: true,
            cwd: 'C:\\workspace',
        };

        // Act
        await runInTerminal(mockEnvironment, mockTerminal, options);

        // Assert
        assert.strictEqual(mockTerminal.show?.callCount, 1);
        assert.strictEqual(mockTerminal.sendText?.callCount, 1);
        
        const sentText = (mockTerminal.sendText as sinon.SinonStub).getCall(0).args[0];
        assert.ok(sentText.includes('&'));
        assert.ok(sentText.includes('"C:\\Program Files\\Python\\python.exe"'));
        assert.ok(sentText.includes('"test file.py"'));
    });

    test('Non-PowerShell terminal without shell integration should use sendText without & prefix', async () => {
        // Arrange
        (mockTerminal as any).shellIntegration = undefined;
        identifyTerminalShellStub.returns(ShellConstants.BASH);
        
        const options: PythonTerminalExecutionOptions = {
            args: ['test.py'],
            show: false,
            cwd: '/workspace',
        };

        // Act
        await runInTerminal(mockEnvironment, mockTerminal, options);

        // Assert
        assert.strictEqual(mockTerminal.show?.callCount, 0);
        assert.strictEqual(mockTerminal.sendText?.callCount, 1);
        
        const sentText = (mockTerminal.sendText as sinon.SinonStub).getCall(0).args[0];
        assert.ok(!sentText.includes('&'));
        assert.ok(sentText.includes('"C:\\Program Files\\Python\\python.exe"'));
        assert.ok(sentText.includes('test.py')); // Without quotes since no spaces
    });

    test('Should handle environment with activatedRun executable', async () => {
        // Arrange
        (mockTerminal as any).shellIntegration = undefined;
        identifyTerminalShellStub.returns(ShellConstants.PWSH);
        
        const envWithActivatedRun: PythonEnvironment = {
            execInfo: {
                run: {
                    executable: 'python',
                    args: [],
                },
                activatedRun: {
                    executable: 'C:\\venv\\Scripts\\python.exe',
                    args: ['-u'],
                },
            },
        } as any;

        const options: PythonTerminalExecutionOptions = {
            args: ['script.py'],
            show: false,
            cwd: 'C:\\workspace',
        };

        // Act
        await runInTerminal(envWithActivatedRun, mockTerminal, options);

        // Assert
        assert.strictEqual(mockTerminal.sendText?.callCount, 1);
        
        const sentText = (mockTerminal.sendText as sinon.SinonStub).getCall(0).args[0];
        assert.ok(sentText.includes('&'));
        assert.ok(sentText.includes('C:\\venv\\Scripts\\python.exe')); // May or may not have quotes
        assert.ok(sentText.includes('-u'));
        assert.ok(sentText.includes('script.py')); // Without quotes since no spaces
    });
});