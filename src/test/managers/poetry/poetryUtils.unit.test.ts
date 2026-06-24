import assert from 'node:assert';
import path from 'node:path';
import * as sinon from 'sinon';
import { EnvironmentManager, PythonEnvironment, PythonEnvironmentApi, PythonEnvironmentInfo } from '../../../api';
import * as childProcessApis from '../../../common/childProcess.apis';
import * as persistentState from '../../../common/persistentState';
import * as pathUtils from '../../../common/utils/pathUtils';
import * as platformUtils from '../../../common/utils/platformUtils';
import { NativeEnvInfo } from '../../../managers/common/nativePythonFinder';
import * as utils from '../../../managers/common/utils';
import {
    clearPoetryCache,
    getDefaultPoetryCacheDir,
    getDefaultPoetryVirtualenvsPath,
    getPoetryVersion,
    getPoetryVirtualenvsPath,
    isPoetryVirtualenvsInProject,
    nativeToPythonEnv,
    POETRY_VIRTUALENVS_PATH_KEY,
} from '../../../managers/poetry/poetryUtils';

suite('isPoetryVirtualenvsInProject', () => {
    test('should return false when env var is not set', () => {
        assert.strictEqual(isPoetryVirtualenvsInProject(undefined), false);
    });

    test('should return true when env var is "true"', () => {
        assert.strictEqual(isPoetryVirtualenvsInProject('true'), true);
    });

    test('should return true when env var is "True" (case insensitive)', () => {
        assert.strictEqual(isPoetryVirtualenvsInProject('True'), true);
    });

    test('should return true when env var is "TRUE" (case insensitive)', () => {
        assert.strictEqual(isPoetryVirtualenvsInProject('TRUE'), true);
    });

    test('should return true when env var is "1"', () => {
        assert.strictEqual(isPoetryVirtualenvsInProject('1'), true);
    });

    test('should return false when env var is "false"', () => {
        assert.strictEqual(isPoetryVirtualenvsInProject('false'), false);
    });

    test('should return false when env var is "0"', () => {
        assert.strictEqual(isPoetryVirtualenvsInProject('0'), false);
    });

    test('should return false when env var is empty string', () => {
        assert.strictEqual(isPoetryVirtualenvsInProject(''), false);
    });

    test('should return false when env var is arbitrary string', () => {
        assert.strictEqual(isPoetryVirtualenvsInProject('yes'), false);
    });

    test('should read from process.env when no argument given', () => {
        const original = process.env.POETRY_VIRTUALENVS_IN_PROJECT;
        try {
            process.env.POETRY_VIRTUALENVS_IN_PROJECT = 'true';
            assert.strictEqual(isPoetryVirtualenvsInProject(), true);

            delete process.env.POETRY_VIRTUALENVS_IN_PROJECT;
            assert.strictEqual(isPoetryVirtualenvsInProject(), false);
        } finally {
            if (original === undefined) {
                delete process.env.POETRY_VIRTUALENVS_IN_PROJECT;
            } else {
                process.env.POETRY_VIRTUALENVS_IN_PROJECT = original;
            }
        }
    });
});

