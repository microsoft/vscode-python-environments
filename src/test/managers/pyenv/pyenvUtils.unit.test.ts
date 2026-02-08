import assert from 'node:assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as platformUtils from '../../../common/utils/platformUtils';
import { getPyenvDir } from '../../../managers/pyenv/pyenvUtils';

suite('pyenvUtils - getPyenvDir', () => {
    let isWindowsStub: sinon.SinonStub;

    setup(() => {
        isWindowsStub = sinon.stub(platformUtils, 'isWindows');
    });

    teardown(() => {
        sinon.restore();
    });

    test('should go up 2 levels on POSIX (bin/pyenv -> pyenv root)', () => {
        isWindowsStub.returns(false);
        // e.g. /home/user/.pyenv/bin/pyenv
        const pyenvBin = path.join('home', 'user', '.pyenv', 'bin', 'pyenv');
        const result = getPyenvDir(pyenvBin);
        assert.strictEqual(result, path.join('home', 'user', '.pyenv'));
    });

    test('should go up 3 levels on Windows (pyenv-win/bin/pyenv.bat -> pyenv root)', () => {
        isWindowsStub.returns(true);
        // e.g. C:\Users\user\.pyenv\pyenv-win\bin\pyenv.bat
        const pyenvBin = path.join('C:', 'Users', 'user', '.pyenv', 'pyenv-win', 'bin', 'pyenv.bat');
        const result = getPyenvDir(pyenvBin);
        assert.strictEqual(result, path.join('C:', 'Users', 'user', '.pyenv'));
    });
});
