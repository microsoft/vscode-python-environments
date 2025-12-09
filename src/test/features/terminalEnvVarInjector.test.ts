// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { FileChangeType, GlobalEnvironmentVariableCollection, Uri, WorkspaceFolder } from 'vscode';
import * as workspaceApis from '../../common/workspace.apis';
import { PythonEnvVariableManager } from '../../features/execution/envVariableManager';
import { TerminalEnvVarInjector } from '../../features/terminal/terminalEnvVarInjector';
import { PythonProjectManager } from '../../internal.api';

suite('TerminalEnvVarInjector - Integration Tests with Fixtures', () => {
    let tempDir: string;
    let mockGetConfiguration: sinon.SinonStub;
    let mockEnvVarCollection: GlobalEnvironmentVariableCollection;
    let envVarManager: PythonEnvVariableManager;
    let injector: TerminalEnvVarInjector;
    let scopedCollectionStubs: Map<
        string,
        { replace: sinon.SinonStub; delete: sinon.SinonStub; clear: sinon.SinonStub; get: sinon.SinonStub }
    >;

    const fixturesPath = path.join(__dirname, '..', 'fixtures', 'terminalEnvVarInjector');

    setup(async () => {
        // Create a unique temp directory for this test run
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'terminalEnvVarInjector-test-'));

        // Stub workspace configuration
        mockGetConfiguration = sinon.stub(workspaceApis, 'getConfiguration');
        const mockConfig = {
            get: sinon.stub(),
        };
        mockConfig.get.withArgs('terminal.useEnvFile', false).returns(true);
        mockConfig.get.withArgs('envFile').returns(undefined);
        mockGetConfiguration.returns(mockConfig);

        // Track scoped collections per workspace
        scopedCollectionStubs = new Map();

        // Mock GlobalEnvironmentVariableCollection
        mockEnvVarCollection = {
            getScoped: (scope: { workspaceFolder: WorkspaceFolder }) => {
                const key = scope.workspaceFolder.uri.fsPath;
                if (!scopedCollectionStubs.has(key)) {
                    scopedCollectionStubs.set(key, {
                        replace: sinon.stub(),
                        delete: sinon.stub(),
                        clear: sinon.stub(),
                        get: sinon.stub(),
                    });
                }
                return scopedCollectionStubs.get(key)!;
            },
            clear: sinon.stub(),
        } as unknown as GlobalEnvironmentVariableCollection;

        // Create PythonEnvVariableManager instance with mock project manager
        const mockProjectManager = {
            get: sinon.stub().returns(undefined),
        };
        envVarManager = new PythonEnvVariableManager(mockProjectManager as unknown as PythonProjectManager);
    });

    teardown(async () => {
        sinon.restore();
        injector?.dispose();

        // Clean up temp directory
        if (tempDir && (await fs.pathExists(tempDir))) {
            await fs.remove(tempDir);
        }
    });

    async function copyFixture(fixtureName: string, targetDir: string, targetName = '.env'): Promise<string> {
        const sourcePath = path.join(fixturesPath, fixtureName);
        const targetPath = path.join(targetDir, targetName);
        await fs.ensureDir(path.dirname(targetPath));
        await fs.copy(sourcePath, targetPath);
        return targetPath;
    }

    suite('File Existence Tests', () => {
        test('should inject variables when .env file exists', async () => {
            // Arrange - copy fixture to temp workspace
            const workspaceDir = path.join(tempDir, 'workspace1');
            await copyFixture('basic.env', workspaceDir);

            const workspaceFolder: WorkspaceFolder = {
                uri: Uri.file(workspaceDir),
                name: 'workspace1',
                index: 0,
            };

            injector = new TerminalEnvVarInjector(mockEnvVarCollection, envVarManager);

            // Act - trigger injection via the public initialize flow
            envVarManager['_onDidChangeEnvironmentVariables'].fire({
                uri: workspaceFolder.uri,
                changeType: FileChangeType.Changed,
            });

            // Wait for async operations
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Assert
            const stubs = scopedCollectionStubs.get(workspaceDir);
            assert.ok(stubs, 'Should have created scoped collection for workspace');
            assert.ok(stubs!.replace.calledWith('FOO', 'bar'), 'Should inject FOO');
            assert.ok(stubs!.replace.calledWith('BAR', 'baz'), 'Should inject BAR');
            assert.ok(stubs!.replace.calledWith('BAZ', 'qux'), 'Should inject BAZ');
        });

        test('should not inject when .env file does not exist', async () => {
            // Arrange - workspace without .env file
            const workspaceDir = path.join(tempDir, 'no-env-workspace');
            await fs.ensureDir(workspaceDir);

            const workspaceFolder: WorkspaceFolder = {
                uri: Uri.file(workspaceDir),
                name: 'no-env-workspace',
                index: 0,
            };

            injector = new TerminalEnvVarInjector(mockEnvVarCollection, envVarManager);

            // Act
            envVarManager['_onDidChangeEnvironmentVariables'].fire({
                uri: workspaceFolder.uri,
                changeType: FileChangeType.Changed,
            });

            await new Promise((resolve) => setTimeout(resolve, 100));

            // Assert
            const stubs = scopedCollectionStubs.get(workspaceDir);
            if (stubs) {
                assert.strictEqual(stubs.replace.called, false, 'Should not inject any variables');
            }
        });

        test('should use custom env file path when configured', async () => {
            // Arrange - copy custom fixture
            const workspaceDir = path.join(tempDir, 'custom-path-workspace');
            const customPath = path.join(workspaceDir, 'config', '.env.custom');
            await fs.ensureDir(path.dirname(customPath));
            await fs.copy(path.join(fixturesPath, 'custom-path', '.env.custom'), customPath);

            // Configure custom path
            const mockConfig = mockGetConfiguration.returnValues[0];
            mockConfig.get.withArgs('envFile').returns(customPath);

            const workspaceFolder: WorkspaceFolder = {
                uri: Uri.file(workspaceDir),
                name: 'custom-path-workspace',
                index: 0,
            };

            injector = new TerminalEnvVarInjector(mockEnvVarCollection, envVarManager);

            // Act
            envVarManager['_onDidChangeEnvironmentVariables'].fire({
                uri: workspaceFolder.uri,
                changeType: FileChangeType.Changed,
            });

            await new Promise((resolve) => setTimeout(resolve, 100));

            // Assert
            const stubs = scopedCollectionStubs.get(workspaceDir);
            assert.ok(stubs?.replace.calledWith('CUSTOM_VAR', 'custom_value'), 'Should inject from custom file');
        });
    });

    suite('Configuration Changes', () => {
        test('should cleanup tracked vars when useEnvFile is disabled after being enabled', async () => {
            // Arrange - Start with env file and injection enabled
            const workspaceDir = path.join(tempDir, 'disable-workspace');
            await copyFixture('basic.env', workspaceDir);

            const workspaceFolder: WorkspaceFolder = {
                uri: Uri.file(workspaceDir),
                name: 'disable-workspace',
                index: 0,
            };

            injector = new TerminalEnvVarInjector(mockEnvVarCollection, envVarManager);

            // Initial injection
            envVarManager['_onDidChangeEnvironmentVariables'].fire({
                uri: workspaceFolder.uri,
                changeType: FileChangeType.Changed,
            });
            await new Promise((resolve) => setTimeout(resolve, 100));

            const stubs = scopedCollectionStubs.get(workspaceDir)!;
            assert.ok(stubs.replace.calledWith('FOO', 'bar'), 'Initial FOO should be set');

            // Act - Disable useEnvFile
            const mockConfig = mockGetConfiguration.returnValues[0];
            mockConfig.get.withArgs('terminal.useEnvFile', false).returns(false);

            stubs.replace.resetHistory();
            stubs.delete.resetHistory();

            envVarManager['_onDidChangeEnvironmentVariables'].fire({
                uri: workspaceFolder.uri,
                changeType: FileChangeType.Changed,
            });
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Assert - Should cleanup previously tracked variables
            assert.ok(stubs.delete.calledWith('FOO'), 'Should delete FOO');
            assert.ok(stubs.delete.calledWith('BAR'), 'Should delete BAR');
            assert.ok(stubs.delete.calledWith('BAZ'), 'Should delete BAZ');
        });

        test('should cleanup tracked vars when .env file is deleted', async () => {
            // Arrange - Start with env file
            const workspaceDir = path.join(tempDir, 'delete-file-workspace');
            const envFilePath = await copyFixture('single-var.env', workspaceDir);

            const workspaceFolder: WorkspaceFolder = {
                uri: Uri.file(workspaceDir),
                name: 'delete-file-workspace',
                index: 0,
            };

            injector = new TerminalEnvVarInjector(mockEnvVarCollection, envVarManager);

            // Initial injection
            envVarManager['_onDidChangeEnvironmentVariables'].fire({
                uri: workspaceFolder.uri,
                changeType: FileChangeType.Changed,
            });
            await new Promise((resolve) => setTimeout(resolve, 100));

            const stubs = scopedCollectionStubs.get(workspaceDir)!;
            assert.ok(stubs.replace.calledWith('FOO', 'bar'), 'Initial FOO should be set');

            // Act - Delete the .env file
            await fs.remove(envFilePath);
            stubs.delete.resetHistory();

            envVarManager['_onDidChangeEnvironmentVariables'].fire({
                uri: workspaceFolder.uri,
                changeType: FileChangeType.Deleted,
            });
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Assert - Should cleanup
            assert.ok(stubs.delete.calledWith('FOO'), 'Should delete FOO after file deletion');
        });
    });

    suite('File Modification Scenarios', () => {
        test('Scenario: Commenting out a variable removes it from terminals', async () => {
            // Arrange - Start with basic.env
            const workspaceDir = path.join(tempDir, 'comment-workspace');
            const envFilePath = await copyFixture('basic.env', workspaceDir);

            const workspaceFolder: WorkspaceFolder = {
                uri: Uri.file(workspaceDir),
                name: 'comment-workspace',
                index: 0,
            };

            injector = new TerminalEnvVarInjector(mockEnvVarCollection, envVarManager);

            // Initial injection
            envVarManager['_onDidChangeEnvironmentVariables'].fire({
                uri: workspaceFolder.uri,
                changeType: FileChangeType.Changed,
            });
            await new Promise((resolve) => setTimeout(resolve, 100));

            const stubs = scopedCollectionStubs.get(workspaceDir)!;
            assert.ok(stubs.replace.calledWith('BAR', 'baz'), 'BAR should be initially set');

            // Act - Comment out BAR in the file
            await fs.writeFile(envFilePath, '# Basic .env file\nFOO=bar\n# BAR=baz\nBAZ=qux\n');

            stubs.replace.resetHistory();
            stubs.delete.resetHistory();

            envVarManager['_onDidChangeEnvironmentVariables'].fire({
                uri: workspaceFolder.uri,
                changeType: FileChangeType.Changed,
            });
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Assert - BAR should be deleted
            assert.ok(stubs.delete.calledWith('BAR'), 'Should delete commented out BAR');
            assert.ok(stubs.replace.calledWith('FOO', 'bar'), 'Should keep FOO');
            assert.ok(stubs.replace.calledWith('BAZ', 'qux'), 'Should keep BAZ');
        });

        test('Scenario: Adding a new variable injects it', async () => {
            // Arrange - Start with single var
            const workspaceDir = path.join(tempDir, 'add-var-workspace');
            const envFilePath = await copyFixture('single-var.env', workspaceDir);

            const workspaceFolder: WorkspaceFolder = {
                uri: Uri.file(workspaceDir),
                name: 'add-var-workspace',
                index: 0,
            };

            injector = new TerminalEnvVarInjector(mockEnvVarCollection, envVarManager);

            // Initial injection
            envVarManager['_onDidChangeEnvironmentVariables'].fire({
                uri: workspaceFolder.uri,
                changeType: FileChangeType.Changed,
            });
            await new Promise((resolve) => setTimeout(resolve, 100));

            const stubs = scopedCollectionStubs.get(workspaceDir)!;

            // Act - Add NEW_VAR to file
            await fs.appendFile(envFilePath, 'NEW_VAR=new_value\n');

            stubs.replace.resetHistory();

            envVarManager['_onDidChangeEnvironmentVariables'].fire({
                uri: workspaceFolder.uri,
                changeType: FileChangeType.Changed,
            });
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Assert
            assert.ok(stubs.replace.calledWith('NEW_VAR', 'new_value'), 'Should add NEW_VAR');
            assert.ok(stubs.replace.calledWith('FOO', 'bar'), 'Should keep FOO');
        });

        test('Scenario: Unsetting a variable (VAR=) removes it', async () => {
            // Arrange - Start with variables
            const workspaceDir = path.join(tempDir, 'unset-workspace');
            const envFilePath = await copyFixture('with-unset.env', workspaceDir);

            const workspaceFolder: WorkspaceFolder = {
                uri: Uri.file(workspaceDir),
                name: 'unset-workspace',
                index: 0,
            };

            injector = new TerminalEnvVarInjector(mockEnvVarCollection, envVarManager);

            // Initial injection
            envVarManager['_onDidChangeEnvironmentVariables'].fire({
                uri: workspaceFolder.uri,
                changeType: FileChangeType.Changed,
            });
            await new Promise((resolve) => setTimeout(resolve, 100));

            const stubs = scopedCollectionStubs.get(workspaceDir)!;
            assert.ok(stubs.replace.calledWith('TO_UNSET', 'value'), 'TO_UNSET should be initially set');

            // Act - Unset TO_UNSET (VAR=)
            await fs.writeFile(envFilePath, 'FOO=bar\nTO_UNSET=\n');

            stubs.delete.resetHistory();

            envVarManager['_onDidChangeEnvironmentVariables'].fire({
                uri: workspaceFolder.uri,
                changeType: FileChangeType.Changed,
            });
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Assert
            assert.ok(stubs.delete.calledWith('TO_UNSET'), 'Should delete unset variable');
        });
    });

    suite('Multi-Workspace Scenarios', () => {
        test('Scenario: Multiple workspaces maintain independent tracking', async () => {
            // Arrange - Two workspaces with different env files
            const workspace1Dir = path.join(tempDir, 'workspace1');
            const workspace2Dir = path.join(tempDir, 'workspace2');

            await copyFixture('workspace1/.env', workspace1Dir);
            await copyFixture('workspace2/.env', workspace2Dir);

            const workspaceFolder1: WorkspaceFolder = {
                uri: Uri.file(workspace1Dir),
                name: 'workspace1',
                index: 0,
            };

            const workspaceFolder2: WorkspaceFolder = {
                uri: Uri.file(workspace2Dir),
                name: 'workspace2',
                index: 1,
            };

            injector = new TerminalEnvVarInjector(mockEnvVarCollection, envVarManager);

            // Act - Inject for both workspaces
            envVarManager['_onDidChangeEnvironmentVariables'].fire({
                uri: workspaceFolder1.uri,
                changeType: FileChangeType.Changed,
            });
            envVarManager['_onDidChangeEnvironmentVariables'].fire({
                uri: workspaceFolder2.uri,
                changeType: FileChangeType.Changed,
            });
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Assert - Each workspace should have its own variables
            const stubs1 = scopedCollectionStubs.get(workspace1Dir)!;
            const stubs2 = scopedCollectionStubs.get(workspace2Dir)!;

            assert.ok(stubs1.replace.calledWith('WS1_VAR', 'workspace1_value'), 'Workspace 1 should have WS1_VAR');
            assert.strictEqual(stubs1.replace.calledWith('WS2_VAR'), false, 'Workspace 1 should not have WS2_VAR');

            assert.ok(stubs2.replace.calledWith('WS2_VAR', 'workspace2_value'), 'Workspace 2 should have WS2_VAR');
            assert.strictEqual(stubs2.replace.calledWith('WS1_VAR'), false, 'Workspace 2 should not have WS1_VAR');
        });
    });
});
