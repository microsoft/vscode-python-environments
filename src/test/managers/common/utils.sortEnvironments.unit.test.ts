import assert from 'node:assert';
import path from 'node:path';
import { sortEnvironments } from '../../../managers/common/utils';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

suite('sortEnvironments', () => {
    test('sorts normalized PET versions in descending order', () => {
        const versions = ['3.9.6.final.0', '3.14.3.final.0', '3.11.9.final.0'];
        const environments = versions.map((version) =>
            createMockPythonEnvironment({ envPath: path.join('python', version), version }),
        );

        assert.deepStrictEqual(
            sortEnvironments(environments).map((environment) => environment.version),
            ['3.14.3.final.0', '3.11.9.final.0', '3.9.6.final.0'],
        );
    });

    test('sorts final releases before prereleases', () => {
        const versions = ['3.14.0b2', '3.14.0', '3.14.0rc1', '3.14.0a1'];
        const environments = versions.map((version) =>
            createMockPythonEnvironment({ envPath: path.join('python', version), version }),
        );

        assert.deepStrictEqual(
            sortEnvironments(environments).map((environment) => environment.version),
            ['3.14.0', '3.14.0rc1', '3.14.0b2', '3.14.0a1'],
        );
    });

    test('sorts valid versions before invalid versions', () => {
        const invalid = createMockPythonEnvironment({
            name: 'invalid',
            envPath: path.join('python', 'invalid'),
            version: 'unknown',
        });
        const valid = createMockPythonEnvironment({
            name: 'valid',
            envPath: path.join('python', 'valid'),
            version: '3.14.3',
        });

        assert.deepStrictEqual(sortEnvironments([invalid, valid]), [valid, invalid]);
    });

    test('sorts errored environments after usable environments regardless of version', () => {
        const usable = createMockPythonEnvironment({ envPath: path.join('python', 'usable'), version: '3.9.6' });
        const errored = {
            ...createMockPythonEnvironment({ envPath: path.join('python', 'errored'), version: '3.14.3' }),
            error: 'Broken interpreter',
        };

        assert.deepStrictEqual(sortEnvironments([errored, usable]), [usable, errored]);
    });
});
