/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'assert';
import * as sinon from 'sinon';
import { PythonEnvironment, PythonEnvironmentApi } from '../../../api';
import { isWindows } from '../../../common/utils/platformUtils';
import { CondaEnvManager } from '../../../managers/conda/condaEnvManager';
import { NativePythonFinder } from '../.././../managers/common/nativePythonFinder';
import { makeMockCondaEnvironment as makeEnv } from '../../mocks/pythonEnvironment';

/**
 * Creates a CondaEnvManager with a given collection, bypassing initialization.
 */
function createManagerWithCollection(collection: PythonEnvironment[]): CondaEnvManager {
    const manager = new CondaEnvManager(
        {} as NativePythonFinder,
        {} as PythonEnvironmentApi,
        { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() } as any,
    );
    (manager as any).collection = collection;
    return manager;
}

/**
 * Calls the private findEnvironmentByPath method on the manager.
 */
function findByPath(manager: CondaEnvManager, fsPath: string): PythonEnvironment | undefined {
    return (manager as any).findEnvironmentByPath(fsPath);
}

suite('CondaEnvManager - findEnvironmentByPath', () => {
    teardown(() => {
        sinon.restore();
    });

    // --- Core bug fix: base vs named env collision ---

    test('Exact match on base prefix returns base, not a named env with higher version', () => {
        // This is the core bug scenario from issue #25814.
        // Named envs under /miniconda3/envs/<name> have grandparent /miniconda3,
        // same as base's own path. With version-sorted collection, a named env
        // with a higher Python version would appear first and incorrectly match.
        const base = makeEnv('base', '/home/user/miniconda3', '3.12.0');
        const namedHigher = makeEnv('torch', '/home/user/miniconda3/envs/torch', '3.13.0');

        // Collection sorted by version descending (torch first, higher version)
        const manager = createManagerWithCollection([namedHigher, base]);

        const result = findByPath(manager, '/home/user/miniconda3');
        assert.strictEqual(result, base, 'Should return base env via exact match, not torch via grandparent');
    });

    test('Exact match on base prefix works with many named envs of varying versions', () => {
        const base = makeEnv('base', '/home/user/miniconda3', '3.11.0');
        const envA = makeEnv('alpha', '/home/user/miniconda3/envs/alpha', '3.13.0');
        const envB = makeEnv('beta', '/home/user/miniconda3/envs/beta', '3.12.0');
        const envC = makeEnv('gamma', '/home/user/miniconda3/envs/gamma', '3.10.0');

        // Sorted by version descending: alpha(3.13), beta(3.12), base(3.11), gamma(3.10)
        const manager = createManagerWithCollection([envA, envB, base, envC]);

        const result = findByPath(manager, '/home/user/miniconda3');
        assert.strictEqual(result, base, 'Should return base even when multiple named envs have higher versions');
    });

    // --- Standard exact match cases ---

    test('Exact match returns the correct named environment', () => {
        const base = makeEnv('base', '/home/user/miniconda3', '3.12.0');
        const myenv = makeEnv('myenv', '/home/user/miniconda3/envs/myenv', '3.11.0');

        const manager = createManagerWithCollection([base, myenv]);

        const result = findByPath(manager, '/home/user/miniconda3/envs/myenv');
        assert.strictEqual(result, myenv);
    });

    test('Exact match returns correct env when path is a prefix env outside envs dir', () => {
        const prefixEnv = makeEnv('project', '/home/user/projects/myproject/.conda', '3.12.0');
        const manager = createManagerWithCollection([prefixEnv]);

        const result = findByPath(manager, '/home/user/projects/myproject/.conda');
        assert.strictEqual(result, prefixEnv);
    });

    // --- Parent directory match (one level up) ---

    test('Parent dir match resolves executable path to env (bin/ inside env)', () => {
        // When given a path like /miniconda3/envs/myenv/bin, dirname of the env
        // is /miniconda3/envs/myenv and the path is /miniconda3/envs/myenv/bin,
        // so parent match: dirname(envPath) matches the lookup path won't work here.
        // Actually parent match means: dirname(environmentPath) === lookupPath.
        // For bin match, we'd pass /miniconda3/envs/myenv/bin and
        // dirname(/miniconda3/envs/myenv) = /miniconda3/envs ≠ /miniconda3/envs/myenv/bin
        // So this case uses grandparent. Let me test a real parent scenario:
        // If we have env at /miniconda3/envs/myenv/python (subdir) and look up /miniconda3/envs/myenv
        const env = makeEnv('myenv', '/home/user/miniconda3/envs/myenv/python', '3.12.0');
        const manager = createManagerWithCollection([env]);

        // dirname(/miniconda3/envs/myenv/python) = /miniconda3/envs/myenv
        const result = findByPath(manager, '/home/user/miniconda3/envs/myenv');
        assert.strictEqual(result, env, 'Should match via parent directory');
    });

    // --- Grandparent directory match (two levels up) ---

    test('Grandparent dir match resolves executable path to env (bin/python inside env)', () => {
        // environmentPath = /miniconda3/envs/myenv/bin/python
        // dirname(dirname(path)) = /miniconda3/envs/myenv
        //
        // This is the typical case where environmentPath points to the Python binary
        // and we look up the environment prefix.
        const env = makeEnv('myenv', '/home/user/miniconda3/envs/myenv/bin/python', '3.12.0');
        const manager = createManagerWithCollection([env]);

        const result = findByPath(manager, '/home/user/miniconda3/envs/myenv');
        assert.strictEqual(result, env, 'Should match via grandparent directory');
    });

    // --- No match ---

    test('Returns undefined when no environment matches', () => {
        const base = makeEnv('base', '/home/user/miniconda3', '3.12.0');
        const manager = createManagerWithCollection([base]);

        const result = findByPath(manager, '/opt/other/path');
        assert.strictEqual(result, undefined);
    });

    test('Returns undefined for empty collection', () => {
        const manager = createManagerWithCollection([]);
        const result = findByPath(manager, '/home/user/miniconda3');
        assert.strictEqual(result, undefined);
    });

    // --- Priority: exact over parent, parent over grandparent ---

    test('Exact match takes priority over parent match of a different env', () => {
        // envA is at /a/b/c and envB is at /a/b/c/sub
        // Looking up /a/b/c should return envA (exact), not envB (parent)
        const envA = makeEnv('envA', '/a/b/c', '3.12.0');
        const envB = makeEnv('envB', '/a/b/c/sub', '3.12.0');
        const manager = createManagerWithCollection([envB, envA]); // envB first in iteration

        const result = findByPath(manager, '/a/b/c');
        assert.strictEqual(result, envA, 'Exact match should win over parent match');
    });

    test('Exact match takes priority over grandparent match of a different env', () => {
        const envA = makeEnv('envA', '/a/b', '3.12.0');
        const envB = makeEnv('envB', '/a/b/c/d', '3.13.0');
        const manager = createManagerWithCollection([envB, envA]); // envB first (higher version)

        // dirname(dirname(/a/b/c/d)) = /a/b which also matches envA exactly
        const result = findByPath(manager, '/a/b');
        assert.strictEqual(result, envA, 'Exact match should win over grandparent match');
    });

    // --- Windows-style paths ---
    // Uri.file() lowercases drive letters on non-Windows, causing path mismatches
    // with normalizePath which only lowercases on Windows. Skip on Linux/macOS.

    (isWindows() ? test : test.skip)('Works with Windows-style backslash paths', () => {
        const base = makeEnv('base', 'C:\\Users\\user\\miniconda3', '3.12.0');
        const named = makeEnv('torch', 'C:\\Users\\user\\miniconda3\\envs\\torch', '3.13.0');

        const manager = createManagerWithCollection([named, base]);

        const result = findByPath(manager, 'C:\\Users\\user\\miniconda3');
        assert.strictEqual(result, base, 'Should return base on Windows paths');
    });

    (isWindows() ? test : test.skip)('Windows: exact match on named env path', () => {
        const base = makeEnv('base', 'C:\\Users\\user\\miniconda3', '3.12.0');
        const named = makeEnv('myenv', 'C:\\Users\\user\\miniconda3\\envs\\myenv', '3.11.0');

        const manager = createManagerWithCollection([base, named]);

        const result = findByPath(manager, 'C:\\Users\\user\\miniconda3\\envs\\myenv');
        assert.strictEqual(result, named);
    });

    // --- Edge: base is the only env ---

    test('Base as only env is found via exact match', () => {
        const base = makeEnv('base', '/home/user/miniconda3', '3.12.0');
        const manager = createManagerWithCollection([base]);

        const result = findByPath(manager, '/home/user/miniconda3');
        assert.strictEqual(result, base);
    });

    // --- Edge: multiple envs with same version (alphabetical sort) ---

    test('Works when base and named env have the same Python version', () => {
        const base = makeEnv('base', '/home/user/miniconda3', '3.12.0');
        const named = makeEnv('aaa', '/home/user/miniconda3/envs/aaa', '3.12.0');

        // Same version, 'aaa' sorts before 'base' alphabetically
        const manager = createManagerWithCollection([named, base]);

        const result = findByPath(manager, '/home/user/miniconda3');
        assert.strictEqual(result, base, 'Should return base even when named env sorts first alphabetically');
    });

    // --- Edge: prefix env inside workspace (not under envs/) ---

    test('Prefix env inside workspace does not collide with base', () => {
        const base = makeEnv('base', '/home/user/miniconda3', '3.13.0');
        const prefixEnv = makeEnv('.conda', '/home/user/project/.conda', '3.12.0');

        const manager = createManagerWithCollection([base, prefixEnv]);

        const result = findByPath(manager, '/home/user/project/.conda');
        assert.strictEqual(result, prefixEnv);
    });

    // --- Edge: deeply nested path that doesn't match anything ---

    test('Path that only matches at 3+ levels up does not match', () => {
        // environmentPath = /a/b/c/d/e, looking up /a/b
        // dirname = /a/b/c/d, grandparent = /a/b/c — neither matches /a/b
        const env = makeEnv('deep', '/a/b/c/d/e', '3.12.0');
        const manager = createManagerWithCollection([env]);

        const result = findByPath(manager, '/a/b');
        assert.strictEqual(result, undefined, 'Should not match beyond grandparent');
    });

    // --- Edge: trailing separator normalization ---

    test('Fallback still works when no exact match exists', () => {
        // An env whose environmentPath is a binary path, not a prefix
        const env = makeEnv('myenv', '/home/user/miniconda3/envs/myenv/bin/python3', '3.12.0');
        const manager = createManagerWithCollection([env]);

        // Looking up the prefix — should find it via grandparent
        const result = findByPath(manager, '/home/user/miniconda3/envs/myenv');
        assert.strictEqual(result, env);
    });
});
