import assert from 'node:assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { getPyenvDir } from '../../../managers/pyenv/pyenvUtils';

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
