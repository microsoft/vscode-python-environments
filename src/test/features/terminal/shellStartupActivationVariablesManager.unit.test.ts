import * as assert from 'assert';
import * as sinon from 'sinon';
import { ConfigurationChangeEvent, Disposable, GlobalEnvironmentVariableCollection, Uri, WorkspaceFolder } from 'vscode';

import { DidChangeEnvironmentEventArgs, PythonEnvironment, PythonProjectEnvironmentApi } from '../../../api';
import { createDeferred } from '../../../common/utils/deferred';
import * as workspaceApis from '../../../common/workspace.apis';
import { ShellStartupActivationVariablesManagerImpl } from '../../../features/terminal/shellStartupActivationVariablesManager';
import { ShellEnvsProvider } from '../../../features/terminal/shells/startupProvider';
import * as terminalUtils from '../../../features/terminal/utils';

function makeEnvironment(id: string, managerId: string): PythonEnvironment {
    return {
        envId: { id, managerId },
        name: id,
        displayName: id,
        displayPath: `/envs/${id}`,
        version: '3.12.4',
        environmentPath: Uri.file(`/envs/${id}/bin/python`),
        sysPrefix: `/envs/${id}`,
        execInfo: { run: { executable: `/envs/${id}/bin/python` } },
    } as unknown as PythonEnvironment;
}

class RecordingEnvsProvider implements ShellEnvsProvider {
    public readonly shellType = 'pwsh';
    public readonly updated: PythonEnvironment[] = [];
    public readonly updatedCollections: unknown[] = [];
    public readonly removedCollections: unknown[] = [];
    public removeCalls = 0;

    updateEnvVariables(collection: unknown, env: PythonEnvironment): void {
        this.updated.push(env);
        this.updatedCollections.push(collection);
    }

    removeEnvVariables(collection: unknown): void {
        this.removeCalls += 1;
        this.removedCollections.push(collection);
    }

    getEnvVariables(): Map<string, string | undefined> | undefined {
        return undefined;
    }
}

