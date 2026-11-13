import * as assert from 'assert';
import type { BigIntStats } from 'fs';
import fse from 'fs-extra';
import os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import { Common } from '../../../common/localize';
import * as windowApis from '../../../common/window.apis';
import * as uvEnvironments from '../../../managers/builtin/uvEnvironments';
import { removeVenv } from '../../../managers/builtin/venvUtils';
import { createMockLogOutputChannel } from '../../mocks/helper';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

suite('venvUtils Path Validation', () => {
    suite('isDriveRoot behavior', () => {
        test('should identify Windows drive roots correctly', function () {
            if (os.platform() !== 'win32') {
                this.skip();
                return;
            }

            const driveRoots = ['C:\\', 'D:\\', 'c:\\', 'C:/'];

            for (const root of driveRoots) {
                const normalized = path.normalize(root);
                const isDrive = /^[a-zA-Z]:[\\/]?$/.test(normalized);
                assert.strictEqual(
                    isDrive,
                    true,
                    `${root} (normalized: ${normalized}) should be identified as drive root`,
                );
            }
        });

        test('should not identify non-root Windows paths as drive roots', function () {
            if (os.platform() !== 'win32') {
                this.skip();
                return;
            }

            const nonRoots = ['C:\\Users', 'C:\\Program Files', 'D:\\python\\venv', 'C:\\Users\\test\\.venv'];

            for (const nonRoot of nonRoots) {
                const normalized = path.normalize(nonRoot);
                const isDrive = /^[a-zA-Z]:[\\/]?$/.test(normalized);
                assert.strictEqual(isDrive, false, `${nonRoot} should not be identified as drive root`);
            }
        });

        test('should identify Unix root correctly', function () {
            if (os.platform() === 'win32') {
                this.skip();
                return;
            }

            const normalized = path.normalize('/');
            assert.strictEqual(normalized, '/', 'Unix root should be /');
        });
    });

    suite('hasMinimumPathDepth behavior', () => {
        test('should correctly count path components on Windows', function () {
            if (os.platform() !== 'win32') {
                this.skip();
                return;
            }

            const testCases: [string, number][] = [
                ['C:\\', 1],
                ['C:\\Users', 2],
                ['C:\\Users\\test', 3],
                ['C:\\Users\\test\\.venv', 4],
            ];

            for (const [testPath, expectedDepth] of testCases) {
                const normalized = path.normalize(testPath);
                const parts = normalized.split(path.sep).filter((p) => p.length > 0 && p !== '.');
                assert.strictEqual(parts.length, expectedDepth, `${testPath} should have ${expectedDepth} components`);
            }
        });

        test('should correctly count path components on Unix', function () {
            if (os.platform() === 'win32') {
                this.skip();
                return;
            }

            const testCases: [string, number][] = [
                ['/', 0],
                ['/home', 1],
                ['/home/user', 2],
                ['/home/user/.venv', 3],
            ];

            for (const [testPath, expectedDepth] of testCases) {
                const normalized = path.normalize(testPath);
                const parts = normalized.split(path.sep).filter((p) => p.length > 0 && p !== '.');
                assert.strictEqual(parts.length, expectedDepth, `${testPath} should have ${expectedDepth} components`);
            }
        });
    });

    suite('Path normalization in removeVenv', () => {
        test('should normalize path separators before checking python.exe suffix', () => {
            const pythonPath = os.platform() === 'win32' ? 'python.exe' : 'python';

            const mixedPath =
                os.platform() === 'win32' ? 'C:/Users/test/.venv/Scripts/python.exe' : '/home/user/.venv/bin/python';

            const normalizedPath = path.normalize(mixedPath);
            const endsWithPython = normalizedPath.endsWith(pythonPath);

            assert.strictEqual(endsWithPython, true, 'Normalized path should end with python executable');

            const envPath = path.dirname(path.dirname(normalizedPath));
            const expectedEnvPath =
                os.platform() === 'win32' ? path.normalize('C:/Users/test/.venv') : '/home/user/.venv';

            assert.strictEqual(envPath, expectedEnvPath, 'Environment path should be the venv root');
        });

        test('should correctly derive venv path from python executable path', () => {
            const pythonPath = os.platform() === 'win32' ? 'python.exe' : 'python';

            const testPaths =
                os.platform() === 'win32'
                    ? [
                          { input: 'C:\\project\\.venv\\Scripts\\python.exe', expected: 'C:\\project\\.venv' },
                          { input: 'D:\\envs\\myenv\\Scripts\\python.exe', expected: 'D:\\envs\\myenv' },
                      ]
                    : [
                          { input: '/home/user/project/.venv/bin/python', expected: '/home/user/project/.venv' },
                          { input: '/opt/envs/myenv/bin/python', expected: '/opt/envs/myenv' },
                      ];

            for (const { input, expected } of testPaths) {
                const normalized = path.normalize(input);
                const envPath = normalized.endsWith(pythonPath) ? path.dirname(path.dirname(normalized)) : normalized;

                assert.strictEqual(envPath, expected, `${input} should derive to ${expected}`);
            }
        });
    });
});

