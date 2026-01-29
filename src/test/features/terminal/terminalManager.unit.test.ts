// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { Disposable, Event, EventEmitter, Progress, Terminal, TerminalOptions, Uri } from 'vscode';
import { PythonEnvironment } from '../../../api';
import * as windowApis from '../../../common/window.apis';
import * as workspaceApis from '../../../common/workspace.apis';
import * as activationUtils from '../../../features/common/activation';
import {
    ShellEnvsProvider,
    ShellStartupScriptProvider,
} from '../../../features/terminal/shells/startupProvider';
import {
    DidChangeTerminalActivationStateEvent,
    TerminalActivationInternal,
} from '../../../features/terminal/terminalActivationState';
import { TerminalManagerImpl } from '../../../features/terminal/terminalManager';
import * as terminalUtils from '../../../features/terminal/utils';

/**
 * Test implementation of TerminalActivationInternal that tracks method calls.
 */
class TestTerminalActivation implements TerminalActivationInternal {
    public callOrder: string[] = [];
    public activateCalls = 0;
    public deactivateCalls = 0;

    private onDidChangeEmitter = new EventEmitter<DidChangeTerminalActivationStateEvent>();
    public onDidChangeTerminalActivationState: Event<DidChangeTerminalActivationStateEvent> =
        this.onDidChangeEmitter.event;

    isActivated(_terminal: Terminal, _environment?: PythonEnvironment): boolean {
        return false;
    }

    async activate(_terminal: Terminal, _environment: PythonEnvironment): Promise<void> {
        this.activateCalls += 1;
        this.callOrder.push('activate');
    }

    async deactivate(_terminal: Terminal): Promise<void> {
        this.deactivateCalls += 1;
    }

    getEnvironment(_terminal: Terminal): PythonEnvironment | undefined {
        return undefined;
    }

    updateActivationState(_terminal: Terminal, _environment: PythonEnvironment, _activated: boolean): void {
        // Not used in these tests
    }

    dispose(): void {
        this.onDidChangeEmitter.dispose();
    }
}

