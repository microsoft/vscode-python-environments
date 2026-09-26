import assert from 'node:assert';
import path from 'node:path';
import { sortEnvironments } from '../../../managers/common/utils';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

function permutations<T>(items: T[]): T[][] {
    if (items.length <= 1) {
        return [items];
    }
    const result: T[][] = [];
    items.forEach((item, index) => {
        const rest = [...items.slice(0, index), ...items.slice(index + 1)];
        permutations(rest).forEach((p) => result.push([item, ...p]));
    });
    return result;
}

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

    test('places environments without a version after those with one', () => {
        const versions = ['', '3.12.0', '3.14.7'];
        const environments = versions.map((version, index) =>
            createMockPythonEnvironment({ envPath: path.join('python', String(index)), version }),
        );

        assert.deepStrictEqual(
            sortEnvironments(environments).map((environment) => environment.version),
            ['3.14.7', '3.12.0', ''],
        );
    });

    test('sorts the same environments the same way regardless of discovery order', () => {
        // Include unknown versions and equivalent PET/compact versions so that name and
        // path tie breakers remain consistent with PythonVersion comparison.
        const environments = [
            { name: 'base', version: '3.13.13', directory: 'base' },
            { name: 'odd', version: 'unknown', directory: 'odd' },
            { name: 'nopy', version: '', directory: 'nopy' },
            { name: 'lh', version: '3.14.7', directory: 'lh' },
            { name: 'lh', version: '3.14.7.final.0', directory: 'lh-pet' },
        ].map(({ name, version, directory }) =>
            createMockPythonEnvironment({ name, envPath: path.join('python', directory), version }),
        );
        const expected = [environments[3], environments[4], environments[0], environments[2], environments[1]];

        for (const permutation of permutations(environments)) {
            assert.deepStrictEqual(sortEnvironments(permutation), expected);
        }
    });
});