suite('venvUtils removeVenv validation integration', () => {
    test('pyvenv.cfg detection should use correct path', async () => {
        const testEnvPath = os.platform() === 'win32' ? 'C:\\Users\\test\\.venv' : '/home/user/.venv';

        const expectedCfgPath = path.join(testEnvPath, 'pyvenv.cfg');

        assert.strictEqual(
            expectedCfgPath,
            os.platform() === 'win32' ? 'C:\\Users\\test\\.venv\\pyvenv.cfg' : '/home/user/.venv/pyvenv.cfg',
            'Should check for pyvenv.cfg in the environment root',
        );
    });

    suite('venvUtils bounded Windows removal', () => {
        const envPath = Uri.file(path.resolve('workspace', 'project', '.venv')).fsPath;
        const identity = { dev: 1n, ino: 10n } as BigIntStats;
        let clock: sinon.SinonFakeTimers;
        let platform: sinon.SinonStub;
        let remove: sinon.SinonStub;
        let lstat: sinon.SinonStub;
        let pathExists: sinon.SinonStub;
        let untrack: sinon.SinonStub;
        let showError: sinon.SinonStub;
        let log: ReturnType<typeof createMockLogOutputChannel>;

        const sharingError = () => Object.assign(new Error('File is in use'), { code: 'EPERM' });
        const removeEnvironment = () =>
            removeVenv(createMockPythonEnvironment({ name: '.venv', envPath }), log, { runHeadless: true });

        setup(() => {
            clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
            platform = sinon.stub(os, 'platform').returns('win32');
            pathExists = sinon.stub(fse, 'pathExists').resolves(true);
            lstat = sinon.stub(fse, 'lstat').resolves(identity);
            remove = sinon.stub(fse, 'remove').resolves();
            untrack = sinon.stub(uvEnvironments, 'removeUvEnvironment').resolves();
            showError = sinon.stub(windowApis, 'showErrorMessage').resolves(undefined);
            sinon.stub(windowApis, 'withProgress').callsFake(async (_options, task) => task({} as never, {} as never));
            log = createMockLogOutputChannel();
        });

        teardown(() => sinon.restore());

        for (const code of ['EPERM', 'EBUSY']) {
            test(`recovers from ${code} after partial deletion, then untracks once`, async () => {
                remove.onFirstCall().callsFake(async () => {
                    pathExists.resolves(false);
                    throw Object.assign(new Error('Temporary file lock'), { code });
                });
                const pending = removeEnvironment();

                await clock.tickAsync(0);
                sinon.assert.notCalled(untrack);
                await clock.tickAsync(100);

                assert.strictEqual(await pending, true);
                sinon.assert.calledTwice(remove);
                sinon.assert.calledOnce(pathExists);
                sinon.assert.calledOnce(untrack);
                sinon.assert.notCalled(showError);
            });
        }

        test('persistent fast failures share one bounded retry window', async () => {
            const attempts: number[] = [];
            remove.callsFake(async () => {
                attempts.push(performance.now());
                throw sharingError();
            });
            const pending = removeEnvironment();
            await clock.tickAsync(1_000);

            assert.strictEqual(await pending, false);
            assert.strictEqual(attempts.length, 5);
            assert.ok(attempts.every((time) => time < 500));
            sinon.assert.notCalled(untrack);
            sinon.assert.calledOnce(showError);
            sinon.assert.calledOnce(log.error as sinon.SinonStub);
        });

        test('does not retry when the initial deletion already consumed the budget', async () => {
            remove.callsFake(async () => {
                await new Promise<void>((resolve) => setTimeout(resolve, 600));
                throw sharingError();
            });
            const pending = removeEnvironment();
            await clock.tickAsync(1_000);

            assert.strictEqual(await pending, false);
            sinon.assert.calledOnce(remove);
            sinon.assert.notCalled(untrack);
            sinon.assert.calledOnce(showError);
        });

        test('does not abandon a slow deletion that is still running', async () => {
            remove.callsFake(async () => {
                await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
            });
            const pending = removeEnvironment();
            await clock.tickAsync(1_000);
            sinon.assert.notCalled(untrack);
            await clock.tickAsync(1_000);

            assert.strictEqual(await pending, true);
            sinon.assert.calledOnce(remove);
            sinon.assert.calledOnce(untrack);
            sinon.assert.notCalled(showError);
        });

        test('does not start another attempt after a delayed timer exhausts the budget', async () => {
            remove.rejects(sharingError());
            const pending = removeEnvironment();
            await clock.tickAsync(0);
            sinon.stub(performance, 'now').returns(1_000);
            await clock.tickAsync(100);

            assert.strictEqual(await pending, false);
            sinon.assert.calledOnce(remove);
            sinon.assert.notCalled(untrack);
        });

        test('does not retry after an identity recheck consumes the remaining budget', async () => {
            remove.rejects(sharingError());
            lstat.onSecondCall().callsFake(async () => {
                await new Promise<void>((resolve) => setTimeout(resolve, 600));
                return identity;
            });
            const pending = removeEnvironment();
            await clock.tickAsync(1_000);

            assert.strictEqual(await pending, false);
            sinon.assert.calledOnce(remove);
            sinon.assert.notCalled(untrack);
        });

        test('does not delete a replacement directory at the same path', async () => {
            remove.rejects(sharingError());
            lstat.onSecondCall().resolves({ ...identity, ino: identity.ino + 1n });
            const pending = removeEnvironment();
            await clock.tickAsync(100);

            assert.strictEqual(await pending, false);
            sinon.assert.calledOnce(remove);
            sinon.assert.notCalled(untrack);
            sinon.assert.calledOnce(showError);
        });

        test('treats a directory removed by another operation as successfully removed', async () => {
            remove.rejects(sharingError());
            lstat.onSecondCall().rejects(Object.assign(new Error('Already removed'), { code: 'ENOENT' }));
            const pending = removeEnvironment();
            await clock.tickAsync(100);

            assert.strictEqual(await pending, true);
            sinon.assert.calledOnce(remove);
            sinon.assert.calledOnce(untrack);
            sinon.assert.notCalled(showError);
        });

        test('keeps the original single-attempt behavior outside Windows', async () => {
            platform.returns('linux');
            remove.rejects(sharingError());

            assert.strictEqual(await removeEnvironment(), false);
            sinon.assert.calledOnce(remove);
            sinon.assert.notCalled(lstat);
            sinon.assert.notCalled(untrack);
        });

        test('does not retry non-sharing errors', async () => {
            remove.rejects(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));

            assert.strictEqual(await removeEnvironment(), false);
            sinon.assert.calledOnce(remove);
            sinon.assert.notCalled(untrack);
            sinon.assert.calledOnce(showError);
        });

        test('identity lookup failure does not prevent the original deletion attempt', async () => {
            lstat.rejects(Object.assign(new Error('Identity unavailable'), { code: 'EACCES' }));

            assert.strictEqual(await removeEnvironment(), true);
            sinon.assert.calledOnce(remove);
            sinon.assert.calledOnce(untrack);
        });

        test('does not retry when the filesystem provides no usable directory identity', async () => {
            lstat.resolves({ ...identity, ino: 0n });
            remove.rejects(sharingError());

            assert.strictEqual(await removeEnvironment(), false);
            sinon.assert.calledOnce(remove);
            sinon.assert.notCalled(untrack);
        });

        test('never retries deletion after an untracking failure', async () => {
            untrack.rejects(sharingError());

            assert.strictEqual(await removeEnvironment(), false);
            sinon.assert.calledOnce(remove);
            sinon.assert.calledOnce(untrack);
            sinon.assert.calledOnce(showError);
        });

        test('never attempts deletion when venv validation fails', async () => {
            pathExists.resolves(false);

            assert.strictEqual(await removeEnvironment(), false);
            sinon.assert.notCalled(remove);
            sinon.assert.notCalled(lstat);
            sinon.assert.notCalled(untrack);
        });
    });

    test('headless removal skips confirmation and removes the environment', async () => {
        const tempRoot = await fse.mkdtemp(path.join(os.tmpdir(), 'remove-venv-'));
        const envPath = path.join(tempRoot, '.venv');
        await fse.outputFile(path.join(envPath, 'pyvenv.cfg'), 'home = base');
        const showWarningMessageStub = sinon.stub(windowApis, 'showWarningMessage');
        sinon.stub(windowApis, 'withProgress').callsFake(async (_options, task) => task({} as never, {} as never));
        sinon.stub(uvEnvironments, 'removeUvEnvironment').resolves();

        try {
            const removed = await removeVenv(
                createMockPythonEnvironment({ name: '.venv', envPath }),
                createMockLogOutputChannel(),
                { runHeadless: true },
            );

            assert.strictEqual(removed, true);
            assert.strictEqual(showWarningMessageStub.callCount, 0);
            assert.strictEqual(await fse.pathExists(envPath), false);
        } finally {
            sinon.restore();
            await fse.remove(tempRoot);
        }
    });

    test('interactive removal still requires confirmation during test execution', async () => {
        const root = await fse.mkdtemp(path.join(os.tmpdir(), 'venv-remove-'));
        const envPath = path.join(root, '.venv');
        await fse.outputFile(path.join(envPath, 'pyvenv.cfg'), '');

        const showWarningMessage = sinon.stub(windowApis, 'showWarningMessage').resolves({ title: Common.no });

        try {
            const removed = await removeVenv(
                createMockPythonEnvironment({ name: '.venv', envPath }),
                createMockLogOutputChannel(),
            );

            assert.strictEqual(removed, false);
            assert.strictEqual(showWarningMessage.callCount, 1);
            assert.strictEqual(await fse.pathExists(envPath), true);
        } finally {
            sinon.restore();
            await fse.remove(root);
        }
    });
});