suite('ShellStartupActivationVariablesManager', () => {
    const folderUri = Uri.file('/workspace');
    const workspaceFolder = { uri: folderUri, name: 'workspace', index: 0 } as WorkspaceFolder;
    const folderEnvironment = makeEnvironment('folder-venv', 'ms-python.python:venv');
    const scriptEnvironment = makeEnvironment('script-env', 'ms-python.python:inline-script');

    let provider: RecordingEnvsProvider;
    let scopedCollection: object;
    let envCollection: GlobalEnvironmentVariableCollection;
    let getEnvironmentStub: sinon.SinonStub;
    let configurationListener: ((e: ConfigurationChangeEvent) => void | Promise<void>) | undefined;
    let changeListener: ((e: DidChangeEnvironmentEventArgs) => Promise<void>) | undefined;
    let manager: ShellStartupActivationVariablesManagerImpl;

    setup(() => {
        provider = new RecordingEnvsProvider();
        scopedCollection = {};
        envCollection = {
            description: undefined,
            getScoped: () => scopedCollection,
        } as unknown as GlobalEnvironmentVariableCollection;

        sinon.stub(terminalUtils, 'getAutoActivationType').returns(terminalUtils.ACT_TYPE_SHELL);
        sinon.stub(workspaceApis, 'getWorkspaceFolder').returns(workspaceFolder);
        sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([]);
        sinon.stub(workspaceApis, 'onDidChangeConfiguration').callsFake((listener) => {
            configurationListener = listener;
            return new Disposable(() => undefined);
        });

        getEnvironmentStub = sinon.stub().resolves(folderEnvironment);
        const api = {
            getEnvironment: getEnvironmentStub,
            setEnvironment: sinon.stub().resolves(),
            onDidChangeEnvironment: (listener: (e: DidChangeEnvironmentEventArgs) => Promise<void>) => {
                changeListener = listener;
                return new Disposable(() => undefined);
            },
        } as unknown as PythonProjectEnvironmentApi;

        manager = new ShellStartupActivationVariablesManagerImpl(envCollection, [provider], api);
    });

    teardown(() => {
        manager.dispose();
        sinon.restore();
    });

    test('does not write a file-scoped inline-script environment into folder startup variables', async () => {
        assert.ok(changeListener, 'expected the manager to subscribe to environment changes');

        // A PEP 723 script selection fires with the `.py` file uri and the script's own environment.
        await changeListener!({
            uri: Uri.file('/workspace/script.py'),
            new: scriptEnvironment,
            old: undefined,
        });

        assert.deepStrictEqual(
            provider.updated.map((env) => env.envId.id),
            ['folder-venv'],
            'the folder default should be written, never the script environment',
        );
        sinon.assert.calledOnceWithExactly(getEnvironmentStub, folderUri);
    });

    test('writes the folder environment resolved at folder scope, not the event payload', async () => {
        await changeListener!({
            uri: folderUri,
            new: makeEnvironment('stale-payload', 'ms-python.python:venv'),
            old: undefined,
        });

        assert.deepStrictEqual(
            provider.updated.map((env) => env.envId.id),
            ['folder-venv'],
        );
    });

    test('removes startup variables when the folder has no environment', async () => {
        getEnvironmentStub.resolves(undefined);

        await changeListener!({
            uri: Uri.file('/workspace/script.py'),
            new: scriptEnvironment,
            old: undefined,
        });

        assert.strictEqual(provider.updated.length, 0);
        assert.strictEqual(provider.removeCalls, 1);
    });

    test('refreshes global startup variables after a global selection changes', async () => {
        const newEnvironment = makeEnvironment('global-venv-b', 'ms-python.python:venv');
        await changeListener!({ uri: undefined, new: folderEnvironment, old: undefined });
        await changeListener!({ uri: undefined, new: newEnvironment, old: folderEnvironment });

        sinon.assert.notCalled(getEnvironmentStub);
        assert.deepStrictEqual(provider.updated, [folderEnvironment, newEnvironment]);
        assert.deepStrictEqual(provider.updatedCollections, [envCollection, envCollection]);
    });

    test('uses the global change payload while the API still returns the previous selection', async () => {
        const newEnvironment = makeEnvironment('global-venv-b', 'ms-python.python:venv');
        getEnvironmentStub.resolves(folderEnvironment);

        await changeListener!({ uri: undefined, new: newEnvironment, old: folderEnvironment });

        sinon.assert.notCalled(getEnvironmentStub);
        assert.deepStrictEqual(provider.updated, [newEnvironment]);
    });

    test('does not let pending global initialization overwrite a newer selection', async () => {
        const newEnvironment = makeEnvironment('global-venv-b', 'ms-python.python:venv');
        const pendingInitialization = createDeferred<PythonEnvironment | undefined>();
        getEnvironmentStub.returns(pendingInitialization.promise);

        const initialization = manager.initialize();
        await changeListener!({ uri: undefined, new: newEnvironment, old: folderEnvironment });
        pendingInitialization.resolve(folderEnvironment);
        await initialization;

        assert.deepStrictEqual(provider.updated, [newEnvironment]);
        assert.deepStrictEqual(provider.updatedCollections, [envCollection]);
    });

    test('does not restore global startup variables after shell startup activation is disabled', async () => {
        const pendingRefresh = createDeferred<PythonEnvironment | undefined>();
        getEnvironmentStub.returns(pendingRefresh.promise);
        const initialization = manager.initialize();
        (terminalUtils.getAutoActivationType as sinon.SinonStub).returns('command');

        await configurationListener!({
            affectsConfiguration: (section) => section === 'python-envs.terminal.autoActivationType',
        } as ConfigurationChangeEvent);
        pendingRefresh.resolve(folderEnvironment);
        await initialization;

        assert.strictEqual(provider.updated.length, 0);
        assert.deepStrictEqual(provider.removedCollections, [envCollection]);
    });

    test('removes stale global startup variables when no environment remains selected', async () => {
        getEnvironmentStub.resolves(undefined);

        await changeListener!({ uri: undefined, new: undefined, old: folderEnvironment });

        sinon.assert.notCalled(getEnvironmentStub);
        assert.deepStrictEqual(provider.removedCollections, [envCollection]);
        assert.strictEqual(provider.updated.length, 0);
    });

    test('does not overwrite folder startup variables on a global selection change', async () => {
        (workspaceApis.getWorkspaceFolders as sinon.SinonStub).returns([workspaceFolder]);

        await changeListener!({ uri: undefined, new: scriptEnvironment, old: undefined });

        sinon.assert.notCalled(getEnvironmentStub);
        assert.strictEqual(provider.updated.length, 0);
        assert.strictEqual(provider.removeCalls, 0);
    });

    for (const mode of ['command', 'off']) {
        test(`ignores global environment changes when activation mode is ${mode}`, async () => {
            (terminalUtils.getAutoActivationType as sinon.SinonStub).returns(mode);

            await changeListener!({ uri: undefined, new: scriptEnvironment, old: undefined });

            sinon.assert.notCalled(getEnvironmentStub);
            assert.strictEqual(provider.updated.length, 0);
            assert.strictEqual(provider.removeCalls, 0);
        });
    }

    test('ignores environment changes when shell startup activation is off', async () => {
        (terminalUtils.getAutoActivationType as sinon.SinonStub).returns('command');

        await changeListener!({
            uri: Uri.file('/workspace/script.py'),
            new: scriptEnvironment,
            old: undefined,
        });

        assert.strictEqual(provider.updated.length, 0);
        assert.strictEqual(provider.removeCalls, 0);
        sinon.assert.notCalled(getEnvironmentStub);
    });
});
