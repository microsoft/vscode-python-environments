import * as assert from 'assert';
import * as sinon from 'sinon';
import { InternalEnvironmentManager } from '../../../internal.api';

suite('EnvManagerView Logic Tests', () => {
    test('All managers should have refresh method', () => {
        // Create pipenv manager
        const pipenvManager = new InternalEnvironmentManager('pipenv-manager', {
            name: 'pipenv',
            displayName: 'Pipenv',
            description: 'Pipenv environment manager',
            preferredPackageManagerId: 'pip',
            refresh: () => Promise.resolve(),
            getEnvironments: () => Promise.resolve([]),
            resolve: () => Promise.resolve(undefined),
            set: () => Promise.resolve(),
            get: () => Promise.resolve(undefined),
        });

        // Create other manager
        const condaManager = new InternalEnvironmentManager('conda-manager', {
            name: 'conda',
            displayName: 'Conda',
            description: 'Conda environment manager',
            preferredPackageManagerId: 'conda',
            refresh: () => Promise.resolve(),
            getEnvironments: () => Promise.resolve([]),
            resolve: () => Promise.resolve(undefined),
            set: () => Promise.resolve(),
            get: () => Promise.resolve(undefined),
        });

        // Test that both managers have the required properties
        assert.strictEqual(pipenvManager.name, 'pipenv');
        assert.strictEqual(condaManager.name, 'conda');
        assert.ok(typeof pipenvManager.refresh === 'function');
        assert.ok(typeof condaManager.refresh === 'function');
    });

    test('Refresh method exists on any manager and can be called', async () => {
        const refreshSpy = sinon.spy();
        
        const manager = new InternalEnvironmentManager('test-manager', {
            name: 'any-manager',
            displayName: 'Any Manager',
            description: 'Test manager',
            preferredPackageManagerId: 'pip',
            refresh: refreshSpy,
            getEnvironments: () => Promise.resolve([]),
            resolve: () => Promise.resolve(undefined),
            set: () => Promise.resolve(),
            get: () => Promise.resolve(undefined),
        });

        // Call refresh method
        await manager.refresh(undefined);

        // Verify spy was called
        assert.strictEqual(refreshSpy.calledOnce, true);
        assert.strictEqual(refreshSpy.calledWith(undefined), true);
    });
});