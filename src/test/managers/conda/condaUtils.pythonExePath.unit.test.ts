/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { EnvironmentManager } from '../../../api';
import { CondaEnvManager } from '../../../managers/conda/condaEnvManager';
import { getNamedCondaPythonInfo, getPrefixesCondaPythonInfo } from '../../../managers/conda/condaUtils';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import * as platformUtils from '../../../common/utils/platformUtils';

suite('Conda Python executable path construction', () => {
    let isWindowsStub: sinon.SinonStub;
    let mockManager: EnvironmentManager;

    setup(() => {
        mockManager = new CondaEnvManager(
            {} as NativePythonFinder,
            {} as any,
            { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() } as any,
        );
    });

    teardown(() => {
        sinon.restore();
    });

    test('getNamedCondaPythonInfo: executable path uses bin/python on non-Windows', async () => {
        isWindowsStub = sinon.stub(platformUtils, 'isWindows').returns(false);
        const prefix = '/home/user/miniconda3/envs/myenv';
        const executable = path.posix.join(prefix, 'bin', 'python');
        const info = await getNamedCondaPythonInfo('myenv', prefix, executable, '3.12.0', '/usr/bin/conda', mockManager);

        assert.ok(
            info.execInfo.run.executable.includes(path.join('bin', 'python')) ||
                info.execInfo.run.executable.endsWith('python'),
            `executable should contain bin/python, got: ${info.execInfo.run.executable}`,
        );
        isWindowsStub.restore();
    });

    test('getPrefixesCondaPythonInfo: executable path uses bin/python on non-Windows', async () => {
        isWindowsStub = sinon.stub(platformUtils, 'isWindows').returns(false);
        const prefix = '/home/user/projects/.conda';
        const executable = path.posix.join(prefix, 'bin', 'python');
        const info = await getPrefixesCondaPythonInfo(prefix, executable, '3.12.0', '/usr/bin/conda', mockManager);

        assert.ok(
            info.execInfo.run.executable.includes(path.join('bin', 'python')) ||
                info.execInfo.run.executable.endsWith('python'),
            `executable should contain bin/python, got: ${info.execInfo.run.executable}`,
        );
        isWindowsStub.restore();
    });

    test('getNamedCondaPythonInfo: executable path uses python.exe on Windows', async () => {
        isWindowsStub = sinon.stub(platformUtils, 'isWindows').returns(true);
        const prefix = 'C:\\Users\\user\\miniconda3\\envs\\myenv';
        const executable = path.win32.join(prefix, 'python.exe');
        const info = await getNamedCondaPythonInfo('myenv', prefix, executable, '3.12.0', 'C:\\conda\\conda.exe', mockManager);

        assert.ok(
            info.execInfo.run.executable.endsWith('python.exe'),
            `executable should end with python.exe, got: ${info.execInfo.run.executable}`,
        );
        isWindowsStub.restore();
    });
});
