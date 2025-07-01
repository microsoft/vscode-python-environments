import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import { PythonEnvironment } from '../../../api';
import { resolveSitePackagesPath, isSitePackagesDirectory } from '../../../features/packageWatcher/sitePackagesUtils';

suite('Site-Packages Utils', () => {
    let tempDir: string;

    setup(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sitepackages-test-'));
    });

    teardown(async () => {
        await fs.remove(tempDir);
    });

    suite('resolveSitePackagesPath', () => {
        test('should return undefined for environment without sysPrefix', async () => {
            const mockEnv = {
                sysPrefix: '',
                displayName: 'Test Environment',
            } as PythonEnvironment;

            const result = await resolveSitePackagesPath(mockEnv);
            assert.equal(result, undefined);
        });

        test('should find Windows site-packages path', async () => {
            const mockSysPrefix = path.join(tempDir, 'python-env');
            const sitePackagesPath = path.join(mockSysPrefix, 'Lib', 'site-packages');
            
            // Create the directory structure
            await fs.ensureDir(sitePackagesPath);
            
            const mockEnv = {
                sysPrefix: mockSysPrefix,
                displayName: 'Test Environment',
            } as PythonEnvironment;

            // Mock Windows platform
            const originalPlatform = process.platform;
            Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

            try {
                const result = await resolveSitePackagesPath(mockEnv);
                assert.notEqual(result, undefined);
                assert.equal(result?.fsPath, sitePackagesPath);
            } finally {
                Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
            }
        });

        test('should find Unix site-packages path', async () => {
            const mockSysPrefix = path.join(tempDir, 'python-env');
            const sitePackagesPath = path.join(mockSysPrefix, 'lib', 'python3.10', 'site-packages');
            
            // Create the directory structure
            await fs.ensureDir(sitePackagesPath);
            
            const mockEnv = {
                sysPrefix: mockSysPrefix,
                displayName: 'Test Environment',
            } as PythonEnvironment;

            // Mock Unix platform
            const originalPlatform = process.platform;
            Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

            try {
                const result = await resolveSitePackagesPath(mockEnv);
                assert.notEqual(result, undefined);
                assert.equal(result?.fsPath, sitePackagesPath);
            } finally {
                Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
            }
        });

        test('should return undefined when no site-packages directory exists', async () => {
            const mockSysPrefix = path.join(tempDir, 'nonexistent-env');
            
            const mockEnv = {
                sysPrefix: mockSysPrefix,
                displayName: 'Test Environment',
            } as PythonEnvironment;

            const result = await resolveSitePackagesPath(mockEnv);
            assert.equal(result, undefined);
        });
    });

    suite('isSitePackagesDirectory', () => {
        test('should return false for non-existent path', async () => {
            const nonExistentPath = path.join(tempDir, 'nonexistent');
            const result = await isSitePackagesDirectory(nonExistentPath);
            assert.equal(result, false);
        });

        test('should return false for file instead of directory', async () => {
            const filePath = path.join(tempDir, 'testfile.txt');
            await fs.writeFile(filePath, 'test content');
            
            const result = await isSitePackagesDirectory(filePath);
            assert.equal(result, false);
        });

        test('should return true for directory with pip marker', async () => {
            const sitePackagesPath = path.join(tempDir, 'site-packages');
            const pipPath = path.join(sitePackagesPath, 'pip');
            
            await fs.ensureDir(pipPath);
            
            const result = await isSitePackagesDirectory(sitePackagesPath);
            assert.equal(result, true);
        });

        test('should return true for directory with setuptools marker', async () => {
            const sitePackagesPath = path.join(tempDir, 'site-packages');
            const setuptoolsPath = path.join(sitePackagesPath, 'setuptools');
            
            await fs.ensureDir(setuptoolsPath);
            
            const result = await isSitePackagesDirectory(sitePackagesPath);
            assert.equal(result, true);
        });

        test('should return true for directory with __pycache__ marker', async () => {
            const sitePackagesPath = path.join(tempDir, 'site-packages');
            const pycachePath = path.join(sitePackagesPath, '__pycache__');
            
            await fs.ensureDir(pycachePath);
            
            const result = await isSitePackagesDirectory(sitePackagesPath);
            assert.equal(result, true);
        });

        test('should return true for non-empty directory even without markers', async () => {
            const sitePackagesPath = path.join(tempDir, 'site-packages');
            const somePackagePath = path.join(sitePackagesPath, 'some-package');
            
            await fs.ensureDir(somePackagePath);
            
            const result = await isSitePackagesDirectory(sitePackagesPath);
            assert.equal(result, true);
        });

        test('should return false for empty directory', async () => {
            const emptyPath = path.join(tempDir, 'empty-dir');
            await fs.ensureDir(emptyPath);
            
            const result = await isSitePackagesDirectory(emptyPath);
            assert.equal(result, false);
        });
    });
});