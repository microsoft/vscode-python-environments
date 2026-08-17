import assert from 'assert';
import { PythonEnvironment } from '../../../api';
import { getLatest, sortEnvironments } from '../../../managers/common/utils';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

function env(name: string, version: string): PythonEnvironment {
    return createMockPythonEnvironment({ name, envPath: `/envs/${name}`, version });
}

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
    test('orders environments with a known version descending', () => {
        const sorted = sortEnvironments([env('a', '3.12.0'), env('b', '3.14.7'), env('c', '3.13.13')]);

        assert.deepStrictEqual(
            sorted.map((e) => e.name),
            ['b', 'c', 'a'],
        );
    });

    test('places environments without a version after those with one', () => {
        const sorted = sortEnvironments([env('nopy', ''), env('a', '3.12.0'), env('b', '3.14.7')]);

        assert.deepStrictEqual(
            sorted.map((e) => e.name),
            ['b', 'a', 'nopy'],
        );
    });

    test('sorts the same environments the same way regardless of discovery order', () => {
        // `version` is a plain string on the public API, so a manager can surface a value that
        // is neither empty nor parseable as PEP 440. Comparing such a value against a real
        // version has to stay antisymmetric: otherwise `Array.prototype.sort` is free to
        // return an implementation-defined permutation, and the list shuffles depending on the
        // order the environments happened to be discovered in.
        const envs = [env('base', '3.13.13'), env('odd', 'unknown'), env('git', '3.14.6'), env('lh', '3.14.7')];

        const orders = new Set(
            permutations(envs).map((p) =>
                sortEnvironments([...p])
                    .map((e) => e.name)
                    .join(','),
            ),
        );

        assert.strictEqual(orders.size, 1, `expected one stable order, got: ${[...orders].join(' | ')}`);
    });
});

suite('getLatest', () => {
    test('returns the newest environment even when the first candidate has no version', () => {
        const latest = getLatest([env('nopy', ''), env('base', '3.13.13'), env('lh', '3.14.7')]);

        assert.strictEqual(latest?.name, 'lh');
    });
});
