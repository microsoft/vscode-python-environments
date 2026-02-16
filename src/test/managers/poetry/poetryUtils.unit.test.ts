import assert from 'node:assert';
import * as sinon from 'sinon';
import { EnvironmentManager, PythonEnvironment, PythonEnvironmentApi, PythonEnvironmentInfo } from '../../../api';
import * as childProcessApis from '../../../common/childProcess.apis';
import { NativeEnvInfo } from '../../../managers/common/nativePythonFinder';
import * as utils from '../../../managers/common/utils';
import {
    getPoetryVersion,
    isPoetryVirtualenvsInProject,
    nativeToPythonEnv,
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
