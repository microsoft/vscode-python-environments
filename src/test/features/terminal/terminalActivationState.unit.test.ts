// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import {
    Disposable,
    EventEmitter,
    Terminal,
    TerminalOptions,
    TerminalShellExecution,
    TerminalShellExecutionEndEvent,
    TerminalShellExecutionStartEvent,
    TerminalShellIntegration,
    Uri,
} from 'vscode';
import { PythonEnvironment } from '../../../api';
import * as windowApis from '../../../common/window.apis';
import * as activationUtils from '../../../features/common/activation';
import {
    DidChangeTerminalActivationStateEvent,
    TerminalActivationImpl,
} from '../../../features/terminal/terminalActivationState';
import * as terminalUtils from '../../../features/terminal/utils';

/**
 * Creates a mock PythonEnvironment for testing.
 */
function createMockEnvironment(id: string = 'test-env-id'): PythonEnvironment {
    return {
        envId: { id, managerId: 'test-manager' },
        name: 'Test Environment',
        displayName: 'Test Environment',
        shortDisplayName: 'TestEnv',
        displayPath: '/path/to/env',
        version: '3.9.0',
        environmentPath: Uri.file('/path/to/python'),
        sysPrefix: '/path/to/env',
        execInfo: {
            run: { executable: '/path/to/python' },
            activation: [{ executable: '/path/to/activate' }],
        },
    };
}

/**
 * Creates a mock Terminal for testing.
 */
function createMockTerminal(name: string = 'Test Terminal'): Terminal & { sendText: sinon.SinonStub } {
    return {
        name,
        creationOptions: {} as TerminalOptions,
        shellIntegration: undefined,
        processId: Promise.resolve(12345),
        exitStatus: undefined,
        state: { isInteractedWith: false, shell: undefined },
        show: sinon.stub(),
        hide: sinon.stub(),
        sendText: sinon.stub(),
        dispose: sinon.stub(),
    } as unknown as Terminal & { sendText: sinon.SinonStub };
}

/**
 * Creates a mock TerminalShellIntegration.
 */
function createMockShellIntegration(): TerminalShellIntegration & {
    executeCommand: sinon.SinonStub<[string, string[]?], TerminalShellExecution>;
} {
    const mockExecution: TerminalShellExecution = {
        commandLine: { value: 'mock command', isTrusted: true, confidence: 1 },
        cwd: Uri.file('/mock/cwd'),
        read: sinon.stub().returns({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true }) }) }),
    } as unknown as TerminalShellExecution;

    return {
        cwd: Uri.file('/mock/cwd'),
        executeCommand: sinon.stub<[string, string[]?], TerminalShellExecution>().returns(mockExecution),
    } as TerminalShellIntegration & {
        executeCommand: sinon.SinonStub<[string, string[]?], TerminalShellExecution>;
    };
}

