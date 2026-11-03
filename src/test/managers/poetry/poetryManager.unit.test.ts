import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import type { PythonEnvironment, PythonEnvironmentApi } from '../../../api';
import type { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { PoetryManager } from '../../../managers/poetry/poetryManager';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

suite('PoetryManager', () => {
    teardown(() => {
        sinon.restore();
    });

    test('does not classify Poetry virtual environments as global environments', async () => {
        const environment = createMockPythonEnvironment({
            envPath: path.join(process.cwd(), 'poetry-environment'),
            managerId: 'ms-python.python:poetry',
        });
        const manager = new PoetryManager({} as NativePythonFinder, {} as PythonEnvironmentApi);
        sinon.stub(manager, 'initialize').resolves();
        (manager as unknown as { collection: PythonEnvironment[] }).collection = [environment];

        assert.deepStrictEqual(await manager.getEnvironments('all'), [environment]);
        assert.deepStrictEqual(await manager.getEnvironments('global'), []);

        manager.dispose();
    });
});