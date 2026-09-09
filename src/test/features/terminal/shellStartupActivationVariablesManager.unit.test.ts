import * as assert from 'assert';
import * as sinon from 'sinon';
import { Disposable, GlobalEnvironmentVariableCollection, Uri, WorkspaceFolder } from 'vscode';

import { DidChangeEnvironmentEventArgs, PythonEnvironment, PythonProjectEnvironmentApi } from '../../../api';
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
    public removeCalls = 0;

    updateEnvVariables(_collection: unknown, env: PythonEnvironment): void {
        this.updated.push(env);
    }

    removeEnvVariables(): void {
        this.removeCalls += 1;
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
        sinon.stub(workspaceApis, 'onDidChangeConfiguration').returns(new Disposable(() => undefined));

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
