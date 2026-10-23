import * as assert from 'assert';
import * as sinon from 'sinon';
import * as typeMoq from 'typemoq';
import { EventEmitter, TreeView, Uri } from 'vscode';
import { PythonEnvironment } from '../../../api';
import * as windowApis from '../../../common/window.apis';
import { EnvManagerView, computeDisambiguationSuffixes } from '../../../features/views/envManagersView';
import { SYSTEM_MANAGER_ID, VENV_MANAGER_ID } from '../../../common/constants';
import { ITemporaryStateManager } from '../../../features/views/temporaryStateManager';
import { EnvTreeItem } from '../../../features/views/treeViewItems';
import type {
    DidChangeEnvironmentManagerEventArgs,
    DidChangePackageManagerEventArgs,
    EnvironmentManagers,
    InternalDidChangeEnvironmentsEventArgs,
    InternalDidChangePackagesEventArgs,
} from '../../../features/envManagers';
import type { InternalEnvironmentManager } from '../../../managers/common/registeredManagers';
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
    let onDidChangeProjectPackageManagerEmitter: EventEmitter<void>;
    let onDidChangeStateEmitter: EventEmitter<{ itemId: string; stateKey: string }>;

    setup(() => {
        // Create event emitters
        onDidChangeEnvironmentsEmitter = new EventEmitter();
        onDidChangeEnvironmentManagerEmitter = new EventEmitter();
        onDidChangePackagesEmitter = new EventEmitter();
        onDidChangePackageManagerEmitter = new EventEmitter();
        onDidChangeProjectPackageManagerEmitter = new EventEmitter();
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
        envManagers
            .setup((e) => e.getPackageManager(typeMoq.It.isAny()))
            .returns(() => undefined);
        envManagers
            .setup((e) => e.onDidChangeProjectPackageManager)
            .returns(() => onDidChangeProjectPackageManagerEmitter.event);
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
        onDidChangeProjectPackageManagerEmitter.dispose();
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

    test('Refreshes the tree when a project-scoped package manager is invalidated', () => {
        const clock = sinon.useFakeTimers();
        const view = new EnvManagerView(envManagers.object, stateManager.object);
        const changed = sinon.stub();
        const listener = view.onDidChangeTreeData(changed);

        onDidChangeProjectPackageManagerEmitter.fire();
        clock.tick(500);

        assert.ok(changed.calledOnce);
        listener.dispose();
        view.dispose();
    });
});


