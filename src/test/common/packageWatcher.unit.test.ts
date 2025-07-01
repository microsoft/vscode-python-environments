import { describe, it } from 'mocha';
import assert from 'node:assert';
import * as sinon from 'sinon';
import * as os from 'os';
import * as path from 'path';
import { getSitePackagesPath, PackageWatcherService } from '../../../src/common/packageWatcher';
import { PythonEnvironment, PackageManager, PythonEnvironmentId } from '../../../src/api';

describe('Package Watcher Service', () => {
    describe('getSitePackagesPath', () => {
        let osStub: sinon.SinonStub;

        afterEach(() => {
            if (osStub) {
                osStub.restore();
            }
        });

        it('should return Windows site-packages path', () => {
            osStub = sinon.stub(os, 'platform').returns('win32');
            
            const mockEnv: PythonEnvironment = {
                envId: { id: 'test', managerId: 'test' } as PythonEnvironmentId,
                sysPrefix: 'C:\\Python39',
            } as PythonEnvironment;

            const result = getSitePackagesPath(mockEnv);
            assert.strictEqual(result, path.join('C:\\Python39', 'Lib', 'site-packages'));
        });

        it('should return Unix site-packages path pattern', () => {
            osStub = sinon.stub(os, 'platform').returns('linux');
            
            const mockEnv: PythonEnvironment = {
                envId: { id: 'test', managerId: 'test' } as PythonEnvironmentId,
                sysPrefix: '/usr/local/python3.9',
            } as PythonEnvironment;

            const result = getSitePackagesPath(mockEnv);
            assert.strictEqual(result, path.join('/usr/local/python3.9', 'lib', 'python*', 'site-packages'));
        });

        it('should return undefined when sysPrefix is missing', () => {
            const mockEnv: PythonEnvironment = {
                envId: { id: 'test', managerId: 'test' } as PythonEnvironmentId,
                sysPrefix: '',
            } as PythonEnvironment;

            const result = getSitePackagesPath(mockEnv);
            assert.strictEqual(result, undefined);
        });
    });

    describe('PackageWatcherService', () => {
        let service: PackageWatcherService;
        let mockEnv: PythonEnvironment;
        let mockManager: PackageManager;

        beforeEach(() => {
            service = new PackageWatcherService();
            mockEnv = {
                envId: { id: 'test-env', managerId: 'test-manager' } as PythonEnvironmentId,
                sysPrefix: '/test/python',
            } as PythonEnvironment;
            
            mockManager = {
                name: 'test-manager',
                refresh: sinon.stub().resolves(),
            } as unknown as PackageManager;
        });

        afterEach(() => {
            service.dispose();
        });

        it('should return empty disposable when sysPrefix cannot be resolved', () => {
            const envWithoutPrefix: PythonEnvironment = {
                envId: { id: 'test-env', managerId: 'test-manager' } as PythonEnvironmentId,
                sysPrefix: '',
            } as PythonEnvironment;

            const disposable = service.watchEnvironment(envWithoutPrefix, mockManager);
            expect(disposable).to.not.be.undefined;
            
            // Should not throw when disposed
            disposable.dispose();
        });

        it('should create watcher for valid environment', () => {
            const disposable = service.watchEnvironment(mockEnv, mockManager);
            expect(disposable).to.not.be.undefined;
            
            // Should not throw when disposed
            disposable.dispose();
        });

        it('should dispose all watchers when service is disposed', () => {
            const disposable1 = service.watchEnvironment(mockEnv, mockManager);
            const disposable2 = service.watchEnvironment(mockEnv, mockManager);
            
            // Should not throw
            service.dispose();
            
            // Subsequent disposals should not throw
            disposable1.dispose();
            disposable2.dispose();
        });
    });
});