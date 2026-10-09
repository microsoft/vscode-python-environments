import assert from 'node:assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as childProcessApis from '../../../common/childProcess.apis';
import { getPyenvDir, getPyenvVersion } from '../../../managers/pyenv/pyenvUtils';

suite('pyenvUtils - getPyenvDir', () => {
    let originalPyenvRoot: string | undefined;

    setup(() => {
        originalPyenvRoot = process.env.PYENV_ROOT;
        delete process.env.PYENV_ROOT;
    });

    teardown(() => {
        sinon.restore();
        if (originalPyenvRoot !== undefined) {
            process.env.PYENV_ROOT = originalPyenvRoot;
        } else {
            delete process.env.PYENV_ROOT;
        }
    });

    test('should use PYENV_ROOT when set', () => {
        const pyenvRoot = path.join(path.sep, 'custom', 'pyenv', 'root');
        process.env.PYENV_ROOT = pyenvRoot;
        const pyenvBin = path.join(path.sep, 'other', 'bin', 'pyenv');
        const result = getPyenvDir(pyenvBin);
        assert.strictEqual(result, pyenvRoot);
    });

    test('should go up 2 levels on POSIX when PYENV_ROOT is not set (bin/pyenv -> pyenv root)', () => {
        // e.g. /home/user/.pyenv/bin/pyenv
        const pyenvBin = path.join(path.sep, 'home', 'user', '.pyenv', 'bin', 'pyenv');
        const result = getPyenvDir(pyenvBin);
        assert.strictEqual(result, path.join(path.sep, 'home', 'user', '.pyenv'));
    });

    test('should go up 2 levels on Windows when PYENV_ROOT is not set (pyenv-win/bin/pyenv.bat -> pyenv-win)', () => {
        // e.g. C:\Users\user\.pyenv\pyenv-win\bin\pyenv.bat -> C:\Users\user\.pyenv\pyenv-win
        const pyenvBin = path.join('C:', 'Users', 'user', '.pyenv', 'pyenv-win', 'bin', 'pyenv.bat');
        const result = getPyenvDir(pyenvBin);
        assert.strictEqual(result, path.join('C:', 'Users', 'user', '.pyenv', 'pyenv-win'));
    });
});

suite('pyenvUtils - getPyenvVersion', () => {
    teardown(() => {
        sinon.restore();
    });

    test('parses the Pyenv version', async () => {
        const execProcess = sinon
            .stub(childProcessApis, 'execProcess')
            .resolves({ stdout: 'pyenv 2.5.3\n', stderr: '' });

        const version = await getPyenvVersion('pyenv');

        assert.strictEqual(version, '2.5.3');
        assert.ok(execProcess.calledWith('"pyenv" --version'));
    });

    test('parses the Pyenv for Windows version', async () => {
        sinon.stub(childProcessApis, 'execProcess').resolves({ stdout: 'pyenv-win 3.1.1\n', stderr: '' });

        assert.strictEqual(await getPyenvVersion('pyenv.bat'), '3.1.1');
    });

    test('returns undefined when the command fails', async () => {
        sinon.stub(childProcessApis, 'execProcess').rejects(new Error('Command not found'));

        assert.strictEqual(await getPyenvVersion('pyenv'), undefined);
    });
});