suite('nativeToPythonEnv - POETRY_VIRTUALENVS_IN_PROJECT integration', () => {
    let capturedInfo: PythonEnvironmentInfo | undefined;
    let originalEnv: string | undefined;

    const mockApi = {
        createPythonEnvironmentItem: (info: PythonEnvironmentInfo, _manager: EnvironmentManager) => {
            capturedInfo = info;
            return { ...info, envId: { id: 'test-id', managerId: 'test-manager' } } as PythonEnvironment;
        },
    } as unknown as PythonEnvironmentApi;

    const mockManager = {} as EnvironmentManager;

    const baseEnvInfo: NativeEnvInfo = {
        prefix: '/home/user/myproject/.venv',
        executable: '/home/user/myproject/.venv/bin/python',
        version: '3.12.0',
        name: 'myproject-venv',
        project: '/home/user/myproject',
    };

    setup(() => {
        capturedInfo = undefined;
        originalEnv = process.env.POETRY_VIRTUALENVS_IN_PROJECT;

        sinon.stub(utils, 'getShellActivationCommands').resolves({
            shellActivation: new Map(),
            shellDeactivation: new Map(),
        });
    });

    teardown(() => {
        sinon.restore();
        if (originalEnv === undefined) {
            delete process.env.POETRY_VIRTUALENVS_IN_PROJECT;
        } else {
            process.env.POETRY_VIRTUALENVS_IN_PROJECT = originalEnv;
        }
    });

    test('env var set + project present → environment is NOT classified as global', async () => {
        process.env.POETRY_VIRTUALENVS_IN_PROJECT = 'true';

        const result = await nativeToPythonEnv(baseEnvInfo, mockApi, mockManager, '/usr/bin/poetry');

        assert.ok(result, 'Should return a PythonEnvironment');
        assert.ok(capturedInfo, 'Should have captured environment info');
        assert.strictEqual(capturedInfo!.group, undefined, 'In-project env should not have POETRY_GLOBAL group');
    });

    test('env var set to "1" + project present → environment is NOT classified as global', async () => {
        process.env.POETRY_VIRTUALENVS_IN_PROJECT = '1';

        const result = await nativeToPythonEnv(baseEnvInfo, mockApi, mockManager, '/usr/bin/poetry');

        assert.ok(result, 'Should return a PythonEnvironment');
        assert.ok(capturedInfo, 'Should have captured environment info');
        assert.strictEqual(capturedInfo!.group, undefined, 'In-project env should not have POETRY_GLOBAL group');
    });

    test('env var set + project absent → falls through to normal global check', async () => {
        process.env.POETRY_VIRTUALENVS_IN_PROJECT = 'true';
        const envWithoutProject: NativeEnvInfo = {
            ...baseEnvInfo,
            project: undefined,
        };

        const result = await nativeToPythonEnv(envWithoutProject, mockApi, mockManager, '/usr/bin/poetry');

        assert.ok(result, 'Should return a PythonEnvironment');
        assert.ok(capturedInfo, 'Should have captured environment info');
        // Without project, falls through to global check; since prefix is not in global dir, group is undefined
        assert.strictEqual(capturedInfo!.group, undefined, 'Non-global path without project should not be global');
    });

    test('env var NOT set → original classification behavior is preserved', async () => {
        delete process.env.POETRY_VIRTUALENVS_IN_PROJECT;

        const result = await nativeToPythonEnv(baseEnvInfo, mockApi, mockManager, '/usr/bin/poetry');

        assert.ok(result, 'Should return a PythonEnvironment');
        assert.ok(capturedInfo, 'Should have captured environment info');
        // Prefix is not in global virtualenvs dir, so not classified as global
        assert.strictEqual(capturedInfo!.group, undefined, 'Non-global path should not be global');
    });

    test('env var set to "false" → original classification behavior is preserved', async () => {
        process.env.POETRY_VIRTUALENVS_IN_PROJECT = 'false';

        const result = await nativeToPythonEnv(baseEnvInfo, mockApi, mockManager, '/usr/bin/poetry');

        assert.ok(result, 'Should return a PythonEnvironment');
        assert.ok(capturedInfo, 'Should have captured environment info');
        // Falls through to normal check since env var is falsy
        assert.strictEqual(capturedInfo!.group, undefined, 'Non-global path should not be global');
    });
});

suite('getPoetryVersion - childProcess.apis mocking pattern', () => {
    let execProcessStub: sinon.SinonStub;

    setup(() => {
        execProcessStub = sinon.stub(childProcessApis, 'execProcess');
    });

    teardown(() => {
        sinon.restore();
    });

    test('should parse Poetry 1.x version format', async () => {
        execProcessStub.resolves({ stdout: 'Poetry version 1.5.1\n', stderr: '' });

        const version = await getPoetryVersion('/usr/bin/poetry');

        assert.strictEqual(version, '1.5.1');
        assert.ok(execProcessStub.calledOnce);
        assert.ok(execProcessStub.calledWith('"/usr/bin/poetry" --version'));
    });

    test('should parse Poetry 2.x version format', async () => {
        execProcessStub.resolves({ stdout: 'Poetry (version 2.1.3)\n', stderr: '' });

        const version = await getPoetryVersion('/usr/bin/poetry');

        assert.strictEqual(version, '2.1.3');
    });

    test('should return undefined when command fails', async () => {
        execProcessStub.rejects(new Error('Command not found'));

        const version = await getPoetryVersion('/nonexistent/poetry');

        assert.strictEqual(version, undefined);
    });

    test('should return undefined when output does not match expected format', async () => {
        execProcessStub.resolves({ stdout: 'unexpected output', stderr: '' });

        const version = await getPoetryVersion('/usr/bin/poetry');

        assert.strictEqual(version, undefined);
    });
});

