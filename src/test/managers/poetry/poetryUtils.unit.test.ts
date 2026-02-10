import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as platformUtils from '../../../common/utils/platformUtils';
import * as pathUtils from '../../../common/utils/pathUtils';
import { getDefaultPoetryVirtualenvsPath } from '../../../managers/poetry/poetryUtils';

suite('Poetry Utils - getDefaultPoetryVirtualenvsPath', () => {
    let isWindowsStub: sinon.SinonStub;
    let getUserHomeDirStub: sinon.SinonStub;
    let originalPlatform: PropertyDescriptor | undefined;
    let originalEnv: NodeJS.ProcessEnv;

    setup(() => {
        isWindowsStub = sinon.stub(platformUtils, 'isWindows');
        getUserHomeDirStub = sinon.stub(pathUtils, 'getUserHomeDir');
        originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        originalEnv = { ...process.env };
    });

    teardown(() => {
        sinon.restore();
        if (originalPlatform) {
            Object.defineProperty(process, 'platform', originalPlatform);
        }
        process.env = originalEnv;
    });

    test('should return Linux path on Linux', () => {
        isWindowsStub.returns(false);
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        getUserHomeDirStub.returns('/home/testuser');

        const result = getDefaultPoetryVirtualenvsPath();

        assert.strictEqual(result, path.join('/home/testuser', '.cache', 'pypoetry', 'virtualenvs'));
    });

    test('should return macOS path on darwin', () => {
        isWindowsStub.returns(false);
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
        getUserHomeDirStub.returns('/Users/testuser');

        const result = getDefaultPoetryVirtualenvsPath();

        assert.strictEqual(result, path.join('/Users/testuser', 'Library', 'Caches', 'pypoetry', 'virtualenvs'));
    });

    test('should return LOCALAPPDATA path on Windows when LOCALAPPDATA is set', () => {
        isWindowsStub.returns(true);
        process.env.LOCALAPPDATA = 'C:\\Users\\testuser\\AppData\\Local';
        process.env.APPDATA = 'C:\\Users\\testuser\\AppData\\Roaming';

        const result = getDefaultPoetryVirtualenvsPath();

        assert.strictEqual(
            result,
            path.join('C:\\Users\\testuser\\AppData\\Local', 'pypoetry', 'Cache', 'virtualenvs'),
        );
    });

    test('should fall back to APPDATA on Windows when LOCALAPPDATA is not set', () => {
        isWindowsStub.returns(true);
        delete process.env.LOCALAPPDATA;
        process.env.APPDATA = 'C:\\Users\\testuser\\AppData\\Roaming';

        const result = getDefaultPoetryVirtualenvsPath();

        assert.strictEqual(
            result,
            path.join('C:\\Users\\testuser\\AppData\\Roaming', 'pypoetry', 'Cache', 'virtualenvs'),
        );
    });

    test('should return undefined on Windows when neither LOCALAPPDATA nor APPDATA is set', () => {
        isWindowsStub.returns(true);
        delete process.env.LOCALAPPDATA;
        delete process.env.APPDATA;

        const result = getDefaultPoetryVirtualenvsPath();

        assert.strictEqual(result, undefined);
    });

    test('should return undefined when home directory is empty string on non-Windows', () => {
        isWindowsStub.returns(false);
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        getUserHomeDirStub.returns('');

        const result = getDefaultPoetryVirtualenvsPath();

        assert.strictEqual(result, undefined);
    });

    test('should return undefined when home directory is undefined on non-Windows', () => {
        isWindowsStub.returns(false);
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        getUserHomeDirStub.returns(undefined);

        const result = getDefaultPoetryVirtualenvsPath();

        assert.strictEqual(result, undefined);
    });
});
