import * as sinon from 'sinon';
import * as typeMoq from 'typemoq';
import { EventEmitter, TreeView, Uri } from 'vscode';
import { PythonEnvironment } from '../../../api';
import * as windowApis from '../../../common/window.apis';
import { EnvManagerView } from '../../../features/views/envManagersView';
import { ITemporaryStateManager } from '../../../features/views/temporaryStateManager';
import { EnvTreeItem } from '../../../features/views/treeViewItems';
import {
    DidChangeEnvironmentManagerEventArgs,
    DidChangePackageManagerEventArgs,
    EnvironmentManagers,
    InternalDidChangeEnvironmentsEventArgs,
    InternalDidChangePackagesEventArgs,
    InternalEnvironmentManager,
} from '../../../internal.api';
import { setupNonThenable } from '../../mocks/helper';

suite('EnvManagerView.reveal Tests', () => {
    let envManagers: typeMoq.IMock<EnvironmentManagers>;
    let stateManager: typeMoq.IMock<ITemporaryStateManager>;
    let manager: typeMoq.IMock<InternalEnvironmentManager>;
    let treeView: typeMoq.IMock<TreeView<EnvTreeItem>>;
    let createTreeViewStub: sinon.SinonStub;

    // Event emitters for EnvironmentManagers
    let onDidChangeEnvironmentsEmitter: EventEmitter<InternalDidChangeEnvironmentsEventArgs>;
    let onDidChangeEnvironmentManagerEmitter: EventEmitter<DidChangeEnvironmentManagerEventArgs>;
    let onDidChangePackagesEmitter: EventEmitter<InternalDidChangePackagesEventArgs>;
    let onDidChangePackageManagerEmitter: EventEmitter<DidChangePackageManagerEventArgs>;
    let onDidChangeStateEmitter: EventEmitter<{ itemId: string; stateKey: string }>;

    setup(() => {
        // Create event emitters
        onDidChangeEnvironmentsEmitter = new EventEmitter();
        onDidChangeEnvironmentManagerEmitter = new EventEmitter();
        onDidChangePackagesEmitter = new EventEmitter();
        onDidChangePackageManagerEmitter = new EventEmitter();
        onDidChangeStateEmitter = new EventEmitter();

        // Mock manager
        manager = typeMoq.Mock.ofType<InternalEnvironmentManager>();
        manager.setup((m) => m.id).returns(() => 'test-manager');
        manager.setup((m) => m.displayName).returns(() => 'Test Manager');
        setupNonThenable(manager);

        // Mock environment managers
        envManagers = typeMoq.Mock.ofType<EnvironmentManagers>();
        envManagers.setup((e) => e.managers).returns(() => [manager.object]);
        envManagers.setup((e) => e.onDidChangeEnvironments).returns(() => onDidChangeEnvironmentsEmitter.event);
        envManagers
            .setup((e) => e.onDidChangeEnvironmentManager)
            .returns(() => onDidChangeEnvironmentManagerEmitter.event);
        envManagers.setup((e) => e.onDidChangePackages).returns(() => onDidChangePackagesEmitter.event);
        envManagers.setup((e) => e.onDidChangePackageManager).returns(() => onDidChangePackageManagerEmitter.event);
        setupNonThenable(envManagers);

        // Mock state manager
        stateManager = typeMoq.Mock.ofType<ITemporaryStateManager>();
        stateManager.setup((s) => s.onDidChangeState).returns(() => onDidChangeStateEmitter.event);
        setupNonThenable(stateManager);

        // Mock tree view
        treeView = typeMoq.Mock.ofType<TreeView<EnvTreeItem>>();
        treeView.setup((t) => t.visible).returns(() => true);
        setupNonThenable(treeView);

        // Stub window.createTreeView
        createTreeViewStub = sinon.stub(windowApis, 'createTreeView').returns(treeView.object);
    });

    teardown(() => {
        sinon.restore();
        onDidChangeEnvironmentsEmitter.dispose();
        onDidChangeEnvironmentManagerEmitter.dispose();
        onDidChangePackagesEmitter.dispose();
        onDidChangePackageManagerEmitter.dispose();
        onDidChangeStateEmitter.dispose();
    });

    test('Reveals environment without group by expanding manager', async () => {
        // Mock
        const environment: PythonEnvironment = {
            envId: { id: 'env-id', managerId: 'test-manager' },
            name: 'test-env',
            displayName: 'Test Environment',
            displayPath: '/path/to/env',
            version: '3.10.0',
            environmentPath: Uri.file('/path/to/env'),
            execInfo: { run: { executable: '/path/to/python' }, activatedRun: { executable: '/path/to/python' } },
            sysPrefix: '/path/to/env',
        };

        envManagers.setup((e) => e.getEnvironmentManager(environment)).returns(() => manager.object);
        manager.setup((m) => m.getEnvironments('all')).returns(() => Promise.resolve([environment]));

        treeView
            .setup((t) =>
                t.reveal(typeMoq.It.isAny(), typeMoq.It.isObjectWith({ expand: false, focus: true, select: true })),
            )
            .returns(() => Promise.resolve())
            .verifiable(typeMoq.Times.once());

        const view = new EnvManagerView(envManagers.object, stateManager.object);

        // Run
        await view.reveal(environment);

        // Assert
        treeView.verifyAll();

        view.dispose();
    });

    test('Reveals environment with string group by expanding manager and group', async () => {
        // Mock
        const environment: PythonEnvironment = {
            envId: { id: 'env-id', managerId: 'test-manager' },
            name: 'test-env',
            displayName: 'Test Environment',
            displayPath: '/path/to/env',
            version: '3.10.0',
            environmentPath: Uri.file('/path/to/env'),
            execInfo: { run: { executable: '/path/to/python' }, activatedRun: { executable: '/path/to/python' } },
            sysPrefix: '/path/to/env',
            group: 'TestGroup',
        };

        envManagers.setup((e) => e.getEnvironmentManager(environment)).returns(() => manager.object);
        manager.setup((m) => m.getEnvironments('all')).returns(() => Promise.resolve([environment]));

        treeView
            .setup((t) =>
                t.reveal(typeMoq.It.isAny(), typeMoq.It.isObjectWith({ expand: false, focus: true, select: true })),
            )
            .returns(() => Promise.resolve())
            .verifiable(typeMoq.Times.once());

        const view = new EnvManagerView(envManagers.object, stateManager.object);

        // Run
        await view.reveal(environment);

        // Assert
        treeView.verifyAll();

        view.dispose();
    });

    test('Reveals environment with EnvironmentGroupInfo group', async () => {
        // Mock
        const environment: PythonEnvironment = {
            envId: { id: 'env-id', managerId: 'test-manager' },
            name: 'test-env',
            displayName: 'Test Environment',
            displayPath: '/path/to/env',
            version: '3.10.0',
            environmentPath: Uri.file('/path/to/env'),
            execInfo: { run: { executable: '/path/to/python' }, activatedRun: { executable: '/path/to/python' } },
            sysPrefix: '/path/to/env',
            group: { name: 'GroupName', description: 'Group Description' },
        };

        envManagers.setup((e) => e.getEnvironmentManager(environment)).returns(() => manager.object);
        manager.setup((m) => m.getEnvironments('all')).returns(() => Promise.resolve([environment]));

        treeView
            .setup((t) =>
                t.reveal(typeMoq.It.isAny(), typeMoq.It.isObjectWith({ expand: false, focus: true, select: true })),
            )
            .returns(() => Promise.resolve())
            .verifiable(typeMoq.Times.once());

        const view = new EnvManagerView(envManagers.object, stateManager.object);

        // Run
        await view.reveal(environment);

        // Assert
        treeView.verifyAll();

        view.dispose();
    });

    test('Does not call treeView.reveal when tree view is not visible', async () => {
        // Mock - tree view not visible
        treeView.reset();
        treeView.setup((t) => t.visible).returns(() => false);
        setupNonThenable(treeView);

        const environment: PythonEnvironment = {
            envId: { id: 'env-id', managerId: 'test-manager' },
            name: 'test-env',
            displayName: 'Test Environment',
            displayPath: '/path/to/env',
            version: '3.10.0',
            environmentPath: Uri.file('/path/to/env'),
            execInfo: { run: { executable: '/path/to/python' }, activatedRun: { executable: '/path/to/python' } },
            sysPrefix: '/path/to/env',
        };

        envManagers.setup((e) => e.getEnvironmentManager(environment)).returns(() => manager.object);
        manager.setup((m) => m.getEnvironments('all')).returns(() => Promise.resolve([environment]));

        // Re-stub createTreeView to return the updated mock
        createTreeViewStub.restore();
        createTreeViewStub = sinon.stub(windowApis, 'createTreeView').returns(treeView.object);

        const view = new EnvManagerView(envManagers.object, stateManager.object);

        treeView.setup((t) => t.reveal(typeMoq.It.isAny(), typeMoq.It.isAny())).verifiable(typeMoq.Times.never());

        // Run
        await view.reveal(environment);

        // Assert - reveal should not be called when not visible
        treeView.verifyAll();

        view.dispose();
    });
});
