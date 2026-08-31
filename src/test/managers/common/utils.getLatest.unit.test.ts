import assert from 'node:assert';
import path from 'node:path';
import { getLatest } from '../../../managers/common/utils';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

suite('getLatest', () => {
    test('selects the latest normalized Python version', () => {
        const systemPython = createMockPythonEnvironment({
            envPath: path.join('usr', 'bin', 'python3'),
            version: '3.9.6.final.0',
        });
        const homebrewPython = createMockPythonEnvironment({
            envPath: path.join('opt', 'homebrew', 'bin', 'python3'),
            version: '3.14.3.final.0',
        });

        assert.strictEqual(getLatest([systemPython, homebrewPython]), homebrewPython);
    });

    test('prefers a comparable version when the first version is invalid', () => {
        const invalid = createMockPythonEnvironment({ envPath: path.join('invalid', 'python'), version: 'unknown' });
        const valid = createMockPythonEnvironment({ envPath: path.join('valid', 'python'), version: '3.14.3' });

        assert.strictEqual(getLatest([invalid, valid]), valid);
    });

    test('excludes errored environments when a usable environment exists', () => {
        const older = createMockPythonEnvironment({ envPath: path.join('older', 'python'), version: '3.9.6' });
        const errored = {
            ...createMockPythonEnvironment({ envPath: path.join('errored', 'python'), version: '3.14.3' }),
            error: 'Broken interpreter',
        };

        assert.strictEqual(getLatest([older, errored]), older);
    });
});