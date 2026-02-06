import * as assert from 'assert';
import { Uri } from 'vscode';
import {
    EnvManagerTreeItem,
    getEnvironmentParentDirName,
    PythonEnvTreeItem,
} from '../../../features/views/treeViewItems';
import { InternalEnvironmentManager, PythonEnvironmentImpl } from '../../../internal.api';

/**
 * Helper to create a mock PythonEnvironmentImpl with minimal required fields.
 * Reduces boilerplate in tests.
 */
function createMockEnvironment(options: {
    id?: string;
    managerId?: string;
    name?: string;
    displayName?: string;
    description?: string;
    environmentPath: string;
    hasActivation?: boolean;
}): PythonEnvironmentImpl {
    const envPath = options.environmentPath;
    return new PythonEnvironmentImpl(
        {
            id: options.id ?? 'test-env',
            managerId: options.managerId ?? 'ms-python.python:test-manager',
        },
        {
            name: options.name ?? '.venv (3.12)',
            displayName: options.displayName ?? options.name ?? '.venv (3.12)',
            description: options.description,
            displayPath: envPath,
            version: '3.12.1',
            environmentPath: Uri.file(envPath),
            execInfo: {
                run: { executable: envPath },
                ...(options.hasActivation && {
                    activation: [{ executable: envPath.replace('python', 'activate') }],
                }),
            },
            sysPrefix: envPath.includes('bin') ? envPath.replace('/bin/python', '') : envPath,
        },
    );
}

/**
 * Helper to create a mock InternalEnvironmentManager.
 */
function createMockManager(
    options: {
        id?: string;
        name?: string;
        displayName?: string;
        supportsCreate?: boolean;
        supportsRemove?: boolean;
    } = {},
): InternalEnvironmentManager {
    return new InternalEnvironmentManager(options.id ?? 'ms-python.python:test-manager', {
        name: options.name ?? 'test',
        displayName: options.displayName,
        description: 'test',
        preferredPackageManagerId: 'pip',
        refresh: () => Promise.resolve(),
        getEnvironments: () => Promise.resolve([]),
        resolve: () => Promise.resolve(undefined),
        set: () => Promise.resolve(),
        get: () => Promise.resolve(undefined),
        ...(options.supportsCreate && { create: () => Promise.resolve(undefined) }),
        ...(options.supportsRemove && { remove: () => Promise.resolve() }),
    });
}

