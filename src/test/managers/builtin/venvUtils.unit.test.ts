import assert from 'assert';
import { CreateEnvironmentResult } from '../../../managers/builtin/venvUtils';

suite('VenvUtils Tests', () => {
    suite('CreateEnvironmentResult', () => {
        test('should properly represent successful environment and package creation', () => {
            const result: CreateEnvironmentResult = {
                environment: undefined, // Mock environment would go here
                environmentCreated: true,
                packagesInstalled: true,
                attemptedPackages: { install: ['pytest'], uninstall: [] },
            };

            assert.strictEqual(result.environmentCreated, true);
            assert.strictEqual(result.packagesInstalled, true);
            assert.strictEqual(result.environmentCreationError, undefined);
            assert.strictEqual(result.packageInstallationError, undefined);
            assert.deepStrictEqual(result.attemptedPackages?.install, ['pytest']);
        });

        test('should properly represent environment creation success but package installation failure', () => {
            const packageError = new Error('Failed to install packages');
            const result: CreateEnvironmentResult = {
                environment: undefined, // Mock environment would go here
                environmentCreated: true,
                packagesInstalled: false,
                packageInstallationError: packageError,
                attemptedPackages: { install: ['conflicting-package'], uninstall: [] },
            };

            assert.strictEqual(result.environmentCreated, true);
            assert.strictEqual(result.packagesInstalled, false);
            assert.strictEqual(result.environmentCreationError, undefined);
            assert.strictEqual(result.packageInstallationError, packageError);
            assert.deepStrictEqual(result.attemptedPackages?.install, ['conflicting-package']);
        });

        test('should properly represent complete environment creation failure', () => {
            const envError = new Error('Failed to create environment');
            const result: CreateEnvironmentResult = {
                environmentCreated: false,
                packagesInstalled: false,
                environmentCreationError: envError,
                attemptedPackages: { install: ['some-package'], uninstall: [] },
            };

            assert.strictEqual(result.environmentCreated, false);
            assert.strictEqual(result.packagesInstalled, false);
            assert.strictEqual(result.environment, undefined);
            assert.strictEqual(result.environmentCreationError, envError);
            assert.strictEqual(result.packageInstallationError, undefined);
        });

        test('should handle case with no packages to install', () => {
            const result: CreateEnvironmentResult = {
                environment: undefined, // Mock environment would go here
                environmentCreated: true,
                packagesInstalled: true, // No packages means "successful"
            };

            assert.strictEqual(result.environmentCreated, true);
            assert.strictEqual(result.packagesInstalled, true);
            assert.strictEqual(result.attemptedPackages, undefined);
        });
    });
});