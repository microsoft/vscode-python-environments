import * as assert from 'assert';
import * as sinon from 'sinon';

import { EventEmitter } from 'vscode';

import * as windowApis from '../../../common/window.apis';
import * as workspaceApis from '../../../common/workspace.apis';
import { TerminalManagerImpl } from '../../../features/terminal/terminalManager';
import {
    ShellScriptEditState,
    ShellSetupState,
    ShellStartupScriptProvider,
} from '../../../features/terminal/shells/startupProvider';
import { ACT_TYPE_COMMAND } from '../../../features/terminal/utils';
import * as terminalUtils from '../../../features/terminal/utils';
import {
    DidChangeTerminalActivationStateEvent,
    TerminalActivationInternal,
} from '../../../features/terminal/terminalActivationState';

type DisposableLike = { dispose(): void };

suite('TerminalManager shellStartup profile behavior', () => {
    let sandbox: sinon.SinonSandbox;
    let onDidChangeConfigurationHandler:
        | ((e: { affectsConfiguration: (section: string) => boolean }) => void | Promise<void>)
        | undefined;

    setup(() => {
        sandbox = sinon.createSandbox();
        onDidChangeConfigurationHandler = undefined;

        const disposable: DisposableLike = { dispose() {} };

        sandbox.stub(windowApis, 'onDidOpenTerminal').returns(disposable as any);
        sandbox.stub(windowApis, 'onDidCloseTerminal').returns(disposable as any);
        sandbox.stub(windowApis, 'onDidChangeWindowState').returns(disposable as any);

        sandbox.stub(workspaceApis, 'onDidChangeConfiguration').callsFake((handler: any) => {
            onDidChangeConfigurationHandler = handler;
            return disposable as any;
        });

        // Avoid any real window focus concerns.
        sandbox.stub(windowApis, 'terminals').returns([] as any);
    });

    teardown(() => {
        sandbox.restore();
    });

    function createTerminalManager(startupScriptProviders: ShellStartupScriptProvider[]): TerminalManagerImpl {
        const emitter = new EventEmitter<DidChangeTerminalActivationStateEvent>();
        const ta: TerminalActivationInternal = {
            onDidChangeTerminalActivationState: emitter.event,
            isActivated: () => false,
            getEnvironment: () => undefined,
            activate: async () => undefined,
            deactivate: async () => undefined,
            updateActivationState: () => undefined,
            dispose: () => emitter.dispose(),
        };

        return new TerminalManagerImpl(ta, [], startupScriptProviders);
    }

    test('does not tear down profile scripts when shellStartup is setup', async () => {
        const provider: ShellStartupScriptProvider = {
            name: 'bash',
            shellType: 'bash',
            isSetup: sandbox.stub().resolves(ShellSetupState.Setup),
            setupScripts: sandbox.stub().resolves(ShellScriptEditState.Edited),
            teardownScripts: sandbox.stub().resolves(ShellScriptEditState.Edited),
            clearCache: sandbox.stub().resolves(),
        };

        const tm = createTerminalManager([provider]);
        await (tm as any).handleSetupCheck('bash');

        sinon.assert.notCalled(provider.teardownScripts as sinon.SinonStub);
        assert.strictEqual((tm as any).shellSetup.get('bash'), true);
    });

    test('clears profile scripts when switching from shellStartup to command', async () => {
        const provider: ShellStartupScriptProvider = {
            name: 'bash',
            shellType: 'bash',
            isSetup: sandbox.stub().resolves(ShellSetupState.Setup),
            setupScripts: sandbox.stub().resolves(ShellScriptEditState.Edited),
            teardownScripts: sandbox.stub().resolves(ShellScriptEditState.Edited),
            clearCache: sandbox.stub().resolves(),
        };

        sandbox.stub(terminalUtils, 'getAutoActivationType').returns(ACT_TYPE_COMMAND);

        const tm = createTerminalManager([provider]);
        // Seed a cached setup state so we can verify it is cleared.
        (tm as any).shellSetup.set('bash', true);

        assert.ok(onDidChangeConfigurationHandler, 'Expected onDidChangeConfiguration handler to be registered');
        await onDidChangeConfigurationHandler!({
            affectsConfiguration: (section: string) => section === 'python-envs.terminal.autoActivationType',
        });

        sinon.assert.calledOnce(provider.teardownScripts as sinon.SinonStub);
        assert.strictEqual((tm as any).shellSetup.size, 0);
    });
});
