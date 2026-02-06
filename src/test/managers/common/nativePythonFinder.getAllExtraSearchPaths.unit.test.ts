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
        // Also stub the namespace import version that might be used by untildifyArray
        // Handle both Unix (~/) and Windows-style paths
        sinon
            .stub(pathUtils, 'untildifyArray')
            .callsFake((paths: string[]) =>
                paths.map((p) => (p.startsWith('~/') ? p.replace('~/', '/home/user/') : p)),
            );

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

        // Default untildify behavior - expand tildes to test paths
        mockUntildify.callsFake((path: string) => {
            if (path.startsWith('~/')) {
                return path.replace('~/', '/home/user/');
            }
            return path;
        });

        // Set up default returns for legacy settings (return undefined by default)
        pythonConfig.get.withArgs('venvPath').returns(undefined);
        pythonConfig.get.withArgs('venvFolders').returns(undefined);

        // Set up default returns for new settings
        envConfig.inspect.withArgs('globalSearchPaths').returns({ globalValue: [] });
        envConfig.inspect.withArgs('workspaceSearchPaths').returns({});

        // Default configuration behavior
        mockGetConfiguration.callsFake((section: string, _scope?: unknown) => {
            if (section === 'python') {
                return pythonConfig;
            }
            if (section === 'python-envs') {
                return envConfig;
            }
            throw new Error(`Unexpected configuration section: ${section}`);
        });
    });

    teardown(() => {
        sinon.restore();
    });

    suite('Legacy Path Consolidation Tests', () => {
        test('No legacy settings exist - returns empty paths', async () => {
            // Mock → No legacy settings, no new settings
            pythonConfig.get.withArgs('venvPath').returns(undefined);
            pythonConfig.get.withArgs('venvFolders').returns(undefined);
            envConfig.inspect.withArgs('globalSearchPaths').returns({ globalValue: [] });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({});

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert
            assert.deepStrictEqual(result, []);
        });

        test('Legacy and global paths are consolidated (Unix)', async () => {
            // Mock → Legacy paths and globalSearchPaths both exist (Unix-style)
            pythonConfig.get.withArgs('venvPath').returns('/home/user/.virtualenvs');
            pythonConfig.get.withArgs('venvFolders').returns(['/home/user/venvs']);
            envConfig.inspect.withArgs('globalSearchPaths').returns({
                globalValue: ['/home/user/.virtualenvs', '/home/user/venvs', '/additional/path'],
            });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({});

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - Should consolidate all paths (duplicates removed)
            const expected = new Set(['/home/user/.virtualenvs', '/home/user/venvs', '/additional/path']);
            const actual = new Set(result);
            assert.strictEqual(actual.size, expected.size, 'Should have correct number of unique paths');
            assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
        });

        test('Legacy and global paths are consolidated (Windows)', async () => {
            // Mock → Legacy paths and globalSearchPaths both exist (Windows-style)
            pythonConfig.get.withArgs('venvPath').returns('C:\\Users\\dev\\.virtualenvs');
            pythonConfig.get.withArgs('venvFolders').returns(['D:\\shared\\venvs']);
            envConfig.inspect.withArgs('globalSearchPaths').returns({
                globalValue: ['C:\\Users\\dev\\.virtualenvs', 'D:\\shared\\venvs', 'E:\\additional\\path'],
            });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({});

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - Should consolidate all paths (duplicates removed), normalized to forward slashes
            const expected = new Set(['C:/Users/dev/.virtualenvs', 'D:/shared/venvs', 'E:/additional/path']);
            const actual = new Set(result);
            assert.strictEqual(actual.size, expected.size, 'Should have correct number of unique paths');
            assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
        });

        test('Legacy paths included alongside new settings (Unix)', async () => {
            // Mock → Legacy paths exist, no globalSearchPaths (Unix-style)
            pythonConfig.get.withArgs('venvPath').returns('/home/user/.virtualenvs');
            pythonConfig.get.withArgs('venvFolders').returns(['/home/user/venvs', '/home/user/conda']);
            envConfig.inspect.withArgs('globalSearchPaths').returns({ globalValue: [] });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({});

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - Should include all legacy paths
            const expected = new Set(['/home/user/.virtualenvs', '/home/user/venvs', '/home/user/conda']);
            const actual = new Set(result);
            assert.strictEqual(actual.size, expected.size, 'Should have correct number of unique paths');
            assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
        });

        test('Legacy paths included alongside new settings (Windows)', async () => {
            // Mock → Legacy paths exist, no globalSearchPaths (Windows-style)
            pythonConfig.get.withArgs('venvPath').returns('C:\\Users\\dev\\.virtualenvs');
            pythonConfig.get.withArgs('venvFolders').returns(['C:\\Users\\dev\\venvs', 'D:\\conda\\envs']);
            envConfig.inspect.withArgs('globalSearchPaths').returns({ globalValue: [] });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({});

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - Should include all legacy paths, normalized to forward slashes
            const expected = new Set(['C:/Users/dev/.virtualenvs', 'C:/Users/dev/venvs', 'D:/conda/envs']);
            const actual = new Set(result);
            assert.strictEqual(actual.size, expected.size, 'Should have correct number of unique paths');
            assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
        });

        test('Legacy and global paths combined with deduplication', async () => {
            // Mock → Some overlap between legacy and global paths
            pythonConfig.get.withArgs('venvPath').returns('/home/user/.virtualenvs');
            pythonConfig.get.withArgs('venvFolders').returns(['/home/user/venvs', '/home/user/conda']);
            envConfig.inspect
                .withArgs('globalSearchPaths')
                .returns({ globalValue: ['/home/user/.virtualenvs', '/additional/path'] });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({});

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - Should include all paths with duplicates removed
            const expected = new Set([
                '/home/user/.virtualenvs',
                '/home/user/venvs',
                '/home/user/conda',
                '/additional/path',
            ]);
            const actual = new Set(result);
            assert.strictEqual(actual.size, expected.size, 'Should have correct number of unique paths');
            assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
        });

        test('Legacy paths with untildify support', async () => {
            // Mock → Legacy paths with tilde expansion
            // Note: getPythonSettingAndUntildify only untildifies strings, not array items
            // So we return the venvPath with tilde (will be untildified) and venvFolders pre-expanded
            pythonConfig.get.withArgs('venvPath').returns('~/virtualenvs');
            pythonConfig.get.withArgs('venvFolders').returns(['/home/user/conda/envs']); // Pre-expanded
            envConfig.inspect.withArgs('globalSearchPaths').returns({ globalValue: [] });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({});

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert
            const expected = new Set(['/home/user/virtualenvs', '/home/user/conda/envs']);
            const actual = new Set(result);
            assert.strictEqual(actual.size, expected.size, 'Should have correct number of unique paths');
            assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
        });
    });

    suite('Configuration Source Tests', () => {
        test('Global search paths with tilde expansion (Unix)', async () => {
            // Mock → No legacy, global paths with tildes (Unix ~ expansion)
            pythonConfig.get.withArgs('venvPath').returns(undefined);
            pythonConfig.get.withArgs('venvFolders').returns(undefined);
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

        test('Global search paths with absolute paths (Windows)', async () => {
            // Mock → No legacy, global paths with Windows absolute paths
            pythonConfig.get.withArgs('venvPath').returns(undefined);
            pythonConfig.get.withArgs('venvFolders').returns(undefined);
            envConfig.inspect.withArgs('globalSearchPaths').returns({
                globalValue: ['C:\\Users\\dev\\virtualenvs', 'D:\\conda\\envs'],
            });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({});

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - Paths normalized to forward slashes
            const expected = new Set(['C:/Users/dev/virtualenvs', 'D:/conda/envs']);
            const actual = new Set(result);
            assert.strictEqual(actual.size, expected.size, 'Should have correct number of unique paths');
            assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
        });

        test('Workspace folder setting preferred over workspace setting (Unix)', async () => {
            // Mock → Workspace settings at different levels (Unix-style)
            pythonConfig.get.withArgs('venvPath').returns(undefined);
            pythonConfig.get.withArgs('venvFolders').returns(undefined);
            envConfig.inspect.withArgs('globalSearchPaths').returns({ globalValue: [] });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({
                workspaceValue: ['/workspace-level-path'],
                workspaceFolderValue: ['/folder-level-path'],
            });

            const workspace1 = Uri.file('/workspace/project1');
            const workspace2 = Uri.file('/workspace/project2');
            mockGetWorkspaceFolders.returns([{ uri: workspace1 }, { uri: workspace2 }]);

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - workspaceFolderValue takes priority, absolute path is kept as-is
            const expected = new Set(['/folder-level-path']);
            const actual = new Set(result);
            assert.strictEqual(actual.size, expected.size, 'Should have correct number of unique paths');
            assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
        });

        test('Workspace folder setting preferred over workspace setting (Windows)', async () => {
            // Mock → Workspace settings at different levels (Windows-style paths in config)
            pythonConfig.get.withArgs('venvPath').returns(undefined);
            pythonConfig.get.withArgs('venvFolders').returns(undefined);
            envConfig.inspect.withArgs('globalSearchPaths').returns({ globalValue: [] });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({
                workspaceValue: ['D:\\workspace-level'],
                workspaceFolderValue: ['C:\\folder-level\\path'],
            });

            // Use Unix-style URIs for workspace folders (Uri.file behavior is OS-dependent)
            const workspace1 = Uri.file('/projects/project1');
            const workspace2 = Uri.file('/projects/project2');
            mockGetWorkspaceFolders.returns([{ uri: workspace1 }, { uri: workspace2 }]);

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - workspaceFolderValue takes priority, normalized to forward slashes
            const expected = new Set(['C:/folder-level/path']);
            const actual = new Set(result);
            assert.strictEqual(actual.size, expected.size, 'Should have correct number of unique paths');
            assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
        });

        test('Global workspace setting logs error and is ignored', async () => {
            // Mock → Workspace setting incorrectly set at global level
            pythonConfig.get.withArgs('venvPath').returns(undefined);
            pythonConfig.get.withArgs('venvFolders').returns(undefined);
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
            pythonConfig.get.withArgs('venvPath').returns(undefined);
            pythonConfig.get.withArgs('venvFolders').returns(undefined);
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
        test('Absolute paths used as-is (Unix)', async () => {
            // Mock → Mix of absolute paths (Unix-style)
            pythonConfig.get.withArgs('venvPath').returns(undefined);
            pythonConfig.get.withArgs('venvFolders').returns(undefined);
            envConfig.inspect.withArgs('globalSearchPaths').returns({
                globalValue: ['/absolute/path1', '/absolute/path2'],
            });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({
                workspaceFolderValue: ['/absolute/workspace/path'],
            });

            const workspace = Uri.file('/workspace');
            mockGetWorkspaceFolders.returns([{ uri: workspace }]);

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - For absolute paths, they should remain unchanged
            const expected = new Set(['/absolute/path1', '/absolute/path2', '/absolute/workspace/path']);
            const actual = new Set(result);
            assert.strictEqual(actual.size, expected.size, 'Should have correct number of unique paths');
            assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
        });

        test('Absolute paths used as-is (Windows)', async () => {
            // Mock → Mix of absolute paths (Windows-style paths in config)
            pythonConfig.get.withArgs('venvPath').returns(undefined);
            pythonConfig.get.withArgs('venvFolders').returns(undefined);
            envConfig.inspect.withArgs('globalSearchPaths').returns({
                globalValue: ['C:\\absolute\\path1', 'D:\\absolute\\path2'],
            });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({
                workspaceFolderValue: ['E:\\workspace\\envs'],
            });

            // Use Unix-style URIs for workspace folders (Uri.file behavior is OS-dependent)
            const workspace = Uri.file('/workspace');
            mockGetWorkspaceFolders.returns([{ uri: workspace }]);

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - Windows paths normalized to forward slashes
            const expected = new Set(['C:/absolute/path1', 'D:/absolute/path2', 'E:/workspace/envs']);
            const actual = new Set(result);
            assert.strictEqual(actual.size, expected.size, 'Should have correct number of unique paths');
            assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
        });

        test('Relative paths are resolved against workspace folders', async () => {
            // Mock → Relative workspace paths with multiple workspace folders
            pythonConfig.get.withArgs('venvPath').returns(undefined);
            pythonConfig.get.withArgs('venvFolders').returns(undefined);
            envConfig.inspect.withArgs('globalSearchPaths').returns({ globalValue: [] });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({
                workspaceFolderValue: ['venvs', '.venv'],
            });

            const workspace1 = Uri.file('/workspace/project1');
            const workspace2 = Uri.file('/workspace/project2');
            mockGetWorkspaceFolders.returns([{ uri: workspace1 }, { uri: workspace2 }]);

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - Relative paths are resolved against each workspace folder
            // path.resolve behavior varies by platform, so check the paths contain expected segments
            assert.strictEqual(result.length, 4, 'Should have 4 paths (2 relative × 2 workspaces)');
            assert.ok(result.some((p) => p.includes('project1') && p.endsWith('venvs')));
            assert.ok(result.some((p) => p.includes('project2') && p.endsWith('venvs')));
            assert.ok(result.some((p) => p.includes('project1') && p.endsWith('.venv')));
            assert.ok(result.some((p) => p.includes('project2') && p.endsWith('.venv')));
        });

        test('Relative paths without workspace folders logs warning', async () => {
            // Mock → Relative paths but no workspace folders
            pythonConfig.get.withArgs('venvPath').returns(undefined);
            pythonConfig.get.withArgs('venvFolders').returns(undefined);
            envConfig.inspect.withArgs('globalSearchPaths').returns({ globalValue: [] });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({
                workspaceFolderValue: ['relative-path'],
            });

            mockGetWorkspaceFolders.returns(undefined); // No workspace folders

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - Path is not added and warning is logged
            assert.deepStrictEqual(result, []);
            assert.ok(mockTraceWarn.called, 'Should warn about missing workspace folders');
        });

        test('Empty and whitespace paths are skipped', async () => {
            // Mock → Mix of valid and invalid paths
            pythonConfig.get.withArgs('venvPath').returns(undefined);
            pythonConfig.get.withArgs('venvFolders').returns(undefined);
            envConfig.inspect.withArgs('globalSearchPaths').returns({
                globalValue: ['/valid/path', '', '  ', '/another/valid/path'],
            });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({
                workspaceFolderValue: ['/workspace/valid', '', '   \t\n   ', '/workspace/another'],
            });

            const workspace = Uri.file('/workspace');
            mockGetWorkspaceFolders.returns([{ uri: workspace }]);

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - Empty strings filtered out, valid paths kept
            const expected = new Set(['/valid/path', '/another/valid/path', '/workspace/valid', '/workspace/another']);
            const actual = new Set(result);
            assert.strictEqual(actual.size, expected.size, 'Should have correct number of unique paths');
            assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
        });
    });

    suite('Integration Scenarios', () => {
        test('Fresh install - no settings configured', async () => {
            // Mock → Clean slate
            pythonConfig.get.withArgs('venvPath').returns(undefined);
            pythonConfig.get.withArgs('venvFolders').returns(undefined);
            envConfig.inspect.withArgs('globalSearchPaths').returns({ globalValue: [] });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({});

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert
            assert.deepStrictEqual(result, []);
        });

        test('Power user - complex mix of all source types (Unix)', async () => {
            // Mock → Complex real-world scenario (Unix-style)
            pythonConfig.get.withArgs('venvPath').returns('/legacy/venv/path');
            pythonConfig.get.withArgs('venvFolders').returns(['/legacy/venvs']);
            envConfig.inspect.withArgs('globalSearchPaths').returns({
                globalValue: ['/legacy/venv/path', '/legacy/venvs', '/global/conda', '~/personal/envs'],
            });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({
                workspaceFolderValue: ['.venv', '/shared/team/envs'],
            });

            const workspace1 = Uri.file('/workspace/project1');
            const workspace2 = Uri.file('/workspace/project2');
            mockGetWorkspaceFolders.returns([{ uri: workspace1 }, { uri: workspace2 }]);

            mockUntildify.withArgs('~/personal/envs').returns('/home/user/personal/envs');

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - Relative paths are resolved against workspace folders, absolutes kept as-is
            assert.ok(result.includes('/legacy/venv/path'));
            assert.ok(result.includes('/legacy/venvs'));
            assert.ok(result.includes('/global/conda'));
            assert.ok(result.includes('/home/user/personal/envs'));
            assert.ok(result.includes('/shared/team/envs'));
            // .venv resolved against both workspace folders
            assert.ok(result.some((p) => p.includes('project1') && p.endsWith('.venv')));
            assert.ok(result.some((p) => p.includes('project2') && p.endsWith('.venv')));
        });

        test('Power user - complex mix of all source types (Windows)', async () => {
            // Mock → Complex real-world scenario (Windows-style paths in config)
            pythonConfig.get.withArgs('venvPath').returns('C:\\legacy\\venv\\path');
            pythonConfig.get.withArgs('venvFolders').returns(['D:\\legacy\\venvs']);
            envConfig.inspect.withArgs('globalSearchPaths').returns({
                globalValue: ['C:\\legacy\\venv\\path', 'D:\\legacy\\venvs', 'E:\\global\\conda'],
            });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({
                workspaceFolderValue: ['.venv', 'F:\\shared\\team\\envs'],
            });

            // Use Unix-style URIs for workspace folders (Uri.file behavior is OS-dependent)
            const workspace1 = Uri.file('/workspace/project1');
            const workspace2 = Uri.file('/workspace/project2');
            mockGetWorkspaceFolders.returns([{ uri: workspace1 }, { uri: workspace2 }]);

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - All paths normalized to forward slashes
            assert.ok(result.includes('C:/legacy/venv/path'));
            assert.ok(result.includes('D:/legacy/venvs'));
            assert.ok(result.includes('E:/global/conda'));
            assert.ok(result.includes('F:/shared/team/envs'));
            // .venv resolved against both workspace folders
            assert.ok(result.some((p) => p.includes('project1') && p.endsWith('.venv')));
            assert.ok(result.some((p) => p.includes('project2') && p.endsWith('.venv')));
            // Verify no backslashes remain
            for (const p of result) {
                assert.ok(!p.includes('\\'), `Path should not contain backslashes: ${p}`);
            }
        });

        test('Overlapping paths are deduplicated (Unix)', async () => {
            // Mock → Duplicate paths from different sources (Unix-style)
            pythonConfig.get.withArgs('venvPath').returns(undefined);
            pythonConfig.get.withArgs('venvFolders').returns(undefined);
            envConfig.inspect.withArgs('globalSearchPaths').returns({
                globalValue: ['/shared/path', '/global/unique'],
            });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({
                workspaceFolderValue: ['/shared/path', '/workspace/unique'],
            });

            const workspace = Uri.file('/workspace');
            mockGetWorkspaceFolders.returns([{ uri: workspace }]);

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - Duplicates should be removed
            const expected = new Set(['/shared/path', '/global/unique', '/workspace/unique']);
            const actual = new Set(result);
            assert.strictEqual(actual.size, expected.size, 'Should have correct number of unique paths');
            assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
        });

        test('Overlapping paths are deduplicated (Windows)', async () => {
            // Mock → Duplicate paths from different sources (Windows-style paths in config)
            pythonConfig.get.withArgs('venvPath').returns(undefined);
            pythonConfig.get.withArgs('venvFolders').returns(undefined);
            envConfig.inspect.withArgs('globalSearchPaths').returns({
                globalValue: ['C:\\shared\\path', 'D:\\global\\unique'],
            });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({
                workspaceFolderValue: ['C:\\shared\\path', 'E:\\workspace\\unique'],
            });

            // Use Unix-style URIs for workspace folders (Uri.file behavior is OS-dependent)
            const workspace = Uri.file('/workspace');
            mockGetWorkspaceFolders.returns([{ uri: workspace }]);

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - Duplicates should be removed, normalized to forward slashes
            const expected = new Set(['C:/shared/path', 'D:/global/unique', 'E:/workspace/unique']);
            const actual = new Set(result);
            assert.strictEqual(actual.size, expected.size, 'Should have correct number of unique paths');
            assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
        });

        test('All path types consolidated together', async () => {
            // Mock → Multiple path types from different sources
            pythonConfig.get.withArgs('venvPath').returns('/legacy/path');
            pythonConfig.get.withArgs('venvFolders').returns(['/legacy/folder']);
            envConfig.inspect.withArgs('globalSearchPaths').returns({ globalValue: ['/global/path'] });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({
                workspaceFolderValue: ['.venv'],
            });

            const workspace = Uri.file('/workspace');
            mockGetWorkspaceFolders.returns([{ uri: workspace }]);

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - Should consolidate all path types, relative resolved against workspace
            assert.ok(result.includes('/legacy/path'));
            assert.ok(result.includes('/legacy/folder'));
            assert.ok(result.includes('/global/path'));
            assert.ok(result.some((p) => p.includes('workspace') && p.endsWith('.venv')));
        });
    });

    suite('Cross-Platform Path Normalization', () => {
        test('Backslashes are converted to forward slashes for glob compatibility', async () => {
            // Mock → Windows-style paths with backslashes
            pythonConfig.get.withArgs('venvPath').returns('C:\\Users\\test\\envs');
            pythonConfig.get.withArgs('venvFolders').returns(['D:\\shared\\venvs']);
            envConfig.inspect.withArgs('globalSearchPaths').returns({
                globalValue: ['C:\\Python\\environments', 'E:\\projects\\**\\.venv'],
            });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({});

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - All backslashes should be converted to forward slashes
            for (const p of result) {
                assert.ok(!p.includes('\\'), `Path should not contain backslashes: ${p}`);
            }
            assert.ok(result.includes('C:/Users/test/envs'));
            assert.ok(result.includes('D:/shared/venvs'));
            assert.ok(result.includes('C:/Python/environments'));
            assert.ok(result.includes('E:/projects/**/.venv'));
        });

        test('Glob patterns with backslashes are normalized', async () => {
            // Mock → Glob pattern with Windows backslashes
            pythonConfig.get.withArgs('venvPath').returns(undefined);
            pythonConfig.get.withArgs('venvFolders').returns(undefined);
            envConfig.inspect.withArgs('globalSearchPaths').returns({
                globalValue: ['C:\\workspace\\**\\venv', 'D:\\projects\\*\\.venv'],
            });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({});

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - Glob patterns should use forward slashes
            assert.ok(result.includes('C:/workspace/**/venv'));
            assert.ok(result.includes('D:/projects/*/.venv'));
        });

        test('Linux/macOS paths with forward slashes are preserved', async () => {
            // Mock → Unix-style paths (already using forward slashes)
            pythonConfig.get.withArgs('venvPath').returns('/home/user/envs');
            pythonConfig.get.withArgs('venvFolders').returns(['/opt/shared/venvs']);
            envConfig.inspect.withArgs('globalSearchPaths').returns({
                globalValue: ['/usr/local/python/environments', '/home/user/projects/**/.venv'],
            });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({});

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - Forward slashes should be preserved as-is
            assert.ok(result.includes('/home/user/envs'));
            assert.ok(result.includes('/opt/shared/venvs'));
            assert.ok(result.includes('/usr/local/python/environments'));
            assert.ok(result.includes('/home/user/projects/**/.venv'));
            // Verify no backslashes were introduced
            for (const p of result) {
                assert.ok(!p.includes('\\'), `Path should not contain backslashes: ${p}`);
            }
        });

        test('Mixed path separators are normalized to forward slashes', async () => {
            // Mock → Paths with mixed separators (edge case)
            pythonConfig.get.withArgs('venvPath').returns(undefined);
            pythonConfig.get.withArgs('venvFolders').returns(undefined);
            envConfig.inspect.withArgs('globalSearchPaths').returns({
                globalValue: ['C:/Users\\test/projects\\.venv', '/home/user\\mixed/path'],
            });
            envConfig.inspect.withArgs('workspaceSearchPaths').returns({});

            // Run
            const result = await getAllExtraSearchPaths();

            // Assert - All backslashes normalized to forward slashes
            assert.ok(result.includes('C:/Users/test/projects/.venv'));
            assert.ok(result.includes('/home/user/mixed/path'));
        });
    });
});