suite('computeDisambiguationSuffixes Tests', () => {
    function createTestEnv(options: {
        id: string;
        managerId: string;
        name: string;
        displayName?: string;
        execPath: string;
    }): PythonEnvironment {
        return {
            envId: {
                id: options.id,
                managerId: options.managerId,
            },
            name: options.name,
            displayName: options.displayName ?? options.name,
            displayPath: options.execPath,
            version: '3.13.0',
            environmentPath: Uri.file(options.execPath),
            execInfo: {
                run: { executable: options.execPath },
            },
            sysPrefix: options.execPath,
        };
    }

    test('Differentiates multiple uv global launchers in same directory by executable name (Fixes #1893)', () => {
        const env1 = createTestEnv({
            id: 'uv-python',
            managerId: SYSTEM_MANAGER_ID,
            name: 'Python 3.13.15',
            execPath: 'C:\\Users\\kanadig\\.local\\bin\\python.exe',
        });
        const env2 = createTestEnv({
            id: 'uv-python3',
            managerId: SYSTEM_MANAGER_ID,
            name: 'Python 3.13.15',
            execPath: 'C:\\Users\\kanadig\\.local\\bin\\python3.exe',
        });
        const env3 = createTestEnv({
            id: 'uv-python3.13',
            managerId: SYSTEM_MANAGER_ID,
            name: 'Python 3.13.15',
            execPath: 'C:\\Users\\kanadig\\.local\\bin\\python3.13.exe',
        });

        const suffixes = computeDisambiguationSuffixes([env1, env2, env3]);

        assert.strictEqual(suffixes.get('uv-python'), 'python.exe');
        assert.strictEqual(suffixes.get('uv-python3'), 'python3.exe');
        assert.strictEqual(suffixes.get('uv-python3.13'), 'python3.13.exe');
        for (const suffix of suffixes.values()) {
            assert.notStrictEqual(suffix, 'kanadig');
            assert.notStrictEqual(suffix, 'bin');
        }
    });

    test('Differentiates regular and free-threaded system interpreters in /usr/bin by executable name', () => {
        const envRegular = createTestEnv({
            id: 'fedora-regular',
            managerId: SYSTEM_MANAGER_ID,
            name: 'Python 3.13.13',
            execPath: '/usr/bin/python3.13',
        });
        const envFreeThreaded = createTestEnv({
            id: 'fedora-freethreaded',
            managerId: SYSTEM_MANAGER_ID,
            name: 'Python 3.13.13',
            execPath: '/usr/bin/python3.13t',
        });

        const suffixes = computeDisambiguationSuffixes([envRegular, envFreeThreaded]);

        assert.strictEqual(suffixes.get('fedora-regular'), 'python3.13');
        assert.strictEqual(suffixes.get('fedora-freethreaded'), 'python3.13t');
        assert.notStrictEqual(suffixes.get('fedora-regular'), 'bin');
        assert.notStrictEqual(suffixes.get('fedora-freethreaded'), 'bin');
    });

    test('Differentiates pythoncore installations by distinguishing directory without AppData', () => {
        const env1 = createTestEnv({
            id: 'core-64',
            managerId: SYSTEM_MANAGER_ID,
            name: 'Python 3.14.0',
            execPath: 'C:\\Users\\test\\AppData\\Local\\Python\\pythoncore-3.14-64\\python.exe',
        });
        const env2 = createTestEnv({
            id: 'core-64t',
            managerId: SYSTEM_MANAGER_ID,
            name: 'Python 3.14.0',
            execPath: 'C:\\Users\\test\\AppData\\Local\\Python\\pythoncore-3.14t-64\\python3.14t.exe',
        });

        const suffixes = computeDisambiguationSuffixes([env1, env2]);

        assert.strictEqual(suffixes.get('core-64'), 'pythoncore-3.14-64');
        assert.strictEqual(suffixes.get('core-64t'), 'pythoncore-3.14t-64');
        assert.notStrictEqual(suffixes.get('core-64'), 'AppData');
        assert.notStrictEqual(suffixes.get('core-64t'), 'AppData');
    });

    test('Differentiates global interpreters across bin locations using distinguishing path', () => {
        const env1 = createTestEnv({
            id: 'usr-bin',
            managerId: SYSTEM_MANAGER_ID,
            name: 'Python 3.13.0',
            execPath: '/usr/bin/python3.13',
        });
        const env2 = createTestEnv({
            id: 'usr-local-bin',
            managerId: SYSTEM_MANAGER_ID,
            name: 'Python 3.13.0',
            execPath: '/usr/local/bin/python3.13',
        });
        const env3 = createTestEnv({
            id: 'opt-homebrew-bin',
            managerId: SYSTEM_MANAGER_ID,
            name: 'Python 3.13.0',
            execPath: '/opt/homebrew/bin/python3.13',
        });

        const suffixes = computeDisambiguationSuffixes([env1, env2, env3]);

        assert.strictEqual(suffixes.get('usr-bin'), 'usr/bin');
        assert.strictEqual(suffixes.get('usr-local-bin'), 'local/bin');
        assert.strictEqual(suffixes.get('opt-homebrew-bin'), 'homebrew/bin');
        for (const suffix of suffixes.values()) {
            assert.notStrictEqual(suffix, 'usr');
            assert.notStrictEqual(suffix, 'bin');
            assert.notStrictEqual(suffix, 'opt');
        }
    });

    test('Preserves project parent folder names for virtual environments', () => {
        const env1 = createTestEnv({
            id: 'project-a-venv',
            managerId: VENV_MANAGER_ID,
            name: '.venv (3.12)',
            execPath: '/home/user/alice/.venv/bin/python',
        });
        const env2 = createTestEnv({
            id: 'project-b-venv',
            managerId: VENV_MANAGER_ID,
            name: '.venv (3.12)',
            execPath: '/home/user/bob/.venv/bin/python',
        });

        const suffixes = computeDisambiguationSuffixes([env1, env2]);

        assert.strictEqual(suffixes.get('project-a-venv'), 'alice');
        assert.strictEqual(suffixes.get('project-b-venv'), 'bob');
    });

    test('Does not add suffix for environments with unique base names', () => {
        const env1 = createTestEnv({
            id: 'python-312',
            managerId: SYSTEM_MANAGER_ID,
            name: 'Python 3.12.0',
            execPath: '/usr/bin/python3.12',
        });
        const env2 = createTestEnv({
            id: 'python-313',
            managerId: SYSTEM_MANAGER_ID,
            name: 'Python 3.13.0',
            execPath: '/usr/bin/python3.13',
        });

        const suffixes = computeDisambiguationSuffixes([env1, env2]);

        assert.strictEqual(suffixes.size, 0);
    });
});
