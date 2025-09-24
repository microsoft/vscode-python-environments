import assert from 'node:assert';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import * as logging from '../../../common/logging';
import * as pathUtils from '../../../common/utils/pathUtils';
import * as workspaceApis from '../../../common/workspace.apis';

// Import the function under test
import { getAllExtraSearchPaths } from '../../../managers/common/nativePythonFinder';

interface MockWorkspaceConfig {
    get: sinon.SinonStub;
    inspect: sinon.SinonStub;
    update: sinon.SinonStub;
}

suite('getAllExtraSearchPaths Integration Tests', () => {
    let mockGetConfiguration: sinon.SinonStub;
    let mockUntildify: sinon.SinonStub;
    let mockTraceError: sinon.SinonStub;
    let mockTraceWarn: sinon.SinonStub;
    let mockGetWorkspaceFolders: sinon.SinonStub;

    // Mock configuration objects
    let pythonConfig: MockWorkspaceConfig;
    let envConfig: MockWorkspaceConfig;

    setup(() => {
        // Mock VS Code workspace APIs
        mockGetConfiguration = sinon.stub(workspaceApis, 'getConfiguration');
        mockGetWorkspaceFolders = sinon.stub(workspaceApis, 'getWorkspaceFolders');
        mockUntildify = sinon.stub(pathUtils, 'untildify');
        mockTraceError = sinon.stub(logging, 'traceError');
        mockTraceWarn = sinon.stub(logging, 'traceWarn');

        // Default workspace behavior - no folders
        mockGetWorkspaceFolders.returns(undefined);

        // Create mock configuration objects
        pythonConfig = {
            get: sinon.stub(),
            inspect: sinon.stub(),
            update: sinon.stub(),
        };

        envConfig = {
            get: sinon.stub(),
            inspect: sinon.stub(),
            update: sinon.stub(),
        };

        // Default untildify behavior - return input unchanged
        mockUntildify.callsFake((path: string) => path);

        // Default configuration behavior
        mockGetConfiguration.callsFake((section: string) => {
            if (section === 'python') {
                return pythonConfig;
            }
            if (section === 'python-env') {
                return envConfig;
            }
            throw new Error(`Unexpected configuration section: ${section}`);
        });
    });

    teardown(() => {
        sinon.restore();
    });

    suite('Legacy Migration Tests', () => {
        test('No legacy settings exist - returns empty paths', async () => {
            // Mock → No legacy settings, no new settings
            pythonConfig.inspect.withArgs('venvPath').returns({ globalValue: undefined });
            pythonConfig.inspect.withArgs('venvFolders').returns({ globalValue: undefined });
            envConfig.inspect.withArgs('globalSearchPaths').returns({ globalValue: [] });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({});

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert
            assert.deepStrictEqual(result, []);
            assert(envConfig.update.notCalled, 'Should not update settings when no legacy paths exist');
        });

        test('Legacy settings already migrated - uses globalSearchPaths only', async () => {
            // Mock → Legacy paths exist but are already in globalSearchPaths
            pythonConfig.inspect.withArgs('venvPath').returns({ globalValue: '/home/user/.virtualenvs' });
            pythonConfig.inspect.withArgs('venvFolders').returns({ globalValue: ['/home/user/venvs'] });
            envConfig.inspect.withArgs('globalSearchPaths').returns({
                globalValue: ['/home/user/.virtualenvs', '/home/user/venvs', '/additional/path'],
            });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({});

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert
            const expected = new Set(['/home/user/.virtualenvs', '/home/user/venvs', '/additional/path']);
            const actual = new Set(result);
            assert.strictEqual(actual.size, expected.size, 'Should have correct number of unique paths');
            assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
            assert(envConfig.update.notCalled, 'Should not update settings when legacy paths already migrated');
        });

        test('Fresh migration needed - migrates legacy to globalSearchPaths', async () => {
            // Mock → Legacy paths exist and need migration
            pythonConfig.inspect.withArgs('venvPath').returns({ globalValue: '/home/user/.virtualenvs' });
            pythonConfig.inspect
                .withArgs('venvFolders')
                .returns({ globalValue: ['/home/user/venvs', '/home/user/conda'] });
            envConfig.inspect.withArgs('globalSearchPaths').returns({ globalValue: [] });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({});
            envConfig.update.resolves();

            // After migration, the globalSearchPaths should return the migrated values
            envConfig.inspect
                .withArgs('globalSearchPaths')
                .onSecondCall()
                .returns({
                    globalValue: ['/home/user/.virtualenvs', '/home/user/venvs', '/home/user/conda'],
                });

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert
            const expected = new Set(['/home/user/.virtualenvs', '/home/user/venvs', '/home/user/conda']);
            const actual = new Set(result);
            assert.strictEqual(actual.size, expected.size, 'Should have correct number of unique paths');
            assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
            assert(
                envConfig.update.calledOnceWith(
                    'globalSearchPaths',
                    ['/home/user/.virtualenvs', '/home/user/venvs', '/home/user/conda'],
                    true,
                ),
            );
        });

        test('Partial migration - combines existing and new legacy paths', async () => {
            // Mock → Some legacy paths already migrated, others need migration
            pythonConfig.inspect.withArgs('venvPath').returns({ globalValue: '/home/user/.virtualenvs' });
            pythonConfig.inspect
                .withArgs('venvFolders')
                .returns({ globalValue: ['/home/user/venvs', '/home/user/conda'] });
            envConfig.inspect.withArgs('globalSearchPaths').returns({ globalValue: ['/home/user/.virtualenvs'] });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({});
            envConfig.update.resolves();

            // After migration, globalSearchPaths should include all paths
            envConfig.inspect
                .withArgs('globalSearchPaths')
                .onSecondCall()
                .returns({
                    globalValue: ['/home/user/.virtualenvs', '/home/user/venvs', '/home/user/conda'],
                });

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert
            const expected = new Set(['/home/user/.virtualenvs', '/home/user/venvs', '/home/user/conda']);
            const actual = new Set(result);
            assert.strictEqual(actual.size, expected.size, 'Should have correct number of unique paths');
            assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
            assert(
                envConfig.update.calledOnceWith(
                    'globalSearchPaths',
                    ['/home/user/.virtualenvs', '/home/user/venvs', '/home/user/conda'],
                    true,
                ),
            );
        });

        test('Migration fails - falls back to including legacy paths separately', async () => {
            // Mock → Migration throws error
            pythonConfig.inspect.withArgs('venvPath').returns({ globalValue: '/home/user/.virtualenvs' });
            pythonConfig.inspect.withArgs('venvFolders').returns({ globalValue: ['/home/user/venvs'] });
            envConfig.inspect.withArgs('globalSearchPaths').returns({ globalValue: [] });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({});
            envConfig.update.rejects(new Error('Permission denied'));

            // Mock legacy function behavior
            pythonConfig.get.withArgs('venvPath').returns('/home/user/.virtualenvs');
            pythonConfig.get.withArgs('venvFolders').returns(['/home/user/venvs']);

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - Should fall back to legacy paths (order doesn't matter)
            const expected = new Set(['/home/user/.virtualenvs', '/home/user/venvs']);
            const actual = new Set(result);
            assert.strictEqual(actual.size, expected.size, 'Should have correct number of unique paths');
            assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
            // Just verify that error was logged - don't be brittle about exact wording
            assert(
                mockTraceError.calledWith(sinon.match.string, sinon.match.instanceOf(Error)),
                'Should log migration error',
            );
        });
    });

    suite('Configuration Source Tests', () => {
        test('Global search paths with tilde expansion', async () => {
            // Mock → No legacy, global paths with tildes
            pythonConfig.inspect.withArgs('venvPath').returns({ globalValue: undefined });
            pythonConfig.inspect.withArgs('venvFolders').returns({ globalValue: undefined });
            envConfig.inspect.withArgs('globalSearchPaths').returns({
                globalValue: ['~/virtualenvs', '~/conda/envs'],
            });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({});

            mockUntildify.withArgs('~/virtualenvs').returns('/home/user/virtualenvs');
            mockUntildify.withArgs('~/conda/envs').returns('/home/user/conda/envs');

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert
            const expected = new Set(['/home/user/virtualenvs', '/home/user/conda/envs']);
            const actual = new Set(result);
            assert.strictEqual(actual.size, expected.size, 'Should have correct number of unique paths');
            assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
        });

        test('Workspace folder setting preferred over workspace setting', async () => {
            // Mock → Workspace settings at different levels
            pythonConfig.inspect.withArgs('venvPath').returns({ globalValue: undefined });
            pythonConfig.inspect.withArgs('venvFolders').returns({ globalValue: undefined });
            envConfig.inspect.withArgs('globalSearchPaths').returns({ globalValue: [] });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({
                workspaceValue: ['workspace-level-path'],
                workspaceFolderValue: ['folder-level-path'],
            });

            mockGetWorkspaceFolders.returns([
                { uri: Uri.file('/workspace/project1') },
                { uri: Uri.file('/workspace/project2') },
            ]);

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert
            const expected = new Set([
                '/workspace/project1/folder-level-path',
                '/workspace/project2/folder-level-path',
            ]);
            const actual = new Set(result);
            assert.strictEqual(actual.size, expected.size, 'Should have correct number of unique paths');
            assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
        });

        test('Global workspace setting logs error and is ignored', async () => {
            // Mock → Workspace setting incorrectly set at global level
            pythonConfig.inspect.withArgs('venvPath').returns({ globalValue: undefined });
            pythonConfig.inspect.withArgs('venvFolders').returns({ globalValue: undefined });
            envConfig.inspect.withArgs('globalSearchPaths').returns({ globalValue: [] });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({
                globalValue: ['should-be-ignored'],
            });

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert
            assert.deepStrictEqual(result, []);
            // Check that error was logged with key terms - don't be brittle about exact wording
            assert(
                mockTraceError.calledWith(sinon.match(/workspaceSearchPaths.*global.*level/i)),
                'Should log error about incorrect setting level',
            );
        });

        test('Configuration read errors return empty arrays', async () => {
            // Mock → Configuration throws errors
            pythonConfig.inspect.withArgs('venvPath').returns({ globalValue: undefined });
            pythonConfig.inspect.withArgs('venvFolders').returns({ globalValue: undefined });
            envConfig.inspect.withArgs('globalSearchPaths').throws(new Error('Config read error'));
            envConfig.inspect.withArgs('workspaceSearchPaths').throws(new Error('Config read error'));

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert
            assert.deepStrictEqual(result, []);
            // Just verify that configuration errors were logged - don't be brittle about exact wording
            assert(
                mockTraceError.calledWith(sinon.match(/globalSearchPaths/i), sinon.match.instanceOf(Error)),
                'Should log globalSearchPaths error',
            );
            assert(
                mockTraceError.calledWith(sinon.match(/workspaceSearchPaths/i), sinon.match.instanceOf(Error)),
                'Should log workspaceSearchPaths error',
            );
        });
    });

    suite('Path Resolution Tests', () => {
        test('Absolute paths used as-is', async () => {
            // Mock → Mix of absolute paths
            pythonConfig.inspect.withArgs('venvPath').returns({ globalValue: undefined });
            pythonConfig.inspect.withArgs('venvFolders').returns({ globalValue: undefined });
            envConfig.inspect.withArgs('globalSearchPaths').returns({
                globalValue: ['/absolute/path1', '/absolute/path2'],
            });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({
                workspaceFolderValue: ['/absolute/workspace/path'],
            });

            mockGetWorkspaceFolders.returns([{ uri: Uri.file('/workspace') }]);

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert
            const expected = new Set(['/absolute/path1', '/absolute/path2', '/absolute/workspace/path']);
            const actual = new Set(result);
            assert.strictEqual(actual.size, expected.size, 'Should have correct number of unique paths');
            assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
        });

        test('Relative paths resolved against workspace folders', async () => {
            // Mock → Relative workspace paths with multiple workspace folders
            pythonConfig.inspect.withArgs('venvPath').returns({ globalValue: undefined });
            pythonConfig.inspect.withArgs('venvFolders').returns({ globalValue: undefined });
            envConfig.inspect.withArgs('globalSearchPaths').returns({ globalValue: [] });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({
                workspaceFolderValue: ['venvs', '../shared-envs'],
            });

            mockGetWorkspaceFolders.returns([
                { uri: Uri.file('/workspace/project1') },
                { uri: Uri.file('/workspace/project2') },
            ]);

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - path.resolve() correctly resolves relative paths (order doesn't matter)
            const expected = new Set([
                '/workspace/project1/venvs',
                '/workspace/project2/venvs',
                '/workspace/shared-envs', // ../shared-envs resolves to /workspace/shared-envs
            ]);
            const actual = new Set(result);
            assert.strictEqual(actual.size, expected.size, 'Should have correct number of unique paths');
            assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
        });

        test('Relative paths without workspace folders logs warning', async () => {
            // Mock → Relative paths but no workspace folders
            pythonConfig.inspect.withArgs('venvPath').returns({ globalValue: undefined });
            pythonConfig.inspect.withArgs('venvFolders').returns({ globalValue: undefined });
            envConfig.inspect.withArgs('globalSearchPaths').returns({ globalValue: [] });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({
                workspaceFolderValue: ['relative-path'],
            });

            mockGetWorkspaceFolders.returns(undefined); // No workspace folders

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert
            assert.deepStrictEqual(result, []);
            // Check that warning was logged with key terms - don't be brittle about exact wording
            assert(
                mockTraceWarn.calledWith(sinon.match(/workspace.*folder.*relative.*path/i), 'relative-path'),
                'Should log warning about missing workspace folders',
            );
        });

        test('Empty and whitespace paths are skipped', async () => {
            // Mock → Mix of valid and invalid paths
            pythonConfig.inspect.withArgs('venvPath').returns({ globalValue: undefined });
            pythonConfig.inspect.withArgs('venvFolders').returns({ globalValue: undefined });
            envConfig.inspect.withArgs('globalSearchPaths').returns({
                globalValue: ['/valid/path', '', '  ', '/another/valid/path'],
            });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({
                workspaceFolderValue: ['valid-relative', '', '   \t\n   ', 'another-valid'],
            });

            mockGetWorkspaceFolders.returns([{ uri: Uri.file('/workspace') }]);

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - Now globalSearchPaths empty strings should be filtered out (order doesn't matter)
            const expected = new Set([
                '/valid/path',
                '/another/valid/path',
                '/workspace/valid-relative',
                '/workspace/another-valid',
            ]);
            const actual = new Set(result);
            assert.strictEqual(actual.size, expected.size, 'Should have correct number of unique paths');
            assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
        });
    });

    suite('Integration Scenarios', () => {
        test('Fresh install - no settings configured', async () => {
            // Mock → Clean slate
            pythonConfig.inspect.withArgs('venvPath').returns({ globalValue: undefined });
            pythonConfig.inspect.withArgs('venvFolders').returns({ globalValue: undefined });
            envConfig.inspect.withArgs('globalSearchPaths').returns({ globalValue: [] });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({});

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert
            assert.deepStrictEqual(result, []);
        });

        test('Power user - complex mix of all source types', async () => {
            // Mock → Complex real-world scenario
            pythonConfig.inspect.withArgs('venvPath').returns({ globalValue: '/legacy/venv/path' });
            pythonConfig.inspect.withArgs('venvFolders').returns({ globalValue: ['/legacy/venvs'] });
            envConfig.inspect.withArgs('globalSearchPaths').returns({
                globalValue: ['/legacy/venv/path', '/legacy/venvs', '/global/conda', '~/personal/envs'],
            });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({
                workspaceFolderValue: ['.venv', 'project-envs', '/shared/team/envs'],
            });

            mockGetWorkspaceFolders.returns([
                { uri: Uri.file('/workspace/project1') },
                { uri: Uri.file('/workspace/project2') },
            ]);

            mockUntildify.withArgs('~/personal/envs').returns('/home/user/personal/envs');

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - Should deduplicate and combine all sources (order doesn't matter)
            const expected = new Set([
                '/legacy/venv/path',
                '/legacy/venvs',
                '/global/conda',
                '/home/user/personal/envs',
                '/workspace/project1/.venv',
                '/workspace/project2/.venv',
                '/workspace/project1/project-envs',
                '/workspace/project2/project-envs',
                '/shared/team/envs',
            ]);
            const actual = new Set(result);

            // Check that we have exactly the expected paths (no more, no less)
            assert.strictEqual(actual.size, expected.size, 'Should have correct number of unique paths');
            assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
        });

        test('Overlapping paths are deduplicated', async () => {
            // Mock → Duplicate paths from different sources
            pythonConfig.inspect.withArgs('venvPath').returns({ globalValue: undefined });
            pythonConfig.inspect.withArgs('venvFolders').returns({ globalValue: undefined });
            envConfig.inspect.withArgs('globalSearchPaths').returns({
                globalValue: ['/shared/path', '/global/unique'],
            });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({
                workspaceFolderValue: ['/shared/path', 'workspace-unique'],
            });

            mockGetWorkspaceFolders.returns([{ uri: Uri.file('/workspace') }]);

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - Duplicates should be removed (order doesn't matter)
            const expected = new Set(['/shared/path', '/global/unique', '/workspace/workspace-unique']);
            const actual = new Set(result);
            assert.strictEqual(actual.size, expected.size, 'Should have correct number of unique paths');
            assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
        });

        test('Settings save failure during migration', async () => {
            // Mock → Migration fails due to corrupted settings file
            pythonConfig.inspect.withArgs('venvPath').returns({ globalValue: '/legacy/path' });
            pythonConfig.inspect.withArgs('venvFolders').returns({ globalValue: undefined });
            envConfig.inspect.withArgs('globalSearchPaths').returns({ globalValue: [] });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({});
            envConfig.update.rejects(new Error('Failed to save settings - file may be corrupted'));

            // Mock legacy fallback
            pythonConfig.get.withArgs('venvPath').returns('/legacy/path');
            pythonConfig.get.withArgs('venvFolders').returns([]);

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - Should fall back to legacy paths
            assert.deepStrictEqual(result, ['/legacy/path']);
            // Just verify that migration error was logged - don't be brittle about exact wording
            assert(
                mockTraceError.calledWith(sinon.match.string, sinon.match.instanceOf(Error)),
                'Should log migration error',
            );
        });
    });
});
