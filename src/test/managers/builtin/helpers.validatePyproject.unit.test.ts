import assert from 'assert';
import { Uri } from 'vscode';
import { shouldProceedAfterPyprojectValidation, ValidationError } from '../../../managers/builtin/pipUtils';

suite('pipUtils - validatePyproject', () => {
    const mockValidationError: ValidationError = {
        message: 'Invalid package name "my package" in pyproject.toml.',
        fileUri: Uri.file('/test/path/pyproject.toml'),
    };

    test('should return true when no validation error exists', async () => {
        // Arrange: no validation error
        const validationError = undefined;
        const install = ['-e', '/test/path'];

        // Act
        const result = await shouldProceedAfterPyprojectValidation(validationError, install);

        // Assert
        assert.strictEqual(result, true, 'Should proceed when no validation error');
    });

    test('should return true when install array is empty', async () => {
        // Arrange: validation error exists but no packages selected
        const install: string[] = [];

        // Act
        const result = await shouldProceedAfterPyprojectValidation(mockValidationError, install);

        // Assert
        assert.strictEqual(result, true, 'Should proceed when no packages selected');
    });

    test('should return true when only requirements.txt packages selected (no -e flag)', async () => {
        // Arrange: validation error exists but only requirements.txt packages selected
        const install = ['-r', '/test/requirements.txt'];

        // Act
        const result = await shouldProceedAfterPyprojectValidation(mockValidationError, install);

        // Assert
        assert.strictEqual(result, true, 'Should proceed when no TOML packages selected');
    });

    test('should return true when only PyPI packages selected (no flags at all)', async () => {
        // Arrange: only PyPI package names, no flags
        const install = ['numpy', 'pandas', 'requests'];

        // Act
        const result = await shouldProceedAfterPyprojectValidation(mockValidationError, install);

        // Assert
        assert.strictEqual(result, true, 'Should proceed when only PyPI packages selected');
    });

    test('should not trigger on -e flag at end of array without following argument', async () => {
        // Arrange: -e flag is last item (malformed, but should not crash)
        const install = ['numpy', '-e'];
        // This is edge case - -e at end means no path follows, so index + 1 < arr.length is false

        // Act
        const result = await shouldProceedAfterPyprojectValidation(mockValidationError, install);

        // Assert
        assert.strictEqual(result, true, 'Should not crash on malformed -e flag at end');
    });
});
