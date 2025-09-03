import * as assert from 'assert';
import * as sinon from 'sinon';
import { InternalEnvironmentManager } from '../../../internal.api';

suite('EnvManagerView Logic Tests', () => {
    test('Pipenv manager should be identified by name', () => {
        // Create pipenv manager with correct name
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

        // Create other manager with different name
        const otherManager = new InternalEnvironmentManager('other-manager', {
            name: 'other',
            displayName: 'Other',
            description: 'Other environment manager',
            preferredPackageManagerId: 'pip',
            refresh: () => Promise.resolve(),
            getEnvironments: () => Promise.resolve([]),
            resolve: () => Promise.resolve(undefined),
            set: () => Promise.resolve(),
            get: () => Promise.resolve(undefined),
        });

        // Test that pipenv manager is correctly identified
        assert.strictEqual(pipenvManager.name, 'pipenv');
        assert.strictEqual(otherManager.name, 'other');
    });

    test('Refresh method exists on manager and can be called', async () => {
        const refreshSpy = sinon.spy();
        
        const manager = new InternalEnvironmentManager('test-manager', {
            name: 'pipenv',
            displayName: 'Pipenv',
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