// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import {
    EnvironmentManager,
    isCreateEnvironmentOptionNotSupportedError,
    PythonEnvironment,
} from '../../../api';
import { InternalEnvironmentManager } from '../../../managers/common/registeredManagers';
import { EnvironmentCapability, supportedCapability, unsupportedCapability } from '../../../capabilities';
import { allSupportedEnvironmentCapabilities } from '../../capabilityFixtures';

function createManager(
    create: sinon.SinonStub,
    customName?: boolean,
): InternalEnvironmentManager {
    return new InternalEnvironmentManager('example:manager', {
        name: 'manager',
        preferredPackageManagerId: 'example:pip',
        capabilities:
            customName === undefined
                ? undefined
                : {
                      ...allSupportedEnvironmentCapabilities,
                      [EnvironmentCapability.CreateNamed]: customName ? supportedCapability : unsupportedCapability,
                  },
        create,
    } as unknown as EnvironmentManager);
}

suite('InternalEnvironmentManager.create', () => {
    test('forwards names when the manager advertises custom-name support', async () => {
        const environment = {} as PythonEnvironment;
        const create = sinon.stub().resolves(environment);
        const manager = createManager(create, true);
        const scope = Uri.file('workspace');
        const options = { name: 'analysis-env' };

        assert.strictEqual(await manager.create(scope, options), environment);
        assert.ok(create.calledOnceWithExactly(scope, options));
    });

    test('rejects names when the capability is false or omitted', async () => {
        for (const customName of [false, undefined]) {
            const create = sinon.stub();
            const manager = createManager(create, customName);

            await assert.rejects(
                manager.create(Uri.file('workspace'), { name: 'analysis-env' }),
                isCreateEnvironmentOptionNotSupportedError,
            );
            assert.ok(create.notCalled);
        }
    });

    test('preserves unnamed creation for managers without the capability', async () => {
        const environment = {} as PythonEnvironment;
        const create = sinon.stub().resolves(environment);
        const manager = createManager(create);
        const scope = Uri.file('workspace');

        assert.strictEqual(await manager.create(scope, undefined), environment);
        assert.ok(create.calledOnceWithExactly(scope, undefined));
    });

    test('passes the scope to contextual named-creation checks and propagates probe failures', async () => {
        const create = sinon.stub().resolves(undefined);
        const scope = Uri.file('workspace');
        const check = sinon.stub().resolves({ supported: true });
        const manager = new InternalEnvironmentManager('example:manager', {
            name: 'manager',
            preferredPackageManagerId: 'example:pip',
            refresh: async () => {},
            getEnvironments: async () => [],
            get: async () => undefined,
            set: async () => {},
            resolve: async () => undefined,
            create,
            capabilities: { ...allSupportedEnvironmentCapabilities, [EnvironmentCapability.CreateNamed]: check },
        });
        await manager.create(scope, { name: 'analysis-env' });
        assert.ok(check.calledOnceWithExactly({ scope }));

        const failure = new Error('Capability probe failed');
        check.rejects(failure);
        create.resetHistory();
        await assert.rejects(manager.create(scope, { name: 'analysis-env' }), (error) => error === failure);
        assert.ok(create.notCalled);
    });
});