suite('TerminalManager - create()', () => {
    let terminalActivation: TestTerminalActivation;
    let mockGetAutoActivationType: sinon.SinonStub;
    let terminalManager: TerminalManagerImpl;
    let mockTerminal: Partial<Terminal> & { show: sinon.SinonStub };

    const createMockEnvironment = (): PythonEnvironment => ({
        envId: { id: 'test-env-id', managerId: 'test-manager' },
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
    });

    setup(() => {
        terminalActivation = new TestTerminalActivation();

        mockTerminal = {
            name: 'Test Terminal',
            creationOptions: {} as TerminalOptions,
            shellIntegration: undefined,
            show: sinon.stub().callsFake(() => {
                terminalActivation.callOrder.push('show');
            }),
            sendText: sinon.stub(),
        };

        mockGetAutoActivationType = sinon.stub(terminalUtils, 'getAutoActivationType');
        sinon.stub(terminalUtils, 'waitForShellIntegration').resolves(false);
        sinon.stub(activationUtils, 'isActivatableEnvironment').returns(true);

        sinon.stub(windowApis, 'createTerminal').returns(mockTerminal as Terminal);
        sinon.stub(windowApis, 'onDidOpenTerminal').returns(new Disposable(() => {}));
        sinon.stub(windowApis, 'onDidCloseTerminal').returns(new Disposable(() => {}));
        sinon.stub(windowApis, 'onDidChangeWindowState').returns(new Disposable(() => {}));
        sinon.stub(windowApis, 'terminals').returns([]);
        sinon.stub(windowApis, 'withProgress').callsFake(async (_options, task) => {
            const mockProgress: Progress<{ message?: string; increment?: number }> = { report: () => {} };
            const mockCancellationToken = {
                isCancellationRequested: false,
                onCancellationRequested: () => new Disposable(() => {}),
            };
            return task(mockProgress, mockCancellationToken as never);
        });

        sinon.stub(workspaceApis, 'onDidChangeConfiguration').returns(new Disposable(() => {}));
    });

    teardown(() => {
        sinon.restore();
        terminalActivation.dispose();
    });

    function createTerminalManager(): TerminalManagerImpl {
        const emptyEnvProviders: ShellEnvsProvider[] = [];
        const emptyScriptProviders: ShellStartupScriptProvider[] = [];
        return new TerminalManagerImpl(terminalActivation, emptyEnvProviders, emptyScriptProviders);
    }

    // Regression test for https://github.com/microsoft/vscode-python-environments/issues/640
    // With ACT_TYPE_COMMAND, create() awaits activation which blocks returning the terminal.
    // Without showing the terminal early, users wouldn't see it until activation completes (2-5 seconds).
    test('ACT_TYPE_COMMAND: shows terminal before awaiting activation to prevent hidden terminal during activation', async () => {
        // Mock
        mockGetAutoActivationType.returns(terminalUtils.ACT_TYPE_COMMAND);
        terminalManager = createTerminalManager();

        // Run
        const env = createMockEnvironment();
        await terminalManager.create(env, { cwd: '/workspace' });

        // Assert - show() must be called before activate() so terminal is visible during activation
        const { callOrder } = terminalActivation;
        assert.ok(callOrder.includes('show'), 'Terminal show() should be called');
        assert.ok(callOrder.includes('activate'), 'Terminal activate() should be called');
        const showIndex = callOrder.indexOf('show');
        const activateIndex = callOrder.indexOf('activate');
        assert.ok(
            showIndex < activateIndex,
            `show() at index ${showIndex} must precede activate() at index ${activateIndex}`,
        );
    });

    // With ACT_TYPE_SHELL/OFF, create() returns immediately without blocking.
    // The caller (runInTerminal) handles showing the terminal, so create() shouldn't call show().
    test('ACT_TYPE_SHELL: does not call show() since create() returns immediately and caller handles visibility', async () => {
        // Mock
        mockGetAutoActivationType.returns(terminalUtils.ACT_TYPE_SHELL);
        terminalManager = createTerminalManager();

        // Run
        const env = createMockEnvironment();
        await terminalManager.create(env, { cwd: '/workspace' });

        // Assert - no blocking activation means caller (runInTerminal) will show terminal
        const { callOrder } = terminalActivation;
        assert.strictEqual(callOrder.includes('show'), false, 'show() deferred to caller');
        assert.strictEqual(callOrder.includes('activate'), false, 'No command activation for shell startup mode');
    });

    test('ACT_TYPE_OFF: does not call show() since create() returns immediately and caller handles visibility', async () => {
        // Mock
        mockGetAutoActivationType.returns(terminalUtils.ACT_TYPE_OFF);
        terminalManager = createTerminalManager();

        // Run
        const env = createMockEnvironment();
        await terminalManager.create(env, { cwd: '/workspace' });

        // Assert - no activation means caller (runInTerminal) will show terminal
        const { callOrder } = terminalActivation;
        assert.strictEqual(callOrder.includes('show'), false, 'show() deferred to caller');
        assert.strictEqual(callOrder.includes('activate'), false, 'Activation disabled');
    });

    test('disableActivation option: skips both show() and activation, returns terminal immediately', async () => {
        // Mock
        mockGetAutoActivationType.returns(terminalUtils.ACT_TYPE_COMMAND);
        terminalManager = createTerminalManager();

        // Run
        const env = createMockEnvironment();
        const terminal = await terminalManager.create(env, { cwd: '/workspace', disableActivation: true });

        // Assert - terminal returned without any activation logic
        const { callOrder } = terminalActivation;
        assert.ok(terminal, 'Terminal should be returned');
        assert.strictEqual(callOrder.includes('show'), false, 'No show() when activation skipped');
        assert.strictEqual(terminalActivation.activateCalls, 0, 'No activate() when disableActivation is true');
    });
});
