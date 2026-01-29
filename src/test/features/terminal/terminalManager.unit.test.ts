// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventEmitter, Progress, Terminal, TerminalOptions } from 'vscode';
import { PythonEnvironment } from '../../../api';
import * as windowApis from '../../../common/window.apis';
import * as workspaceApis from '../../../common/workspace.apis';
import { TerminalActivationInternal } from '../../../features/terminal/terminalActivationState';
import { TerminalManagerImpl } from '../../../features/terminal/terminalManager';
import {
    ShellEnvsProvider,
    ShellStartupScriptProvider,
} from '../../../features/terminal/shells/startupProvider';
import * as terminalUtils from '../../../features/terminal/utils';
import * as activationUtils from '../../../features/common/activation';

suite('TerminalManager - create()', () => {
    let terminalActivation: TerminalActivationInternal;
    let mockGetAutoActivationType: sinon.SinonStub;
    let terminalManager: TerminalManagerImpl;

    // Tracking variables for show() and activate() call order
    let callOrder: string[];
    let mockTerminal: Partial<Terminal> & { show: sinon.SinonStub };

    const createMockEnvironment = (): PythonEnvironment =>
        ({
            envId: { id: 'test-env-id', managerId: 'test-manager' },
            environmentPath: { fsPath: '/path/to/python' },
            displayName: 'Test Environment',
            execInfo: {
                activation: { executable: 'source', args: ['/path/to/activate'] },
            },
        } as unknown as PythonEnvironment);

    setup(() => {
        callOrder = [];

        // Create mock terminal with tracking
        mockTerminal = {
            name: 'Test Terminal',
            creationOptions: {} as TerminalOptions,
            shellIntegration: undefined,
            show: sinon.stub().callsFake(() => {
                callOrder.push('show');
            }),
            sendText: sinon.stub(),
        };

        // Mock terminal activation using unknown cast for simpler typing
        const onDidChangeEmitter = new EventEmitter<unknown>();
        terminalActivation = {
            isActivated: sinon.stub().returns(false),
            activate: sinon.stub().callsFake(async () => {
                callOrder.push('activate');
            }),
            deactivate: sinon.stub().resolves(),
            getEnvironment: sinon.stub().returns(undefined),
            updateActivationState: sinon.stub(),
            onDidChangeTerminalActivationState: onDidChangeEmitter.event,
            dispose: sinon.stub(),
        } as unknown as TerminalActivationInternal;

        // Stub terminalUtils
        mockGetAutoActivationType = sinon.stub(terminalUtils, 'getAutoActivationType');
        sinon.stub(terminalUtils, 'waitForShellIntegration').resolves(false);

        // Stub isActivatableEnvironment to return true
        sinon.stub(activationUtils, 'isActivatableEnvironment').returns(true);

        // Stub window APIs
        sinon.stub(windowApis, 'createTerminal').returns(mockTerminal as unknown as Terminal);
        sinon.stub(windowApis, 'onDidOpenTerminal').returns({ dispose: sinon.stub() });
        sinon.stub(windowApis, 'onDidCloseTerminal').returns({ dispose: sinon.stub() });
        sinon.stub(windowApis, 'onDidChangeWindowState').returns({ dispose: sinon.stub() });
        sinon.stub(windowApis, 'terminals').returns([]);

        // Stub withProgress to execute the callback directly
        sinon.stub(windowApis, 'withProgress').callsFake(async (_options, task) => {
            const mockProgress: Progress<{ message?: string; increment?: number }> = { report: () => {} };
            const mockCancellationToken = {
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose: () => {} }),
            };
            return task(mockProgress, mockCancellationToken as never);
        });

        // Stub workspace APIs
        sinon.stub(workspaceApis, 'onDidChangeConfiguration').returns({ dispose: sinon.stub() });
    });

    teardown(() => {
        sinon.restore();
    });

    function createTerminalManager(): TerminalManagerImpl {
        const emptyEnvProviders: ShellEnvsProvider[] = [];
        const emptyScriptProviders: ShellStartupScriptProvider[] = [];
        return new TerminalManagerImpl(
            terminalActivation as TerminalActivationInternal,
            emptyEnvProviders,
            emptyScriptProviders,
        );
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
        assert.ok(terminal, 'Terminal should be returned');
        assert.strictEqual(callOrder.includes('show'), false, 'No show() when activation skipped');
        assert.strictEqual(
            (terminalActivation.activate as sinon.SinonStub).called,
            false,
            'No activate() when disableActivation is true',
        );
    });
});
