import * as assert from 'assert';
import { ThemeIcon } from 'vscode';
import { CopyFeedbackManager, initializeCopyFeedbackManager, disposeCopyFeedbackManager } from '../../features/copyFeedback';
import {
    ProjectItem,
    ProjectEnvironment,
    PythonEnvTreeItem,
    EnvManagerTreeItem,
} from '../../features/views/treeViewItems';
import { Uri } from 'vscode';
import { PythonEnvironment } from '../../api';
import { InternalEnvironmentManager } from '../../internal.api';

suite('Copy Feedback Tests', () => {
    let copyFeedbackManager: CopyFeedbackManager;

    setup(() => {
        copyFeedbackManager = initializeCopyFeedbackManager(100); // Short timeout for tests
    });

    teardown(() => {
        disposeCopyFeedbackManager();
    });

    test('CopyFeedbackManager marks and checks items correctly', () => {
        const itemId = 'test-item';
        
        // Initially not copied
        assert.strictEqual(copyFeedbackManager.isRecentlyCopied(itemId), false);
        
        // Mark as copied
        copyFeedbackManager.markAsCopied(itemId);
        
        // Should now be marked as copied
        assert.strictEqual(copyFeedbackManager.isRecentlyCopied(itemId), true);
    });

    test('CopyFeedbackManager times out correctly', (done) => {
        const itemId = 'test-item';
        
        copyFeedbackManager.markAsCopied(itemId);
        assert.strictEqual(copyFeedbackManager.isRecentlyCopied(itemId), true);
        
        // Wait for timeout to expire
        setTimeout(() => {
            assert.strictEqual(copyFeedbackManager.isRecentlyCopied(itemId), false);
            done();
        }, 150); // Timeout is 100ms, so wait 150ms
    });

    test('CopyFeedbackManager fires events', (done) => {
        const itemId = 'test-item';
        let eventFired = false;
        
        copyFeedbackManager.onDidChangeCopiedState((id: string) => {
            if (id === itemId && !eventFired) {
                eventFired = true;
                done();
            }
        });
        
        copyFeedbackManager.markAsCopied(itemId);
    });

    test('ProjectItem uses checkmark icon when recently copied', () => {
        const uri = Uri.file('/test');
        const project = { name: 'test', uri };
        
        // Mark project as copied
        const itemId = ProjectItem.getId(project);
        copyFeedbackManager.markAsCopied(itemId);
        
        // Create project item - should use checkmark icon
        const item = new ProjectItem(project);
        
        assert.ok(item.treeItem.iconPath instanceof ThemeIcon);
        assert.strictEqual((item.treeItem.iconPath as ThemeIcon).id, 'check');
    });

    test('ProjectEnvironment uses checkmark icon when recently copied', () => {
        const uri = Uri.file('/test');
        const project = { name: 'test', uri };
        const projectItem = new ProjectItem(project);
        
        const environment = {
            envId: { managerId: 'test-manager', id: 'env1' },
            name: 'env1',
            displayName: 'Environment 1',
            displayPath: '/test-env',
            execInfo: { run: { executable: '/test-env/bin/test', args: ['-m', 'env'] } },
        } as PythonEnvironment;
        
        // Mark environment as copied
        const envItem = new ProjectEnvironment(projectItem, environment);
        copyFeedbackManager.markAsCopied(envItem.id);
        
        // Create new environment item - should use checkmark icon
        const newEnvItem = new ProjectEnvironment(projectItem, environment);
        
        assert.ok(newEnvItem.treeItem.iconPath instanceof ThemeIcon);
        assert.strictEqual((newEnvItem.treeItem.iconPath as ThemeIcon).id, 'check');
    });

    test('PythonEnvTreeItem uses checkmark icon when recently copied', () => {
        const environment = {
            envId: { managerId: 'test-manager', id: 'env1' },
            name: 'env1',
            displayName: 'Environment 1',
            displayPath: '/test-env',
            execInfo: { run: { executable: '/test-env/bin/test', args: ['-m', 'env'] } },
        } as PythonEnvironment;
        
        const managerItem = new EnvManagerTreeItem({ name: 'test-manager', id: 'test-manager' } as InternalEnvironmentManager);
        
        // Mark environment as copied with the expected ID format
        const itemId = `env-${environment.envId.id}`;
        copyFeedbackManager.markAsCopied(itemId);
        
        // Create environment item - should use checkmark icon
        const item = new PythonEnvTreeItem(environment, managerItem);
        
        assert.ok(item.treeItem.iconPath instanceof ThemeIcon);
        assert.strictEqual((item.treeItem.iconPath as ThemeIcon).id, 'check');
    });

    test('Items use original icon when not recently copied', () => {
        const uri = Uri.file('/test');
        const project = { name: 'test', uri, iconPath: new ThemeIcon('folder') };
        
        // Create project item without marking as copied
        const item = new ProjectItem(project);
        
        // Should use original icon, not checkmark
        assert.ok(item.treeItem.iconPath instanceof ThemeIcon);
        assert.strictEqual((item.treeItem.iconPath as ThemeIcon).id, 'folder');
    });
});