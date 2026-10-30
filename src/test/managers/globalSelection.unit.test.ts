// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi } from '../../api';
import { NativePythonFinder } from '../../managers/common/nativePythonFinder';
import { PoetryManager } from '../../managers/poetry/poetryManager';
import * as poetryUtils from '../../managers/poetry/poetryUtils';
import { PyEnvManager } from '../../managers/pyenv/pyenvManager';
import * as pyenvUtils from '../../managers/pyenv/pyenvUtils';

interface GlobalSelectionManager {
    set(scope: undefined, environment?: PythonEnvironment): Promise<void>;
    get(scope: undefined): Promise<PythonEnvironment | undefined>;
    initialize(): Promise<void>;
}

suite('Global selection is returned by get()', () => {
    let sandbox: sinon.SinonSandbox;

    const api = {
        getPythonProject: () => undefined,
        getPythonProjects: () => [],
    } as unknown as PythonEnvironmentApi;
    const nativeFinder = {
        resolve: sinon.stub(),
        refresh: sinon.stub().resolves([]),
    } as unknown as NativePythonFinder;

    function makeEnv(managerId: string): PythonEnvironment {
        const envPath = path.resolve('global-selection', managerId, 'python');
        return {
            envId: { id: `${managerId}-312`, managerId },
            name: 'Python 3.12',
            displayName: 'Python 3.12',
            version: '3.12.4',
            displayPath: envPath,
            environmentPath: Uri.file(envPath),
            sysPrefix: path.dirname(envPath),
            execInfo: { run: { executable: envPath } },
        };
    }

    const cases: { name: string; create: () => GlobalSelectionManager }[] = [
        {
            name: 'PyEnvManager',
            create: () => {
                sandbox.stub(pyenvUtils, 'setPyenvForGlobal').resolves();
                return new PyEnvManager(nativeFinder, api);
            },
        },
        {
            name: 'PoetryManager',
            create: () => {
                sandbox.stub(poetryUtils, 'setPoetryForGlobal').resolves();
                return new PoetryManager(nativeFinder, api);
            },
        },
    ];

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    for (const { name, create } of cases) {
        test(`${name}: set(undefined, env) is returned by get(undefined)`, async () => {
            const manager = create();
            sandbox.stub(manager, 'initialize').resolves();
            const environment = makeEnv(name);

            await manager.set(undefined, environment);

            assert.strictEqual(await manager.get(undefined), environment);
        });

        test(`${name}: set(undefined) clears the global selection`, async () => {
            const manager = create();
            sandbox.stub(manager, 'initialize').resolves();
            await manager.set(undefined, makeEnv(name));

            await manager.set(undefined, undefined);

            assert.strictEqual(await manager.get(undefined), undefined);
        });
    }
});