suite('getDefaultPoetryCacheDir', () => {
    let isWindowsStub: sinon.SinonStub;
    let isMacStub: sinon.SinonStub;
    let getUserHomeDirStub: sinon.SinonStub;
    let originalLocalAppData: string | undefined;
    let originalAppData: string | undefined;

    setup(() => {
        isWindowsStub = sinon.stub(platformUtils, 'isWindows');
        isMacStub = sinon.stub(platformUtils, 'isMac');
        getUserHomeDirStub = sinon.stub(pathUtils, 'getUserHomeDir');

        // Save original env vars
        originalLocalAppData = process.env.LOCALAPPDATA;
        originalAppData = process.env.APPDATA;
    });

    teardown(() => {
        sinon.restore();
        // Restore original env vars
        if (originalLocalAppData === undefined) {
            delete process.env.LOCALAPPDATA;
        } else {
            process.env.LOCALAPPDATA = originalLocalAppData;
        }
        if (originalAppData === undefined) {
            delete process.env.APPDATA;
        } else {
            process.env.APPDATA = originalAppData;
        }
    });

    test('Windows: uses LOCALAPPDATA when available', () => {
        isWindowsStub.returns(true);
        process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';

        const result = getDefaultPoetryCacheDir();

        assert.strictEqual(result, path.join('C:\\Users\\test\\AppData\\Local', 'pypoetry', 'Cache'));
    });

    test('Windows: falls back to APPDATA when LOCALAPPDATA is not set', () => {
        isWindowsStub.returns(true);
        delete process.env.LOCALAPPDATA;
        process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming';

        const result = getDefaultPoetryCacheDir();

        assert.strictEqual(result, path.join('C:\\Users\\test\\AppData\\Roaming', 'pypoetry', 'Cache'));
    });

    test('Windows: returns undefined when neither LOCALAPPDATA nor APPDATA is set', () => {
        isWindowsStub.returns(true);
        delete process.env.LOCALAPPDATA;
        delete process.env.APPDATA;

        const result = getDefaultPoetryCacheDir();

        assert.strictEqual(result, undefined);
    });

    test('macOS: uses ~/Library/Caches/pypoetry', () => {
        isWindowsStub.returns(false);
        isMacStub.returns(true);
        getUserHomeDirStub.returns('/Users/test');

        const result = getDefaultPoetryCacheDir();

        assert.strictEqual(result, path.join('/Users/test', 'Library', 'Caches', 'pypoetry'));
    });

    test('Linux: uses ~/.cache/pypoetry', () => {
        isWindowsStub.returns(false);
        isMacStub.returns(false);
        getUserHomeDirStub.returns('/home/test');

        const result = getDefaultPoetryCacheDir();

        assert.strictEqual(result, path.join('/home/test', '.cache', 'pypoetry'));
    });

    test('returns undefined when home directory is not available (non-Windows)', () => {
        isWindowsStub.returns(false);
        getUserHomeDirStub.returns(undefined);

        const result = getDefaultPoetryCacheDir();

        assert.strictEqual(result, undefined);
    });
});

suite('getDefaultPoetryVirtualenvsPath', () => {
    let isWindowsStub: sinon.SinonStub;
    let isMacStub: sinon.SinonStub;
    let getUserHomeDirStub: sinon.SinonStub;
    let originalLocalAppData: string | undefined;

    setup(() => {
        isWindowsStub = sinon.stub(platformUtils, 'isWindows');
        isMacStub = sinon.stub(platformUtils, 'isMac');
        getUserHomeDirStub = sinon.stub(pathUtils, 'getUserHomeDir');
        originalLocalAppData = process.env.LOCALAPPDATA;
    });

    teardown(() => {
        sinon.restore();
        if (originalLocalAppData === undefined) {
            delete process.env.LOCALAPPDATA;
        } else {
            process.env.LOCALAPPDATA = originalLocalAppData;
        }
    });

    test('appends virtualenvs to cache directory', () => {
        isWindowsStub.returns(false);
        isMacStub.returns(false);
        getUserHomeDirStub.returns('/home/test');

        const result = getDefaultPoetryVirtualenvsPath();

        assert.strictEqual(result, path.join('/home/test', '.cache', 'pypoetry', 'virtualenvs'));
    });

    test('Windows: returns correct virtualenvs path', () => {
        isWindowsStub.returns(true);
        process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';

        const result = getDefaultPoetryVirtualenvsPath();

        assert.strictEqual(result, path.join('C:\\Users\\test\\AppData\\Local', 'pypoetry', 'Cache', 'virtualenvs'));
    });

    test('macOS: returns correct virtualenvs path', () => {
        isWindowsStub.returns(false);
        isMacStub.returns(true);
        getUserHomeDirStub.returns('/Users/test');

        const result = getDefaultPoetryVirtualenvsPath();

        assert.strictEqual(result, path.join('/Users/test', 'Library', 'Caches', 'pypoetry', 'virtualenvs'));
    });

    test('returns undefined when cache dir is not available', () => {
        isWindowsStub.returns(false);
        getUserHomeDirStub.returns(undefined);

        const result = getDefaultPoetryVirtualenvsPath();

        assert.strictEqual(result, undefined);
    });
});