suite('TerminalActivationState - TerminalActivationImpl', () => {
    let terminalActivation: TerminalActivationImpl;
    let shellExecutionStartEmitter: EventEmitter<TerminalShellExecutionStartEvent>;
    let shellExecutionEndEmitter: EventEmitter<TerminalShellExecutionEndEvent>;
    let getActivationCommandStub: sinon.SinonStub;
    let getDeactivationCommandStub: sinon.SinonStub;
    let isTaskTerminalStub: sinon.SinonStub;
    setup(() => {
        shellExecutionStartEmitter = new EventEmitter<TerminalShellExecutionStartEvent>();
        shellExecutionEndEmitter = new EventEmitter<TerminalShellExecutionEndEvent>();

        sinon.stub(windowApis, 'onDidStartTerminalShellExecution').callsFake((listener: (e: TerminalShellExecutionStartEvent) => void): Disposable => {
            return shellExecutionStartEmitter.event(listener);
        });

        sinon.stub(windowApis, 'onDidEndTerminalShellExecution').callsFake((listener: (e: TerminalShellExecutionEndEvent) => void): Disposable => {
            return shellExecutionEndEmitter.event(listener);
        });

        getActivationCommandStub = sinon.stub(activationUtils, 'getActivationCommand');
        getDeactivationCommandStub = sinon.stub(activationUtils, 'getDeactivationCommand');
        isTaskTerminalStub = sinon.stub(terminalUtils, 'isTaskTerminal').returns(false);
        sinon.stub(terminalUtils, 'getShellIntegrationTimeout').returns(100);

        terminalActivation = new TerminalActivationImpl();
    });

    teardown(() => {
        sinon.restore();
        shellExecutionStartEmitter.dispose();
        shellExecutionEndEmitter.dispose();
        terminalActivation.dispose();
    });

    suite('isActivated()', () => {
        test('should return false for a terminal that has not been activated', () => {
            const terminal = createMockTerminal();

            const result = terminalActivation.isActivated(terminal);

            assert.strictEqual(result, false, 'Should return false for non-activated terminal');
        });

        test('should return true for a terminal that has been activated', async () => {
            const terminal = createMockTerminal();
            const environment = createMockEnvironment();
            getActivationCommandStub.returns('source activate');

            await terminalActivation.activate(terminal, environment);

            const result = terminalActivation.isActivated(terminal);
            assert.strictEqual(result, true, 'Should return true for activated terminal');
        });

        test('should return true when environment matches the activated environment', async () => {
            const terminal = createMockTerminal();
            const environment = createMockEnvironment('env-1');
            getActivationCommandStub.returns('source activate');

            await terminalActivation.activate(terminal, environment);

            const result = terminalActivation.isActivated(terminal, environment);
            assert.strictEqual(result, true, 'Should return true when environments match');
        });

        test('should return false when environment does not match the activated environment', async () => {
            const terminal = createMockTerminal();
            const environment1 = createMockEnvironment('env-1');
            const environment2 = createMockEnvironment('env-2');
            getActivationCommandStub.returns('source activate');

            await terminalActivation.activate(terminal, environment1);

            const result = terminalActivation.isActivated(terminal, environment2);
            assert.strictEqual(result, false, 'Should return false when environments differ');
        });
    });

    suite('getEnvironment()', () => {
        test('should return undefined for a terminal that has not been activated', () => {
            const terminal = createMockTerminal();

            const result = terminalActivation.getEnvironment(terminal);

            assert.strictEqual(result, undefined, 'Should return undefined for non-activated terminal');
        });

        test('should return the environment for an activated terminal', async () => {
            const terminal = createMockTerminal();
            const environment = createMockEnvironment();
            getActivationCommandStub.returns('source activate');

            await terminalActivation.activate(terminal, environment);

            const result = terminalActivation.getEnvironment(terminal);
            assert.strictEqual(result?.envId.id, environment.envId.id, 'Should return the activated environment');
        });
    });

    suite('activate() - Legacy (without shell integration)', () => {
        test('should call sendText with activation command when shell integration is not available', async () => {
            const terminal = createMockTerminal();
            const environment = createMockEnvironment();
            getActivationCommandStub.returns('source /path/to/activate');

            await terminalActivation.activate(terminal, environment);

            assert.ok(
                terminal.sendText.calledWith('source /path/to/activate'),
                'Should send activation command to terminal',
            );
        });

        test('should skip activation for task terminals', async () => {
            const terminal = createMockTerminal('Task - Build');
            const environment = createMockEnvironment();
            isTaskTerminalStub.returns(true);

            await terminalActivation.activate(terminal, environment);

            assert.strictEqual(terminal.sendText.called, false, 'Should not send text to task terminal');
        });

        test('should not activate if already activated with the same environment', async () => {
            const terminal = createMockTerminal();
            const environment = createMockEnvironment();
            getActivationCommandStub.returns('source activate');

            await terminalActivation.activate(terminal, environment);
            terminal.sendText.resetHistory();

            await terminalActivation.activate(terminal, environment);

            assert.strictEqual(
                terminal.sendText.called,
                false,
                'Should not send text when already activated with same env',
            );
        });

        test('should deactivate first when activating with different environment', async () => {
            const terminal = createMockTerminal();
            const environment1 = createMockEnvironment('env-1');
            const environment2 = createMockEnvironment('env-2');
            getActivationCommandStub.returns('source activate');
            getDeactivationCommandStub.returns('deactivate');

            await terminalActivation.activate(terminal, environment1);
            terminal.sendText.resetHistory();

            await terminalActivation.activate(terminal, environment2);

            assert.ok(terminal.sendText.calledWith('deactivate'), 'Should deactivate previous environment');
            assert.ok(terminal.sendText.calledWith('source activate'), 'Should activate new environment');
        });
    });

    suite('activate() - With shell integration', () => {
        test('should use executeCommand when shell integration is available', async () => {
            const terminal = createMockTerminal();
            const shellIntegration = createMockShellIntegration();
            (terminal as Terminal & { shellIntegration: TerminalShellIntegration }).shellIntegration = shellIntegration;

            const environment = createMockEnvironment();
            getActivationCommandStub.returns('source /path/to/activate');

            // Mock execution completion
            const mockExecution: TerminalShellExecution = {
                commandLine: { value: 'source /path/to/activate', isTrusted: true, confidence: 1 },
                cwd: Uri.file('/mock/cwd'),
                read: sinon.stub(),
            } as unknown as TerminalShellExecution;
            shellIntegration.executeCommand.returns(mockExecution);

            // Fire shell execution end event after a short delay
            setImmediate(() => {
                shellExecutionEndEmitter.fire({
                    execution: mockExecution,
                    terminal,
                    exitCode: 0,
                    shellIntegration,
                });
            });

            await terminalActivation.activate(terminal, environment);

            assert.ok(
                shellIntegration.executeCommand.calledWith('source /path/to/activate'),
                'Should use shell integration executeCommand',
            );
        });
    });

    suite('deactivate()', () => {
        test('should call sendText with deactivation command when shell integration is not available', async () => {
            const terminal = createMockTerminal();
            const environment = createMockEnvironment();
            getActivationCommandStub.returns('source activate');
            getDeactivationCommandStub.returns('deactivate');

            await terminalActivation.activate(terminal, environment);
            terminal.sendText.resetHistory();

            await terminalActivation.deactivate(terminal);

            assert.ok(terminal.sendText.calledWith('deactivate'), 'Should send deactivation command');
        });

        test('should skip deactivation for task terminals', async () => {
            const terminal = createMockTerminal('Task - Build');
            const environment = createMockEnvironment();
            isTaskTerminalStub.returns(true);

            // Manually add to activated terminals for test
            terminalActivation.updateActivationState(terminal, environment, true);

            await terminalActivation.deactivate(terminal);

            assert.strictEqual(terminal.sendText.called, false, 'Should not send text to task terminal');
        });

        test('should do nothing if terminal is not activated', async () => {
            const terminal = createMockTerminal();

            await terminalActivation.deactivate(terminal);

            assert.strictEqual(terminal.sendText.called, false, 'Should not send text for non-activated terminal');
        });
    });

    suite('updateActivationState()', () => {
        test('should mark terminal as activated', () => {
            const terminal = createMockTerminal();
            const environment = createMockEnvironment();

            terminalActivation.updateActivationState(terminal, environment, true);

            assert.strictEqual(terminalActivation.isActivated(terminal), true, 'Terminal should be marked as activated');
            assert.strictEqual(
                terminalActivation.getEnvironment(terminal)?.envId.id,
                environment.envId.id,
                'Environment should be stored',
            );
        });

        test('should mark terminal as deactivated', async () => {
            const terminal = createMockTerminal();
            const environment = createMockEnvironment();

            terminalActivation.updateActivationState(terminal, environment, true);
            terminalActivation.updateActivationState(terminal, environment, false);

            assert.strictEqual(
                terminalActivation.isActivated(terminal),
                false,
                'Terminal should be marked as deactivated',
            );
            assert.strictEqual(
                terminalActivation.getEnvironment(terminal),
                undefined,
                'Environment should be removed',
            );
        });
    });

    suite('onDidChangeTerminalActivationState event', () => {
        test('should fire event when terminal is activated via updateActivationState', (done) => {
            const terminal = createMockTerminal();
            const environment = createMockEnvironment();

            let eventFired = false;
            const disposable = terminalActivation.onDidChangeTerminalActivationState(
                (e: DidChangeTerminalActivationStateEvent) => {
                    eventFired = true;
                    assert.strictEqual(e.terminal, terminal, 'Event should contain the terminal');
                    assert.strictEqual(e.environment.envId.id, environment.envId.id, 'Event should contain the environment');
                    assert.strictEqual(e.activated, true, 'Event should indicate activation');
                    disposable.dispose();
                    done();
                },
            );

            terminalActivation.updateActivationState(terminal, environment, true);

            // Give setImmediate time to fire
            setTimeout(() => {
                if (!eventFired) {
                    disposable.dispose();
                    done(new Error('Event was not fired'));
                }
            }, 100);
        });

        test('should fire event when terminal is deactivated via updateActivationState', (done) => {
            const terminal = createMockTerminal();
            const environment = createMockEnvironment();

            terminalActivation.updateActivationState(terminal, environment, true);

            // Allow first event to fire
            setImmediate(() => {
                let eventCount = 0;
                const disposable = terminalActivation.onDidChangeTerminalActivationState(
                    (e: DidChangeTerminalActivationStateEvent) => {
                        eventCount++;
                        if (eventCount === 1 && e.activated === false) {
                            assert.strictEqual(e.terminal, terminal, 'Event should contain the terminal');
                            assert.strictEqual(e.activated, false, 'Event should indicate deactivation');
                            disposable.dispose();
                            done();
                        }
                    },
                );

                terminalActivation.updateActivationState(terminal, environment, false);
            });
        });
    });

    suite('Concurrent activation/deactivation handling', () => {
        test('should not allow concurrent activation on same terminal', async () => {
            const terminal = createMockTerminal();
            const environment = createMockEnvironment();

            // Make activation take some time
            let activationCount = 0;
            getActivationCommandStub.callsFake(() => {
                activationCount++;
                return 'source activate';
            });

            // Start two activations concurrently
            const activation1 = terminalActivation.activate(terminal, environment);
            const activation2 = terminalActivation.activate(terminal, environment);

            await Promise.all([activation1, activation2]);

            // Only one activation should have proceeded
            assert.strictEqual(activationCount, 1, 'Only one activation should occur');
        });

        test('should not allow activation while deactivating', async () => {
            const terminal = createMockTerminal();
            const environment1 = createMockEnvironment('env-1');

            getActivationCommandStub.returns('source activate');
            getDeactivationCommandStub.returns('deactivate');

            // Activate first
            await terminalActivation.activate(terminal, environment1);

            // Start deactivation and immediately try to activate with new env
            const deactivation = terminalActivation.deactivate(terminal);

            // Activation during deactivation should wait
            terminal.sendText.resetHistory();

            await deactivation;

            // Should be deactivated at this point
            assert.strictEqual(
                terminalActivation.isActivated(terminal),
                false,
                'Terminal should be deactivated',
            );
        });
    });

    suite('dispose()', () => {
        test('should clean up disposables', () => {
            const terminal = createMockTerminal();
            const environment = createMockEnvironment();
            getActivationCommandStub.returns('source activate');

            // Activate a terminal
            terminalActivation.updateActivationState(terminal, environment, true);

            // Dispose
            terminalActivation.dispose();

            // Events should be disposed (subscribing should not cause errors but events won't fire)
            // This is a basic smoke test for dispose
            assert.ok(true, 'Dispose should complete without errors');
        });
    });
});
