import * as assert from 'assert';
import { EventEmitter } from 'vscode';
import { SitePackagesWatcherService } from '../../../features/packageWatcher/sitePackagesWatcherService';
import { EnvironmentManagers } from '../../../internal.api';

suite('Site-Packages Watcher Service', () => {
    let mockEnvironmentManagers: EnvironmentManagers;

    setup(() => {
        const mockEventEmitter = new EventEmitter<any>();
        
        // Create a minimal mock of EnvironmentManagers
        mockEnvironmentManagers = {
            managers: [],
            packageManagers: [],
            onDidChangeEnvironments: mockEventEmitter.event,
            getPackageManager: () => undefined,
            dispose: () => {}
        } as any;
    });

    test('should initialize and dispose properly', () => {
        const watcher = new SitePackagesWatcherService(mockEnvironmentManagers);
        
        // Should not throw during initialization
        assert.ok(watcher);
        
        // Should not throw during disposal
        watcher.dispose();
    });

    test('should be disposable', () => {
        const watcher = new SitePackagesWatcherService(mockEnvironmentManagers);
        
        // Verify the service implements Disposable interface
        assert.ok(typeof watcher.dispose === 'function');
        
        // Clean up
        watcher.dispose();
    });
});