import * as assert from 'assert';
import * as path from 'path';
import { isSameEnvironmentForProjectSelection } from '../../common/utils/environmentUtils';
import { createMockPythonEnvironment } from '../mocks/pythonEnvironment';

suite('Environment identity utilities', () => {
    test('reconciles same-manager picker descriptors by normalized absolute path', () => {
        const environmentPath = path.join(process.cwd(), 'same-environment', 'python');
        const first = createMockPythonEnvironment({
            envPath: environmentPath,
            id: 'first-id',
            managerId: 'ms-python.python:venv',
        });
        const second = createMockPythonEnvironment({
            envPath: environmentPath,
            id: 'second-id',
            managerId: 'ms-python.python:venv',
        });

        assert.strictEqual(isSameEnvironmentForProjectSelection(first, second), true);
    });
});
