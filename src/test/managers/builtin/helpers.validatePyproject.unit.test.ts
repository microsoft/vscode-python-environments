import * as tomljs from '@iarna/toml';
import assert from 'assert';
import { Uri } from 'vscode';
import {
    shouldProceedAfterPyprojectValidation,
    validatePyprojectToml,
    ValidationError,
} from '../../../managers/builtin/pipUtils';

suite('pipUtils - validatePyproject', () => {
    suite('shouldProceedAfterPyprojectValidation', () => {
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

    function verifyValidationError(toml: tomljs.JsonMap, expectedError: string | undefined) {
        const ActualError = validatePyprojectToml(toml);
        assert.strictEqual(ActualError, expectedError);
    }

    suite('validatePyprojectToml - Package Name Validation (PEP 508)', () => {
        test('should accept valid single-character package name', () => {
            const toml: tomljs.JsonMap = {
                project: { name: 'a' } as tomljs.JsonMap,
            };
            verifyValidationError(toml, undefined);
        });

        test('should accept valid package name with letters and numbers', () => {
            const toml: tomljs.JsonMap = {
                project: { name: 'mypackage123' } as tomljs.JsonMap,
            };
            verifyValidationError(toml, undefined);
        });

        test('should accept valid package name with hyphens', () => {
            const toml: tomljs.JsonMap = {
                project: { name: 'my-package' } as tomljs.JsonMap,
            };
            verifyValidationError(toml, undefined);
        });

        test('should accept valid package name with underscores', () => {
            const toml: tomljs.JsonMap = {
                project: { name: 'my_package' } as tomljs.JsonMap,
            };
            verifyValidationError(toml, undefined);
        });

        test('should accept valid package name with dots', () => {
            const toml: tomljs.JsonMap = {
                project: { name: 'my.package' } as tomljs.JsonMap,
            };
            verifyValidationError(toml, undefined);
        });

        test('should accept valid package name with mixed separators', () => {
            const toml: tomljs.JsonMap = {
                project: { name: 'my-package_name.v2' } as tomljs.JsonMap,
            };
            verifyValidationError(toml, undefined);
        });

        test('should accept complex valid package name', () => {
            const toml: tomljs.JsonMap = {
                project: { name: 'Django-REST-framework' } as tomljs.JsonMap,
            };
            verifyValidationError(toml, undefined);
        });

        test('should reject package name with spaces', () => {
            const toml: tomljs.JsonMap = {
                project: { name: 'my package' } as tomljs.JsonMap,
            };
            verifyValidationError(toml, 'Invalid package name "my package" in pyproject.toml.');
        });

        test('should reject package name starting with hyphen', () => {
            const toml: tomljs.JsonMap = {
                project: { name: '-mypackage' } as tomljs.JsonMap,
            };
            verifyValidationError(toml, 'Invalid package name "-mypackage" in pyproject.toml.');
        });

        test('should reject package name ending with hyphen', () => {
            const toml: tomljs.JsonMap = {
                project: { name: 'mypackage-' } as tomljs.JsonMap,
            };
            verifyValidationError(toml, 'Invalid package name "mypackage-" in pyproject.toml.');
        });

        test('should reject package name starting with dot', () => {
            const toml: tomljs.JsonMap = {
                project: { name: '.mypackage' } as tomljs.JsonMap,
            };
            verifyValidationError(toml, 'Invalid package name ".mypackage" in pyproject.toml.');
        });

        test('should reject package name ending with dot', () => {
            const toml: tomljs.JsonMap = {
                project: { name: 'mypackage.' } as tomljs.JsonMap,
            };
            verifyValidationError(toml, 'Invalid package name "mypackage." in pyproject.toml.');
        });

        test('should reject package name starting with underscore', () => {
            const toml: tomljs.JsonMap = {
                project: { name: '_mypackage' } as tomljs.JsonMap,
            };
            verifyValidationError(toml, 'Invalid package name "_mypackage" in pyproject.toml.');
        });

        test('should reject package name ending with underscore', () => {
            const toml: tomljs.JsonMap = {
                project: { name: 'mypackage_' } as tomljs.JsonMap,
            };
            verifyValidationError(toml, 'Invalid package name "mypackage_" in pyproject.toml.');
        });

        test('should reject empty package name', () => {
            const toml: tomljs.JsonMap = {
                project: { name: '' } as tomljs.JsonMap,
            };
            verifyValidationError(toml, 'Invalid package name "" in pyproject.toml.');
        });

        test('should reject package name with special characters', () => {
            const toml: tomljs.JsonMap = {
                project: { name: 'my@package' } as tomljs.JsonMap,
            };
            verifyValidationError(toml, 'Invalid package name "my@package" in pyproject.toml.');
        });

        test('should reject package name with only separator', () => {
            const toml: tomljs.JsonMap = {
                project: { name: '-' } as tomljs.JsonMap,
            };
            verifyValidationError(toml, 'Invalid package name "-" in pyproject.toml.');
        });

        test('should accept when no project section exists', () => {
            const toml: tomljs.JsonMap = {};
            verifyValidationError(toml, undefined);
        });
    });

    suite('validatePyprojectToml - Required Fields (PEP 621)', () => {
        test('should accept valid project with name', () => {
            const toml: tomljs.JsonMap = {
                project: { name: 'test' } as tomljs.JsonMap,
            };
            verifyValidationError(toml, undefined);
        });

        test('should reject project without name field', () => {
            const toml: tomljs.JsonMap = {
                project: { version: '1.0.0' } as tomljs.JsonMap,
            };
            verifyValidationError(toml, 'Missing required field "name" in [project] section of pyproject.toml.');
        });

        test('should accept when no project section exists', () => {
            const toml: tomljs.JsonMap = {};
            verifyValidationError(toml, undefined);
        });
    });

    suite('validatePyprojectToml - Build System (PEP 518)', () => {
        test('should accept valid build-system with requires', () => {
            const toml: tomljs.JsonMap = {
                project: { name: 'test' } as tomljs.JsonMap,
                'build-system': {
                    requires: ['setuptools', 'wheel'],
                } as tomljs.JsonMap,
            };
            verifyValidationError(toml, undefined);
        });

        test('should reject build-system without requires field', () => {
            const toml: tomljs.JsonMap = {
                project: { name: 'test' } as tomljs.JsonMap,
                'build-system': {
                    'build-backend': 'setuptools.build_meta',
                } as tomljs.JsonMap,
            };
            verifyValidationError(
                toml,
                'Missing required field "requires" in [build-system] section of pyproject.toml.',
            );
        });

        test('should accept when no build-system section exists', () => {
            const toml: tomljs.JsonMap = {
                project: { name: 'test' } as tomljs.JsonMap,
            };
            verifyValidationError(toml, undefined);
        });
    });
});
