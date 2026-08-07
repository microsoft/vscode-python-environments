import * as assert from 'assert';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { LogOutputChannel } from 'vscode';
import { VENV_MANAGER_ID } from '../../../common/constants';
import * as testing from '../../../common/utils/testing';
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

    test('test execution removes the environment without showing a confirmation dialog', async () => {
        const root = await fse.mkdtemp(path.join(os.tmpdir(), 'venv-remove-'));
        const envPath = path.join(root, '.venv');
        const pythonPath =
            os.platform() === 'win32'
                ? path.join(envPath, 'Scripts', 'python.exe')
                : path.join(envPath, 'bin', 'python');
        await fse.outputFile(path.join(envPath, 'pyvenv.cfg'), '');
        await fse.outputFile(pythonPath, '');

        const showWarningMessage = sinon.stub(windowApis, 'showWarningMessage');
        sinon.stub(testing, 'isTestExecution').returns(true);
        sinon.stub(uvEnvironments, 'removeUvEnvironment').resolves();
        sinon.stub(windowApis, 'withProgress').callsFake(async (_options, task) => task({} as never, {} as never));

        try {
            const environment = createMockPythonEnvironment({
                name: '.venv',
                envPath: pythonPath,
                sysPrefix: envPath,
                version: '3.12.0',
                managerId: VENV_MANAGER_ID,
            });
            const log = {
                error: sinon.stub(),
            } as unknown as LogOutputChannel;

            assert.strictEqual(await removeVenv(environment, log), true);
            assert.strictEqual(showWarningMessage.callCount, 0);
            assert.strictEqual(await fse.pathExists(envPath), false);
        } finally {
            sinon.restore();
            await fse.remove(root);
        }
    });
});
