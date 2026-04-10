import assert from 'node:assert';
import { Uri } from 'vscode';
import {
    buildFindCliArgs,
    ConfigurationOptions,
    NativeEnvInfo,
    NativeEnvManagerInfo,
    NativePythonEnvironmentKind,
    parseRefreshCliOutput,
    parseResolveCliOutput,
} from '../../../managers/common/nativePythonFinder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<ConfigurationOptions> = {}): ConfigurationOptions {
    return {
        workspaceDirectories: [],
        environmentDirectories: [],
        condaExecutable: undefined,
        pipenvExecutable: undefined,
        poetryExecutable: undefined,
        cacheDirectory: undefined,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// buildFindCliArgs — no options (search everything)
// ---------------------------------------------------------------------------

suite('buildFindCliArgs — no options', () => {
    test('starts with ["find", "--json"]', () => {
        const args = buildFindCliArgs(makeConfig());
        assert.ok(args[0] === 'find' && args[1] === '--json', `Expected ["find","--json"], got [${args.slice(0, 2)}]`);
    });

    test('includes workspace directories as positional args', () => {
        const config = makeConfig({ workspaceDirectories: ['/home/user/project', '/home/user/other'] });
        const args = buildFindCliArgs(config);
        assert.ok(args.includes('/home/user/project'), 'Should include first workspace dir');
        assert.ok(args.includes('/home/user/other'), 'Should include second workspace dir');
    });

    test('does NOT include --kind flag', () => {
        const args = buildFindCliArgs(makeConfig({ workspaceDirectories: ['/mydir'] }));
        assert.ok(!args.includes('--kind'), 'Should not include --kind');
    });

    test('produces only ["find","--json"] when all config fields are empty', () => {
        const args = buildFindCliArgs(makeConfig());
        assert.deepStrictEqual(args, ['find', '--json']);
    });
});

// ---------------------------------------------------------------------------
// buildFindCliArgs — NativePythonEnvironmentKind (string) options
// ---------------------------------------------------------------------------

suite('buildFindCliArgs — kind filter', () => {
    test('appends --kind with the kind value', () => {
        const args = buildFindCliArgs(makeConfig(), NativePythonEnvironmentKind.conda);
        assert.ok(args.includes('--kind'), 'Should include --kind flag');
        const idx = args.indexOf('--kind');
        assert.strictEqual(args[idx + 1], 'Conda', 'Kind value should be Conda');
    });

    test('includes workspace dirs as positional args when kind is set (mirrors server mode)', () => {
        // In server mode, build_refresh_config keeps the configured workspace dirs when
        // search_kind is set so workspace-scoped envs of that kind (e.g. Venv) are found.
        const config = makeConfig({ workspaceDirectories: ['/mydir', '/otherdir'] });
        const args = buildFindCliArgs(config, NativePythonEnvironmentKind.venv);
        assert.ok(args.includes('/mydir'), 'Should include first workspace dir as positional');
        assert.ok(args.includes('/otherdir'), 'Should include second workspace dir as positional');
    });

    test('does NOT add --workspace flag when kind is set', () => {
        const args = buildFindCliArgs(makeConfig(), NativePythonEnvironmentKind.conda);
        assert.ok(!args.includes('--workspace'), 'Should not include --workspace for kind filter');
    });

    test('works for all kind values (spot check)', () => {
        const kinds: NativePythonEnvironmentKind[] = [
            NativePythonEnvironmentKind.conda,
            NativePythonEnvironmentKind.homebrew,
            NativePythonEnvironmentKind.pipenv,
            NativePythonEnvironmentKind.poetry,
            NativePythonEnvironmentKind.venv,
            NativePythonEnvironmentKind.venvUv,
        ];
        for (const kind of kinds) {
            const args = buildFindCliArgs(makeConfig(), kind);
            const idx = args.indexOf('--kind');
            assert.ok(idx >= 0, `Expected --kind for ${kind}`);
            assert.strictEqual(args[idx + 1], kind, `Expected kind value ${kind}`);
        }
    });
});

// ---------------------------------------------------------------------------
// buildFindCliArgs — Uri[] options
// ---------------------------------------------------------------------------

suite('buildFindCliArgs — Uri[] options', () => {
    test('includes URI fsPaths as positional args', () => {
        const uris = [Uri.file('/project/a'), Uri.file('/project/b')];
        const args = buildFindCliArgs(makeConfig(), uris);
        // Uri.file on Windows will produce backslash paths; compare fsPath
        assert.ok(args.includes(uris[0].fsPath), `Expected ${uris[0].fsPath} in args`);
        assert.ok(args.includes(uris[1].fsPath), `Expected ${uris[1].fsPath} in args`);
    });

    test('adds --workspace flag when Uri[] provided (mirrors server mode workspace-only scan)', () => {
        // In server mode, search_scope = Workspace when searchPaths is set, which skips all
        // global discovery phases. --workspace mirrors that behaviour in the CLI fallback.
        const uris = [Uri.file('/project/a')];
        const args = buildFindCliArgs(makeConfig(), uris);
        assert.ok(args.includes('--workspace'), 'Should include --workspace flag for Uri[] paths');
    });

    test('includes venvFolders as additional positional args', () => {
        const uris = [Uri.file('/project/a')];
        const venvFolders = ['/home/user/.venvs', '/home/user/envs'];
        const args = buildFindCliArgs(makeConfig(), uris, venvFolders);
        assert.ok(args.includes('/home/user/.venvs'), 'Should include first venvFolder');
        assert.ok(args.includes('/home/user/envs'), 'Should include second venvFolder');
    });

    test('does NOT include workspace dirs as positional args when Uri[] provided', () => {
        const config = makeConfig({ workspaceDirectories: ['/workspace'] });
        const uris = [Uri.file('/project')];
        const args = buildFindCliArgs(config, uris);
        assert.ok(!args.includes('/workspace'), 'Workspace dirs should be replaced by URI paths');
    });

    test('does NOT add --kind flag when Uri[] provided', () => {
        const uris = [Uri.file('/project')];
        const args = buildFindCliArgs(makeConfig(), uris);
        assert.ok(!args.includes('--kind'), 'Should not include --kind');
    });

    test('handles empty Uri[] with no venvFolders — only find --json --workspace', () => {
        const args = buildFindCliArgs(makeConfig(), []);
        assert.deepStrictEqual(args, ['find', '--json', '--workspace']);
    });
});

// ---------------------------------------------------------------------------
// buildFindCliArgs — configuration flags
// ---------------------------------------------------------------------------

suite('buildFindCliArgs — configuration flags', () => {
    test('adds --cache-directory when cacheDirectory is set', () => {
        const config = makeConfig({ cacheDirectory: '/tmp/cache' });
        const args = buildFindCliArgs(config);
        const idx = args.indexOf('--cache-directory');
        assert.ok(idx >= 0, 'Should include --cache-directory');
        assert.strictEqual(args[idx + 1], '/tmp/cache');
    });

    test('omits --cache-directory when cacheDirectory is undefined', () => {
        const args = buildFindCliArgs(makeConfig({ cacheDirectory: undefined }));
        assert.ok(!args.includes('--cache-directory'), 'Should not include --cache-directory');
    });

    test('adds --conda-executable when condaExecutable is set', () => {
        const config = makeConfig({ condaExecutable: '/usr/bin/conda' });
        const args = buildFindCliArgs(config);
        const idx = args.indexOf('--conda-executable');
        assert.ok(idx >= 0, 'Should include --conda-executable');
        assert.strictEqual(args[idx + 1], '/usr/bin/conda');
    });

    test('omits --conda-executable when condaExecutable is undefined', () => {
        const args = buildFindCliArgs(makeConfig());
        assert.ok(!args.includes('--conda-executable'), 'Should not include --conda-executable');
    });

    test('adds --pipenv-executable when pipenvExecutable is set', () => {
        const config = makeConfig({ pipenvExecutable: '/home/user/.local/bin/pipenv' });
        const args = buildFindCliArgs(config);
        const idx = args.indexOf('--pipenv-executable');
        assert.ok(idx >= 0, 'Should include --pipenv-executable');
        assert.strictEqual(args[idx + 1], '/home/user/.local/bin/pipenv');
    });

    test('adds --poetry-executable when poetryExecutable is set', () => {
        const config = makeConfig({ poetryExecutable: '/home/user/.local/bin/poetry' });
        const args = buildFindCliArgs(config);
        const idx = args.indexOf('--poetry-executable');
        assert.ok(idx >= 0, 'Should include --poetry-executable');
        assert.strictEqual(args[idx + 1], '/home/user/.local/bin/poetry');
    });

    test('adds --environment-directories as comma-joined string', () => {
        const config = makeConfig({ environmentDirectories: ['/home/.venvs', '/opt/envs'] });
        const args = buildFindCliArgs(config);
        const idx = args.indexOf('--environment-directories');
        assert.ok(idx >= 0, 'Should include --environment-directories');
        assert.strictEqual(args[idx + 1], '/home/.venvs,/opt/envs', 'Dirs should be comma-joined');
    });

    test('omits --environment-directories when array is empty', () => {
        const args = buildFindCliArgs(makeConfig({ environmentDirectories: [] }));
        assert.ok(!args.includes('--environment-directories'), 'Should not include --environment-directories');
    });

    test('includes all config flags together', () => {
        const config = makeConfig({
            workspaceDirectories: ['/workspace'],
            environmentDirectories: ['/envs'],
            condaExecutable: '/conda',
            pipenvExecutable: '/pipenv',
            poetryExecutable: '/poetry',
            cacheDirectory: '/cache',
        });
        const args = buildFindCliArgs(config);
        assert.ok(args.includes('--cache-directory'));
        assert.ok(args.includes('--conda-executable'));
        assert.ok(args.includes('--pipenv-executable'));
        assert.ok(args.includes('--poetry-executable'));
        assert.ok(args.includes('--environment-directories'));
        assert.ok(args.includes('/workspace'), 'Workspace dir should be positional');
    });
});

// ---------------------------------------------------------------------------
// buildFindCliArgs — edge cases
// ---------------------------------------------------------------------------

suite('buildFindCliArgs — edge cases', () => {
    test('paths with spaces are passed as-is (not shell-quoted)', () => {
        const config = makeConfig({ workspaceDirectories: ['/path with spaces/project'] });
        const args = buildFindCliArgs(config);
        // The path should appear as-is without extra quoting — spawnProcess handles quoting
        assert.ok(args.includes('/path with spaces/project'));
    });

    test('environmentDirectories with a single entry produces no comma', () => {
        const config = makeConfig({ environmentDirectories: ['/only-one'] });
        const args = buildFindCliArgs(config);
        const idx = args.indexOf('--environment-directories');
        assert.ok(idx >= 0);
        assert.strictEqual(args[idx + 1], '/only-one');
        assert.ok(!args[idx + 1].includes(','), 'Single entry should not have comma');
    });

    test('venvFolders are not added when options is a kind string', () => {
        const venvFolders = ['/home/.venvs'];
        const args = buildFindCliArgs(makeConfig(), NativePythonEnvironmentKind.conda, venvFolders);
        // venvFolders are only positional args for Uri[], not for kind filters
        assert.ok(!args.includes('/home/.venvs'), 'venvFolders should not be added for kind filter');
    });

    test('venvFolders default to [] when not passed', () => {
        const uris = [Uri.file('/project')];
        // Should not throw even without venvFolders parameter
        const args = buildFindCliArgs(makeConfig(), uris);
        assert.ok(args.includes(uris[0].fsPath));
    });
});

// ---------------------------------------------------------------------------
// parseRefreshCliOutput — plan checklist items 2, 3, 4
// ---------------------------------------------------------------------------

suite('parseRefreshCliOutput — valid JSON', () => {
    const manager: NativeEnvManagerInfo = { tool: 'Conda', executable: '/usr/bin/conda', version: '24.1.0' };
    const env: NativeEnvInfo = {
        executable: '/usr/bin/python3',
        kind: NativePythonEnvironmentKind.linuxGlobal,
        version: '3.12.1',
        prefix: '/usr',
    };

    test('returns managers and environments from well-formed output', () => {
        const stdout = JSON.stringify({ managers: [manager], environments: [env] });
        const result = parseRefreshCliOutput(stdout);
        assert.strictEqual(result.managers.length, 1);
        assert.strictEqual(result.managers[0].tool, 'Conda');
        assert.strictEqual(result.environments.length, 1);
        assert.strictEqual(result.environments[0].executable, '/usr/bin/python3');
    });

    test('returns empty arrays when managers and environments are both absent', () => {
        const result = parseRefreshCliOutput(JSON.stringify({}));
        assert.deepStrictEqual(result.managers, []);
        assert.deepStrictEqual(result.environments, []);
    });

    test('handles explicit empty managers array', () => {
        const stdout = JSON.stringify({ managers: [], environments: [env] });
        const result = parseRefreshCliOutput(stdout);
        assert.strictEqual(result.managers.length, 0);
        assert.strictEqual(result.environments.length, 1);
    });

    test('handles explicit empty environments array', () => {
        const stdout = JSON.stringify({ managers: [manager], environments: [] });
        const result = parseRefreshCliOutput(stdout);
        assert.strictEqual(result.managers.length, 1);
        assert.strictEqual(result.environments.length, 0);
    });

    test('handles both arrays empty', () => {
        const result = parseRefreshCliOutput(JSON.stringify({ managers: [], environments: [] }));
        assert.deepStrictEqual(result.managers, []);
        assert.deepStrictEqual(result.environments, []);
    });

    test('returns multiple environments', () => {
        const env2: NativeEnvInfo = { executable: '/usr/bin/python3.11', version: '3.11.0', prefix: '/usr' };
        const stdout = JSON.stringify({ managers: [], environments: [env, env2] });
        const result = parseRefreshCliOutput(stdout);
        assert.strictEqual(result.environments.length, 2);
    });

    test('preserves all fields on environment objects', () => {
        const richEnv: NativeEnvInfo = {
            displayName: 'Python 3.12',
            executable: '/usr/bin/python3',
            kind: NativePythonEnvironmentKind.linuxGlobal,
            version: '3.12.1',
            prefix: '/usr',
            arch: 'x64',
            symlinks: ['/usr/bin/python3', '/usr/bin/python3.12'],
        };
        const result = parseRefreshCliOutput(JSON.stringify({ managers: [], environments: [richEnv] }));
        const parsed = result.environments[0];
        assert.strictEqual(parsed.displayName, 'Python 3.12');
        assert.deepStrictEqual(parsed.symlinks, ['/usr/bin/python3', '/usr/bin/python3.12']);
        assert.strictEqual(parsed.arch, 'x64');
    });

    test('environments with executable but missing version are returned as-is (incomplete env detection is caller responsibility)', () => {
        const incompleteEnv: NativeEnvInfo = { executable: '/opt/myenv/bin/python' };
        const result = parseRefreshCliOutput(JSON.stringify({ managers: [], environments: [incompleteEnv] }));
        assert.strictEqual(result.environments.length, 1);
        assert.strictEqual(result.environments[0].executable, '/opt/myenv/bin/python');
        assert.strictEqual(result.environments[0].version, undefined);
        assert.strictEqual(result.environments[0].prefix, undefined);
    });
});

suite('parseRefreshCliOutput — error cases', () => {
    test('throws SyntaxError on malformed JSON', () => {
        assert.throws(() => parseRefreshCliOutput('{not valid json'), SyntaxError);
    });

    test('throws SyntaxError on empty string', () => {
        assert.throws(() => parseRefreshCliOutput(''), SyntaxError);
    });

    test('throws SyntaxError on JSON null (not an object)', () => {
        assert.throws(() => parseRefreshCliOutput('null'), SyntaxError);
    });

    test('throws SyntaxError on JSON primitive', () => {
        assert.throws(() => parseRefreshCliOutput('"just a string"'), SyntaxError);
    });
});

// ---------------------------------------------------------------------------
// parseResolveCliOutput — plan checklist items 5, 6, 7
// ---------------------------------------------------------------------------

suite('parseResolveCliOutput — valid JSON', () => {
    const env: NativeEnvInfo = {
        executable: '/home/user/project/.venv/bin/python',
        kind: NativePythonEnvironmentKind.venv,
        version: '3.12.0',
        prefix: '/home/user/project/.venv',
    };

    test('returns NativeEnvInfo from valid environment JSON', () => {
        const result = parseResolveCliOutput(JSON.stringify(env), env.executable!);
        assert.strictEqual(result.executable, env.executable);
        assert.strictEqual(result.version, '3.12.0');
        assert.strictEqual(result.prefix, '/home/user/project/.venv');
    });

    test('preserves all fields', () => {
        const richEnv: NativeEnvInfo = {
            executable: '/home/user/.venv/bin/python',
            kind: NativePythonEnvironmentKind.venv,
            version: '3.11.5',
            prefix: '/home/user/.venv',
            arch: 'x64',
            symlinks: ['/home/user/.venv/bin/python', '/home/user/.venv/bin/python3'],
            name: 'myenv',
        };
        const result = parseResolveCliOutput(JSON.stringify(richEnv), richEnv.executable!);
        assert.strictEqual(result.name, 'myenv');
        assert.deepStrictEqual(result.symlinks, richEnv.symlinks);
        assert.strictEqual(result.arch, 'x64');
    });
});

suite('parseResolveCliOutput — null (environment not found)', () => {
    test('throws Error when PET returns "null" (env not found)', () => {
        assert.throws(
            () => parseResolveCliOutput('null', '/usr/bin/python3'),
            (err: Error) => {
                assert.ok(err instanceof Error);
                assert.ok(err.message.includes('/usr/bin/python3'), 'Error should mention the executable');
                return true;
            },
        );
    });

    test('error message identifies the executable', () => {
        const exe = '/home/user/.venv/bin/python';
        let caught: Error | undefined;
        try {
            parseResolveCliOutput('null', exe);
        } catch (ex) {
            caught = ex as Error;
        }
        assert.ok(caught, 'Should have thrown');
        assert.ok(caught.message.includes(exe), `Error message "${caught.message}" should include ${exe}`);
    });
});

suite('parseResolveCliOutput — malformed stdout', () => {
    test('throws SyntaxError on non-JSON output', () => {
        assert.throws(() => parseResolveCliOutput('{bad json', '/usr/bin/python'), SyntaxError);
    });

    test('throws SyntaxError on empty string', () => {
        assert.throws(() => parseResolveCliOutput('', '/usr/bin/python'), SyntaxError);
    });

    test('throws SyntaxError on partial JSON', () => {
        assert.throws(() => parseResolveCliOutput('{"executable": "/usr/bin/py', '/usr/bin/python'), SyntaxError);
    });
});
