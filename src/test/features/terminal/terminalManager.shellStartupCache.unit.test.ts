import * as sinon from 'sinon';
import { EventEmitter } from 'vscode';
import { TerminalManagerImpl } from '../../../features/terminal/terminalManager';
import { ShellSetupState, ShellStartupScriptProvider } from '../../../features/terminal/shells/startupProvider';
import * as workspaceApis from '../../../common/workspace.apis';

suite('TerminalManager - shellStartup caching/clearing', () => {
    let disposables: sinon.SinonStub[] = [];

    teardown(() => {
        disposables.forEach((d) => d.restore());
        disposables = [];
    });

    function createProvider(shellType: string, state: ShellSetupState): ShellStartupScriptProvider {
        return {
            name: shellType,
            shellType,
            isSetup: sinon.stub().resolves(state),
            setupScripts: sinon.stub().resolves(undefined),
            teardownScripts: sinon.stub().resolves(undefined),
            clearCache: sinon.stub().resolves(undefined),
        } as unknown as ShellStartupScriptProvider;
    }

    test('does not teardown scripts just because shell integration setting changes', async () => {
        const configEmitter = new EventEmitter<{ affectsConfiguration: (s: string) => boolean }>();

        const onDidChangeConfigurationStub = sinon
            .stub(workspaceApis, 'onDidChangeConfiguration')
            .callsFake((listener) => {
                const sub = configEmitter.event(listener);
                return { dispose: () => sub.dispose() };
            });
        disposables.push(onDidChangeConfigurationStub);

        // TerminalManager constructor wires a bunch of window event listeners too; stub them to no-ops.
        const windowApis = require('../../../common/window.apis') as typeof import('../../../common/window.apis');
        disposables.push(
            sinon.stub(windowApis, 'onDidOpenTerminal').returns({ dispose: () => undefined } as any),
            sinon.stub(windowApis, 'onDidCloseTerminal').returns({ dispose: () => undefined } as any),
            sinon.stub(windowApis, 'onDidChangeWindowState').returns({ dispose: () => undefined } as any),
            sinon.stub(windowApis, 'terminals').returns([] as any),
        );

        const shellUtils =
            require('../../../features/terminal/shells/common/shellUtils') as typeof import('../../../features/terminal/shells/common/shellUtils');
        disposables.push(sinon.stub(shellUtils, 'getShellIntegrationEnabledCache').resolves(true));

        const ta = {
            onDidChangeTerminalActivationState: () => ({ dispose: () => undefined }),
            getEnvironment: () => undefined,
        } as any;

        const provider = createProvider('bash', ShellSetupState.NotSetup);
        const tm = new TerminalManagerImpl(ta, [], [provider]);

        // Trigger shell integration setting change
        configEmitter.fire({
            affectsConfiguration: (s: string) => s === 'terminal.integrated.shellIntegration.enabled',
        });

        // Previously we would sometimes teardown scripts here; now we should not.
        sinon.assert.notCalled(provider.teardownScripts as any);

        tm.dispose();
    });
});