suite('Test TreeView Items', () => {
    suite('EnvManagerTreeItem', () => {
        test('Context value excludes create when manager does not support it', () => {
            // Arrange
            const manager = createMockManager({ supportsCreate: false });

            // Act
            const item = new EnvManagerTreeItem(manager);

            // Assert
            assert.strictEqual(item.treeItem.contextValue, 'pythonEnvManager;ms-python.python:test-manager;');
        });

        test('Context value includes create when manager supports it', () => {
            // Arrange
            const manager = createMockManager({ supportsCreate: true });

            // Act
            const item = new EnvManagerTreeItem(manager);

            // Assert
            assert.strictEqual(item.treeItem.contextValue, 'pythonEnvManager;create;ms-python.python:test-manager;');
        });

        test('Uses name as label when displayName is not provided', () => {
            // Arrange
            const manager = createMockManager({ name: 'test-name' });

            // Act
            const item = new EnvManagerTreeItem(manager);

            // Assert
            assert.strictEqual(item.treeItem.label, 'test-name');
        });

        test('Uses displayName as label when provided', () => {
            // Arrange
            const manager = createMockManager({ name: 'test', displayName: 'Test Display Name' });

            // Act
            const item = new EnvManagerTreeItem(manager);

            // Assert
            assert.strictEqual(item.treeItem.label, 'Test Display Name');
        });
    });

    suite('PythonEnvTreeItem', () => {
        let managerWithoutRemove: EnvManagerTreeItem;
        let managerWithRemove: EnvManagerTreeItem;

        setup(() => {
            managerWithoutRemove = new EnvManagerTreeItem(createMockManager({ supportsRemove: false }));
            managerWithRemove = new EnvManagerTreeItem(createMockManager({ supportsRemove: true }));
        });

        test('Context value excludes remove and activatable when not supported', () => {
            // Arrange
            const env = createMockEnvironment({
                environmentPath: '/home/user/envs/.venv/bin/python',
                hasActivation: false,
            });

            // Act
            const item = new PythonEnvTreeItem(env, managerWithoutRemove);

            // Assert
            assert.strictEqual(item.treeItem.contextValue, 'pythonEnvironment;');
        });

        test('Context value includes activatable when environment has activation', () => {
            // Arrange
            const env = createMockEnvironment({
                environmentPath: '/home/user/envs/.venv/bin/python',
                hasActivation: true,
            });

            // Act
            const item = new PythonEnvTreeItem(env, managerWithoutRemove);

            // Assert
            assert.strictEqual(item.treeItem.contextValue, 'pythonEnvironment;activatable;');
        });

        test('Context value includes remove when manager supports it', () => {
            // Arrange
            const env = createMockEnvironment({
                environmentPath: '/home/user/envs/.venv/bin/python',
                hasActivation: true,
            });

            // Act
            const item = new PythonEnvTreeItem(env, managerWithRemove);

            // Assert
            assert.strictEqual(item.treeItem.contextValue, 'pythonEnvironment;remove;activatable;');
        });

        test('Uses environment displayName as tree item label', () => {
            // Arrange
            const env = createMockEnvironment({
                displayName: 'My Custom Env',
                environmentPath: '/home/user/envs/.venv/bin/python',
            });

            // Act
            const item = new PythonEnvTreeItem(env, managerWithoutRemove);

            // Assert
            assert.strictEqual(item.treeItem.label, 'My Custom Env');
        });

        test('Shows disambiguation suffix in description field, not in label', () => {
            // Arrange
            const env = createMockEnvironment({
                name: '.venv (3.12)',
                displayName: '.venv (3.12)',
                environmentPath: '/home/user/my-project/.venv/bin/python',
            });

            // Act
            const item = new PythonEnvTreeItem(env, managerWithoutRemove, undefined, 'my-project');

            // Assert
            assert.strictEqual(item.treeItem.label, '.venv (3.12)');
            assert.strictEqual(item.treeItem.description, 'my-project');
        });

        test('Description is undefined when no disambiguation suffix and no uv indicator', () => {
            // Arrange
            const env = createMockEnvironment({
                environmentPath: '/home/user/my-project/.venv/bin/python',
                description: undefined,
            });

            // Act
            const item = new PythonEnvTreeItem(env, managerWithoutRemove, undefined, undefined);

            // Assert
            assert.strictEqual(item.treeItem.description, undefined);
        });

        test('Shows [uv] indicator in description when environment is uv-managed', () => {
            // Arrange
            const env = createMockEnvironment({
                environmentPath: '/home/user/my-project/.venv/bin/python',
                description: 'uv',
            });

            // Act
            const item = new PythonEnvTreeItem(env, managerWithoutRemove, undefined, undefined);

            // Assert
            assert.strictEqual(item.treeItem.description, '[uv]');
        });

        test('Shows [uv] indicator combined with disambiguation suffix', () => {
            // Arrange
            const env = createMockEnvironment({
                environmentPath: '/home/user/my-project/.venv/bin/python',
                description: 'uv workspace',
            });

            // Act
            const item = new PythonEnvTreeItem(env, managerWithoutRemove, undefined, 'my-project');

            // Assert
            assert.strictEqual(item.treeItem.description, '[uv] my-project');
        });
    });

    suite('getEnvironmentParentDirName', () => {
        test('Extracts parent folder from Unix path with bin directory', () => {
            // Arrange
            const env = createMockEnvironment({
                environmentPath: '/home/user/my-project/.venv/bin/python',
            });

            // Act
            const result = getEnvironmentParentDirName(env);

            // Assert
            assert.strictEqual(result, 'my-project');
        });

        test('Extracts parent folder from Windows path with Scripts directory', () => {
            // Arrange
            const env = createMockEnvironment({
                environmentPath: 'C:\\Users\\bob\\backend\\.venv\\Scripts\\python.exe',
            });

            // Act
            const result = getEnvironmentParentDirName(env);

            // Assert
            assert.strictEqual(result, 'backend');
        });

        test('Extracts parent folder when environmentPath points to venv folder directly', () => {
            // Arrange
            const env = createMockEnvironment({
                environmentPath: '/home/user/api-service/.venv',
            });

            // Act
            const result = getEnvironmentParentDirName(env);

            // Assert
            assert.strictEqual(result, 'api-service');
        });

        test('Works correctly with deeply nested project paths', () => {
            // Arrange
            const env = createMockEnvironment({
                environmentPath: '/home/user/code/projects/monorepo/packages/backend/.venv/bin/python',
            });

            // Act
            const result = getEnvironmentParentDirName(env);

            // Assert
            assert.strictEqual(result, 'backend');
        });

        test('Handles paths with spaces in folder names', () => {
            // Arrange
            const env = createMockEnvironment({
                environmentPath: '/home/user/My Project/.venv/bin/python',
            });

            // Act
            const result = getEnvironmentParentDirName(env);

            // Assert
            assert.strictEqual(result, 'My Project');
        });

        test('Handles venv folders with custom names', () => {
            // Arrange
            const env = createMockEnvironment({
                environmentPath: '/home/user/myapp/virtualenv/bin/python',
            });

            // Act
            const result = getEnvironmentParentDirName(env);

            // Assert
            assert.strictEqual(result, 'myapp');
        });
    });
});
