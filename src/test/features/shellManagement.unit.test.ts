// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from 'assert';
import * as sinon from 'sinon';
import { QuickInputButtons } from 'vscode';
import { showShellManagementMenu } from '../../features/terminal/shellManagement';
import { ShellSetupState, ShellStartupScriptProvider } from '../../features/terminal/shells/startupProvider';
import * as windowApis from '../../common/window.apis';
import * as commandApi from '../../common/command.api';
import * as shellDetector from '../../features/common/shellDetector';

suite('Shell Management Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let mockProviders: ShellStartupScriptProvider[];
    let showQuickPickStub: sinon.SinonStub;
    let executeCommandStub: sinon.SinonStub;
    let activeTerminalStub: sinon.SinonStub;
    let identifyTerminalShellStub: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        
        // Create mock providers
        mockProviders = [
            {
                name: 'Bash',
                shellType: 'bash',
                isSetup: sandbox.stub().resolves(ShellSetupState.Setup),
                setupScripts: sandbox.stub().resolves(),
                teardownScripts: sandbox.stub().resolves(),
                clearCache: sandbox.stub().resolves(),
            },
            {
                name: 'PowerShell',
                shellType: 'pwsh',
                isSetup: sandbox.stub().resolves(ShellSetupState.NotSetup),
                setupScripts: sandbox.stub().resolves(),
                teardownScripts: sandbox.stub().resolves(),
                clearCache: sandbox.stub().resolves(),
            },
            {
                name: 'Zsh',
                shellType: 'zsh',
                isSetup: sandbox.stub().resolves(ShellSetupState.NotInstalled),
                setupScripts: sandbox.stub().resolves(),
                teardownScripts: sandbox.stub().resolves(),
                clearCache: sandbox.stub().resolves(),
            },
        ];

        // Stub window APIs
        showQuickPickStub = sandbox.stub(windowApis, 'showQuickPickWithButtons');
        activeTerminalStub = sandbox.stub(windowApis, 'activeTerminal').returns({} as any);
        
        // Stub command API
        executeCommandStub = sandbox.stub(commandApi, 'executeCommand').resolves();
        
        // Stub shell detector
        identifyTerminalShellStub = sandbox.stub(shellDetector, 'identifyTerminalShell').returns('bash');
    });

    teardown(() => {
        sandbox.restore();
    });

    suite('Main Menu Navigation', () => {
        test('should show main menu with three options', async () => {
            showQuickPickStub.resolves(undefined); // User cancels

            await showShellManagementMenu(mockProviders);

            assert.strictEqual(showQuickPickStub.calledOnce, true);
            const [items, options] = showQuickPickStub.firstCall.args;
            
            assert.strictEqual(items.length, 3);
            assert.strictEqual(items[0].label, 'Revert Shell Startup Script Changes');
            assert.strictEqual(items[1].label, 'View Shell Startup Statuses');
            assert.strictEqual(items[2].label, 'Inject Shell Startup');
            
            assert.strictEqual(options.title, 'Manage Shell Startup');
            assert.ok(options.placeHolder.includes('Select an action'));
        });

        test('should handle back button in main menu', async () => {
            showQuickPickStub.rejects(QuickInputButtons.Back);

            // Should not throw error
            await showShellManagementMenu(mockProviders);
            
            assert.strictEqual(showQuickPickStub.calledOnce, true);
        });

        test('should handle cancellation in main menu', async () => {
            showQuickPickStub.resolves(undefined);

            await showShellManagementMenu(mockProviders);
            
            assert.strictEqual(showQuickPickStub.calledOnce, true);
        });
    });

    suite('View Shell Status Functionality', () => {
        test('should call isSetup on all providers and open logs', async () => {
            showQuickPickStub.resolves({ action: 'viewStatus' });

            await showShellManagementMenu(mockProviders);

            // Verify isSetup was called on all providers
            mockProviders.forEach(provider => {
                assert.strictEqual((provider.isSetup as sinon.SinonStub).calledOnce, true);
            });

            // Verify logs were opened
            assert.strictEqual(executeCommandStub.calledWith('python-envs.viewLogs'), true);
        });

        test('should handle errors in provider status checks', async () => {
            const errorProvider = {
                name: 'Error Shell',
                shellType: 'error',
                isSetup: sandbox.stub().rejects(new Error('Test error')),
                setupScripts: sandbox.stub(),
                teardownScripts: sandbox.stub(),
                clearCache: sandbox.stub(),
            };

            showQuickPickStub.resolves({ action: 'viewStatus' });

            // Should not throw error even if a provider fails
            await showShellManagementMenu([errorProvider]);

            assert.strictEqual(executeCommandStub.calledWith('python-envs.viewLogs'), true);
        });
    });

    suite('Shell Selection for Injection', () => {
        test('should show shell selection menu with default shell marked', async () => {
            showQuickPickStub.onFirstCall().resolves({ action: 'injectStartup' });
            showQuickPickStub.onSecondCall().resolves(undefined); // User cancels in shell selection

            await showShellManagementMenu(mockProviders);

            assert.strictEqual(showQuickPickStub.calledTwice, true);
            
            const [shellItems, shellOptions] = showQuickPickStub.secondCall.args;
            
            assert.strictEqual(shellItems.length, 3);
            assert.strictEqual(shellOptions.title, 'Inject Shell Startup');
            assert.strictEqual(shellOptions.showBackButton, true);
            
            // Check that bash is marked as default
            const bashItem = shellItems.find((item: any) => item.provider.shellType === 'bash');
            assert.strictEqual(bashItem.description, '⭐');
            assert.ok(bashItem.detail.includes('(default shell)'));
        });

        test('should handle back button in shell selection menu', async () => {
            showQuickPickStub.onFirstCall().resolves({ action: 'injectStartup' });
            showQuickPickStub.onSecondCall().rejects(QuickInputButtons.Back);
            showQuickPickStub.onThirdCall().resolves(undefined); // Return to main menu and cancel

            await showShellManagementMenu(mockProviders);

            // Should have gone back to main menu (called showQuickPick 3 times)
            assert.strictEqual(showQuickPickStub.calledThrice, true);
        });
    });

    suite('Default Shell Detection', () => {
        test('should handle case when no terminal is active', async () => {
            activeTerminalStub.returns(undefined);
            showQuickPickStub.onFirstCall().resolves({ action: 'injectStartup' });
            showQuickPickStub.onSecondCall().resolves(undefined);

            await showShellManagementMenu(mockProviders);

            // Should still work, just no shell marked as default
            assert.strictEqual(showQuickPickStub.calledTwice, true);
        });

        test('should identify default shell correctly', async () => {
            identifyTerminalShellStub.returns('pwsh');
            
            showQuickPickStub.onFirstCall().resolves({ action: 'injectStartup' });
            showQuickPickStub.onSecondCall().resolves(undefined);

            await showShellManagementMenu(mockProviders);

            const [shellItems] = showQuickPickStub.secondCall.args;
            
            // Check that pwsh is marked as default
            const pwshItem = shellItems.find((item: any) => item.provider.shellType === 'pwsh');
            assert.strictEqual(pwshItem.description, '⭐');
            assert.ok(pwshItem.detail.includes('(default shell)'));
            
            // Check that bash is not marked as default
            const bashItem = shellItems.find((item: any) => item.provider.shellType === 'bash');
            assert.strictEqual(bashItem.description, undefined);
        });
    });
});