suite('getPoetryVirtualenvsPath - {cache-dir} placeholder resolution', () => {
    let execProcessStub: sinon.SinonStub;
    let isWindowsStub: sinon.SinonStub;
    let isMacStub: sinon.SinonStub;
    let getUserHomeDirStub: sinon.SinonStub;
    let getWorkspacePersistentStateStub: sinon.SinonStub;
    let mockState: { get: sinon.SinonStub; set: sinon.SinonStub };

    setup(async () => {
        execProcessStub = sinon.stub(childProcessApis, 'execProcess');
        isWindowsStub = sinon.stub(platformUtils, 'isWindows');
        isMacStub = sinon.stub(platformUtils, 'isMac');
        getUserHomeDirStub = sinon.stub(pathUtils, 'getUserHomeDir');

        // Create a mock state object to track persistence
        mockState = {
            get: sinon.stub(),
            set: sinon.stub().resolves(),
        };
        getWorkspacePersistentStateStub = sinon.stub(persistentState, 'getWorkspacePersistentState');
        getWorkspacePersistentStateStub.resolves(mockState);

        // Clear Poetry cache before each test
        await clearPoetryCache();
    });

    teardown(() => {
        sinon.restore();
    });

    test('resolves {cache-dir} placeholder when poetry config cache-dir succeeds', async () => {
        // First call: virtualenvs.path returns a path with {cache-dir}
        execProcessStub.onFirstCall().resolves({ stdout: '{cache-dir}/virtualenvs\n', stderr: '' });
        // Second call: cache-dir config returns the actual path
        execProcessStub.onSecondCall().resolves({ stdout: '/home/test/.cache/pypoetry\n', stderr: '' });

        const result = await getPoetryVirtualenvsPath('/usr/bin/poetry');

        assert.strictEqual(result, path.join('/home/test/.cache/pypoetry', 'virtualenvs'));
        // Verify the resolved path was persisted
        assert.ok(
            mockState.set.calledWith(
                POETRY_VIRTUALENVS_PATH_KEY,
                path.join('/home/test/.cache/pypoetry', 'virtualenvs'),
            ),
        );
    });

    test('falls back to platform default when poetry config cache-dir fails', async () => {
        isWindowsStub.returns(false);
        isMacStub.returns(false);
        getUserHomeDirStub.returns('/home/test');

        // First call: virtualenvs.path returns a path with {cache-dir}
        execProcessStub.onFirstCall().resolves({ stdout: '{cache-dir}/virtualenvs\n', stderr: '' });
        // Second call: cache-dir config fails
        execProcessStub.onSecondCall().rejects(new Error('Command failed'));

        const result = await getPoetryVirtualenvsPath('/usr/bin/poetry');

        // Should fall back to platform default cache dir
        const expectedPath = path.join('/home/test', '.cache', 'pypoetry', 'virtualenvs');
        assert.strictEqual(result, expectedPath);
        // The resolved path should still be persisted
        assert.ok(mockState.set.calledWith(POETRY_VIRTUALENVS_PATH_KEY, expectedPath));
    });

    test('falls back to platform default when poetry config cache-dir returns non-absolute path', async () => {
        isWindowsStub.returns(false);
        isMacStub.returns(false);
        getUserHomeDirStub.returns('/home/test');

        // First call: virtualenvs.path returns a path with {cache-dir}
        execProcessStub.onFirstCall().resolves({ stdout: '{cache-dir}/virtualenvs\n', stderr: '' });
        // Second call: cache-dir returns a relative path (invalid)
        execProcessStub.onSecondCall().resolves({ stdout: 'relative/path\n', stderr: '' });

        const result = await getPoetryVirtualenvsPath('/usr/bin/poetry');

        // Should fall back to platform default cache dir
        const expectedPath = path.join('/home/test', '.cache', 'pypoetry', 'virtualenvs');
        assert.strictEqual(result, expectedPath);
    });

    test('does not persist path when placeholder cannot be resolved and no platform default', async () => {
        isWindowsStub.returns(false);
        isMacStub.returns(false);
        getUserHomeDirStub.returns(undefined); // No home dir available

        // First call: virtualenvs.path returns a path with {cache-dir}
        execProcessStub.onFirstCall().resolves({ stdout: '{cache-dir}/virtualenvs\n', stderr: '' });
        // Second call: cache-dir config fails
        execProcessStub.onSecondCall().rejects(new Error('Command failed'));

        const result = await getPoetryVirtualenvsPath('/usr/bin/poetry');

        // Should fall back to platform default (which returns undefined when home is not available)
        assert.strictEqual(result, undefined);
        // Path should NOT be persisted when unresolved
        assert.ok(!mockState.set.calledWith(POETRY_VIRTUALENVS_PATH_KEY, sinon.match.any));
    });

    test('handles virtualenvs.path without {cache-dir} placeholder (absolute path)', async () => {
        // virtualenvs.path returns an absolute path directly
        execProcessStub.onFirstCall().resolves({ stdout: '/custom/virtualenvs/path\n', stderr: '' });

        const result = await getPoetryVirtualenvsPath('/usr/bin/poetry');

        assert.strictEqual(result, '/custom/virtualenvs/path');
        // Should be persisted
        assert.ok(mockState.set.calledWith(POETRY_VIRTUALENVS_PATH_KEY, '/custom/virtualenvs/path'));
    });

    test('falls back to platform default when virtualenvs.path returns non-absolute path without placeholder', async () => {
        isWindowsStub.returns(false);
        isMacStub.returns(false);
        getUserHomeDirStub.returns('/home/test');

        // virtualenvs.path returns a relative path (not valid)
        execProcessStub.onFirstCall().resolves({ stdout: 'relative/path\n', stderr: '' });

        const result = await getPoetryVirtualenvsPath('/usr/bin/poetry');

        // Should fall back to platform default
        const expectedPath = path.join('/home/test', '.cache', 'pypoetry', 'virtualenvs');
        assert.strictEqual(result, expectedPath);
    });

    test('uses cached value from persistent state', async () => {
        mockState.get.resolves('/cached/virtualenvs/path');

        const result = await getPoetryVirtualenvsPath('/usr/bin/poetry');

        assert.strictEqual(result, '/cached/virtualenvs/path');
        // Should not call exec since we have a cached value
        assert.ok(!execProcessStub.called);
    });

    test('handles virtualenvs.path config command failure', async () => {
        isWindowsStub.returns(false);
        isMacStub.returns(false);
        getUserHomeDirStub.returns('/home/test');

        // virtualenvs.path config fails
        execProcessStub.onFirstCall().rejects(new Error('Config command failed'));

        const result = await getPoetryVirtualenvsPath('/usr/bin/poetry');

        // Should fall back to platform default
        const expectedPath = path.join('/home/test', '.cache', 'pypoetry', 'virtualenvs');
        assert.strictEqual(result, expectedPath);
    });

    test('Windows: resolves {cache-dir} with platform default when cache-dir query fails', async () => {
        const originalLocalAppData = process.env.LOCALAPPDATA;
        try {
            isWindowsStub.returns(true);
            process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';

            // First call: virtualenvs.path returns a path with {cache-dir}
            execProcessStub.onFirstCall().resolves({ stdout: '{cache-dir}/virtualenvs\n', stderr: '' });
            // Second call: cache-dir config fails
            execProcessStub.onSecondCall().rejects(new Error('Command failed'));

            const result = await getPoetryVirtualenvsPath('C:\\poetry\\poetry.exe');

            const expectedPath = path.join('C:\\Users\\test\\AppData\\Local', 'pypoetry', 'Cache', 'virtualenvs');
            assert.strictEqual(result, expectedPath);
        } finally {
            if (originalLocalAppData === undefined) {
                delete process.env.LOCALAPPDATA;
            } else {
                process.env.LOCALAPPDATA = originalLocalAppData;
            }
        }
    });
});
