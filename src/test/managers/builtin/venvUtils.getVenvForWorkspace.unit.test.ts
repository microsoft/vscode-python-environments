import * as assert from 'assert';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as persistentState from '../../../common/persistentState';
import { getVenvForWorkspace, VENV_WORKSPACE_KEY } from '../../../managers/builtin/venvUtils';

suite('getVenvForWorkspace', () => {
    let mockState: {
        get: sinon.SinonStub;
        set: sinon.SinonStub;
        clear: sinon.SinonStub;
    };
    let getWorkspacePersistentStateStub: sinon.SinonStub;
    let originalVirtualEnv: string | undefined;
    let tmpDir: string;

    setup(async () => {
        originalVirtualEnv = process.env.VIRTUAL_ENV;
        delete process.env.VIRTUAL_ENV;

        tmpDir = path.join(os.tmpdir(), `venv-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await fse.ensureDir(tmpDir);

        mockState = {
            get: sinon.stub(),
            set: sinon.stub(),
            clear: sinon.stub(),
        };
        getWorkspacePersistentStateStub = sinon.stub(persistentState, 'getWorkspacePersistentState');
        getWorkspacePersistentStateStub.resolves(mockState);
    });

    teardown(async () => {
        if (originalVirtualEnv !== undefined) {
            process.env.VIRTUAL_ENV = originalVirtualEnv;
        } else {
            delete process.env.VIRTUAL_ENV;
        }
        sinon.restore();
        await fse.remove(tmpDir);
    });

    test('should return persisted selection when available', async () => {
        const workspacePath = path.join(tmpDir, 'projectA');
        const venvPath = path.join(workspacePath, '.venv');
        await fse.ensureDir(venvPath);

        mockState.get.withArgs(VENV_WORKSPACE_KEY).resolves({ [workspacePath]: venvPath });

        const result = await getVenvForWorkspace(workspacePath);
        assert.strictEqual(result, venvPath, 'Should return persisted venv path');
    });

    test('should return persisted selection even when VIRTUAL_ENV is set', async () => {
        const projectA = path.join(tmpDir, 'projectA');
        const projectB = path.join(tmpDir, 'projectB');
        const persistedVenv = path.join(projectA, '.venv');
        const otherVenv = path.join(projectB, '.venv');
        await fse.ensureDir(persistedVenv);
        await fse.ensureDir(otherVenv);
        process.env.VIRTUAL_ENV = otherVenv;

        mockState.get.withArgs(VENV_WORKSPACE_KEY).resolves({ [projectA]: persistedVenv });

        const result = await getVenvForWorkspace(projectA);
        assert.strictEqual(result, persistedVenv, 'Persisted selection should take priority over VIRTUAL_ENV');
    });

    test('should fall back to VIRTUAL_ENV when no persisted selection and venv is inside workspace', async () => {
        const workspacePath = path.join(tmpDir, 'projectA');
        const virtualEnvPath = path.join(workspacePath, '.venv');
        await fse.ensureDir(virtualEnvPath);
        process.env.VIRTUAL_ENV = virtualEnvPath;

        mockState.get.withArgs(VENV_WORKSPACE_KEY).resolves(undefined);

        const result = await getVenvForWorkspace(workspacePath);
        assert.strictEqual(result, virtualEnvPath, 'Should use VIRTUAL_ENV when it is inside the workspace');
    });

    test('should NOT use VIRTUAL_ENV when it points to a different project', async () => {
        const projectA = path.join(tmpDir, 'projectA');
        const projectB = path.join(tmpDir, 'projectB');
        const otherVenv = path.join(projectB, '.venv');
        await fse.ensureDir(projectA);
        await fse.ensureDir(otherVenv);
        process.env.VIRTUAL_ENV = otherVenv;

        mockState.get.withArgs(VENV_WORKSPACE_KEY).resolves(undefined);

        const result = await getVenvForWorkspace(projectA);
        assert.strictEqual(result, undefined, 'Should NOT use VIRTUAL_ENV from a different project');
    });

    test('should clear stale persisted path when venv no longer exists', async () => {
        const workspacePath = path.join(tmpDir, 'projectA');
        const staleVenv = path.join(workspacePath, '.venv-old');
        await fse.ensureDir(workspacePath);
        // Note: staleVenv directory does NOT exist on disk

        mockState.get.withArgs(VENV_WORKSPACE_KEY).resolves({ [workspacePath]: staleVenv });

        const result = await getVenvForWorkspace(workspacePath);

        assert.strictEqual(result, undefined, 'Should return undefined for stale path');
        assert.ok(mockState.set.called, 'Should clear the stale entry from persistent state');
        const setArgs = mockState.set.firstCall.args;
        assert.strictEqual(setArgs[0], VENV_WORKSPACE_KEY, 'Should update the correct key');
        assert.strictEqual(setArgs[1][workspacePath], undefined, 'Should have removed the stale workspace entry');
    });

    test('should return undefined when no persisted selection and no VIRTUAL_ENV', async () => {
        const workspacePath = path.join(tmpDir, 'projectA');
        await fse.ensureDir(workspacePath);

        mockState.get.withArgs(VENV_WORKSPACE_KEY).resolves(undefined);

        const result = await getVenvForWorkspace(workspacePath);
        assert.strictEqual(result, undefined, 'Should return undefined when nothing is available');
    });

    test('should return undefined when persisted data has no entry for this workspace', async () => {
        const projectA = path.join(tmpDir, 'projectA');
        const projectB = path.join(tmpDir, 'projectB');
        await fse.ensureDir(projectA);

        mockState.get.withArgs(VENV_WORKSPACE_KEY).resolves({ [projectB]: '/some/path' });

        const result = await getVenvForWorkspace(projectA);
        assert.strictEqual(result, undefined, 'Should return undefined when no entry for this workspace');
    });

    test('should fall back to VIRTUAL_ENV when data access throws inside try block', async () => {
        const workspacePath = path.join(tmpDir, 'projectA');
        const virtualEnvPath = path.join(workspacePath, '.venv');
        await fse.ensureDir(virtualEnvPath);
        process.env.VIRTUAL_ENV = virtualEnvPath;

        // Return data object with a getter that throws when accessing the workspace key
        const badData: Record<string, string> = {};
        Object.defineProperty(badData, workspacePath, {
            get() {
                throw new Error('corrupted data');
            },
            enumerable: true,
            configurable: true,
        });
        mockState.get.withArgs(VENV_WORKSPACE_KEY).resolves(badData);

        const result = await getVenvForWorkspace(workspacePath);
        assert.strictEqual(result, virtualEnvPath, 'Should fall back to VIRTUAL_ENV when try block throws');
    });

    test('should not clear state when no envPath exists for the workspace key', async () => {
        const workspacePath = path.join(tmpDir, 'projectA');
        await fse.ensureDir(workspacePath);

        mockState.get.withArgs(VENV_WORKSPACE_KEY).resolves({ other: '/some/path' });

        await getVenvForWorkspace(workspacePath);

        assert.ok(!mockState.set.called, 'Should not call set when there is no stale entry to clear');
    });
});
