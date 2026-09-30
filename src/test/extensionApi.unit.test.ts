import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventEmitter, Uri } from 'vscode';
import { PythonEnvironment, PythonProject } from '../api';
import * as environmentPickers from '../common/pickers/environments';
import * as windowApis from '../common/window.apis';
import * as managerReady from '../features/common/managerReady';
import { PythonEnvironmentApiImpl } from '../extensionApi';
import type { PythonProjectManager } from '../features/projectManager';
import type { InternalEnvironmentManager, InternalPackageManager } from '../managers/common/registeredManagers';

suite('PythonEnvironmentApiImpl - onDidChangePythonProjects', () => {
    test('fires event with correct added and removed projects', () => {
        const onDidChangeProjectsEmitter = new EventEmitter<void>();
        let currentProjects: PythonProject[] = [];
        const mockProjectManager = {
            getProjects: () => currentProjects,
            onDidChangeProjects: onDidChangeProjectsEmitter.event,
        } as unknown as PythonProjectManager;

        type ApiArgs = ConstructorParameters<typeof PythonEnvironmentApiImpl>;
        const mockEnvManagers = {
            onDidChangeActiveEnvironment: new EventEmitter().event,
            onDidChangePackageProviderPackages: new EventEmitter().event,
        } as unknown as ApiArgs[0];
        const mockProjectCreators = {} as unknown as ApiArgs[2];
        const mockTerminalManager = {} as unknown as ApiArgs[3];
        const mockEnvVarManager = { onDidChangeEnvironmentVariables: new EventEmitter().event } as unknown as ApiArgs[4];

        const api = new PythonEnvironmentApiImpl(
            mockEnvManagers,
            mockProjectManager,
            mockProjectCreators,
            mockTerminalManager,
            mockEnvVarManager,
        );

        let firedEventPayload: unknown = null;
        api.onDidChangePythonProjects((event: unknown) => {
            firedEventPayload = event;
        });

        const newProject = { uri: Uri.joinPath(Uri.file(process.cwd()), 'fake', 'path') } as unknown as PythonProject;
        currentProjects = [newProject];
        onDidChangeProjectsEmitter.fire();

        assert.ok(firedEventPayload, 'Event should have fired');
        assert.strictEqual((firedEventPayload as { added: PythonProject[] }).added.length, 1);
        assert.strictEqual((firedEventPayload as { added: PythonProject[] }).added[0].uri.fsPath, newProject.uri.fsPath);
        assert.strictEqual((firedEventPayload as { removed: PythonProject[] }).removed.length, 0);

        firedEventPayload = null;
        currentProjects = [];
        onDidChangeProjectsEmitter.fire();

        assert.ok(firedEventPayload, 'Event should have fired');
        assert.strictEqual((firedEventPayload as { added: PythonProject[] }).added.length, 0);
        assert.strictEqual((firedEventPayload as { removed: PythonProject[] }).removed.length, 1);
        assert.strictEqual(
            (firedEventPayload as { removed: PythonProject[] }).removed[0].uri.fsPath,
            newProject.uri.fsPath,
        );
    });
});

suite('PythonEnvironmentApiImpl - getEnvironment timeout fallback', () => {
    let clock: sinon.SinonFakeTimers;

    setup(() => {
        clock = sinon.useFakeTimers();
        sinon.stub(managerReady, 'waitForEnvManager').resolves();
    });

    teardown(() => {
        sinon.restore();
    });

    test('returns the last-known environment while a slower lookup continues in the background', async () => {
        const scope = Uri.file('/workspace/script.py');
        const lastKnown: PythonEnvironment = {
            envId: { id: 'default', managerId: 'ms-python.python:venv' },
            name: 'default',
            displayName: 'default',
            displayPath: '/env/default',
            version: '3.11.0',
            environmentPath: Uri.file('/env/default'),
            execInfo: { run: { executable: '/env/default/python', args: [] } },
            sysPrefix: '/env/default',
        };
        let resolveEnvironment: ((value: PythonEnvironment | undefined) => void) | undefined;

        const mockProjectManager = {
            getProjects: () => [],
            onDidChangeProjects: new EventEmitter<void>().event,
        } as unknown as PythonProjectManager;

        type ApiArgs = ConstructorParameters<typeof PythonEnvironmentApiImpl>;
        const mockEnvManagers = {
            onDidChangeActiveEnvironment: new EventEmitter().event,
            onDidChangePackageProviderPackages: new EventEmitter().event,
            getEnvironment: sinon.stub().returns(
                new Promise<PythonEnvironment | undefined>((resolve) => {
                    resolveEnvironment = resolve;
                }),
            ),
            getLastKnownEnvironment: sinon.stub().withArgs(scope).returns(lastKnown),
            getEnvironmentManager: sinon.stub().returns({ id: 'ms-python.python:venv' }),
        } as unknown as ApiArgs[0];
        const mockProjectCreators = {} as unknown as ApiArgs[2];
        const mockTerminalManager = {} as unknown as ApiArgs[3];
        const mockEnvVarManager = { onDidChangeEnvironmentVariables: new EventEmitter().event } as unknown as ApiArgs[4];

        const api = new PythonEnvironmentApiImpl(
            mockEnvManagers,
            mockProjectManager,
            mockProjectCreators,
            mockTerminalManager,
            mockEnvVarManager,
        );

        const pending = api.getEnvironment(scope);
        await clock.tickAsync(1_000);

        assert.strictEqual(await pending, lastKnown);
        resolveEnvironment?.(undefined);
    });

    test('waits for the real resolution for inline-script scopes instead of serving last-known', async () => {
        const scope = Uri.file('/w/script.py');
        const lastKnown = {
            name: 'stale',
            displayName: 'stale',
            displayPath: '/env/stale',
            version: '3.12.0',
            environmentPath: Uri.file('/env/stale'),
            execInfo: { run: { executable: '/env/stale/python', args: [] } },
            sysPrefix: '/env/stale',
        } as unknown as PythonEnvironment;
        let resolveEnvironment: ((value: PythonEnvironment | undefined) => void) | undefined;

        type ApiArgs = ConstructorParameters<typeof PythonEnvironmentApiImpl>;
        const mockEnvManagers = {
            onDidChangeActiveEnvironment: new EventEmitter().event,
            onDidChangePackageProviderPackages: new EventEmitter().event,
            getEnvironment: sinon.stub().returns(
                new Promise<PythonEnvironment | undefined>((resolve) => {
                    resolveEnvironment = resolve;
                }),
            ),
            getLastKnownEnvironment: sinon.stub().returns(lastKnown),
            getEnvironmentManager: sinon.stub().returns({ id: 'ms-python.python:inline-script' }),
        } as unknown as ApiArgs[0];

        const api = new PythonEnvironmentApiImpl(
            mockEnvManagers,
            { getProjects: () => [], onDidChangeProjects: new EventEmitter<void>().event } as unknown as ApiArgs[1],
            {} as unknown as ApiArgs[2],
            {} as unknown as ApiArgs[3],
            { onDidChangeEnvironmentVariables: new EventEmitter().event } as unknown as ApiArgs[4],
        );

        const pending = api.getEnvironment(scope);
        await clock.tickAsync(2_000);
        // The manager withheld the environment; serving last-known would hand back exactly the
        // descriptor that decision rejected.
        resolveEnvironment?.(undefined);

        assert.strictEqual(await pending, undefined);
    });
});

suite('PythonEnvironmentApiImpl - package resolution', () => {
    setup(() => {
        sinon.stub(managerReady, 'waitForEnvManagerId').resolves();
        sinon.stub(managerReady, 'waitForAllEnvManagers').resolves();
    });

    teardown(() => {
        sinon.restore();
    });

    function createApi(manager: InternalPackageManager | undefined): {
        api: PythonEnvironmentApiImpl;
        getEnvironmentManager: sinon.SinonStub;
        getPackageManager: sinon.SinonStub;
    } {
        type ApiArgs = ConstructorParameters<typeof PythonEnvironmentApiImpl>;
        const getEnvironmentManager = sinon.stub();
        const getPackageManager = sinon.stub().returns(manager);
        const envManagers = {
            onDidChangeActiveEnvironment: new EventEmitter().event,
            onDidChangePackageProviderPackages: new EventEmitter().event,
            managers: [],
            getEnvironmentManager,
            getPackageManager,
        } as unknown as ApiArgs[0];
        const projectManager = {
            getProjects: () => [],
            onDidChangeProjects: new EventEmitter<void>().event,
        } as unknown as ApiArgs[1];
        return {
            api: new PythonEnvironmentApiImpl(
                envManagers,
                projectManager,
                {} as ApiArgs[2],
                {} as ApiArgs[3],
                { onDidChangeEnvironmentVariables: new EventEmitter().event } as unknown as ApiArgs[4],
            ),
            getEnvironmentManager,
            getPackageManager,
        };
    }

    const environment = {
        envId: { id: 'environment', managerId: 'environment-manager' },
    } as PythonEnvironment;

    function expectNoPackageManagerError(error: unknown): true {
        assert.ok(error instanceof Error, 'Expected an Error');
        assert.strictEqual(error.name, 'Error');
        assert.strictEqual(error.message, 'No package manager found');
        return true;
    }

    test('rejects mutations and refreshes when no package manager resolves', async () => {
        const { api } = createApi(undefined);

        await assert.rejects(api.managePackages(environment, { install: ['example'] }), expectNoPackageManagerError);
        await assert.rejects(api.refreshPackages(environment), expectNoPackageManagerError);
    });

    test('returns undefined for reads when no package manager resolves', async () => {
        const { api } = createApi(undefined);

        assert.strictEqual(await api.getPackages(environment), undefined);
    });

    test('delegates to the resolved manager', async () => {
        const manage = sinon.stub().resolves();
        const manager = { manage } as unknown as InternalPackageManager;
        const { api, getPackageManager } = createApi(manager);

        await api.managePackages(environment, { install: ['example'] });

        assert.ok(getPackageManager.calledWithExactly(environment));
        assert.ok(manage.calledOnceWithExactly(environment, { install: ['example'] }));
    });

    test('creates a virtual environment and delegates package management to its manager', async () => {
        const createdEnvironment = {
            envId: { id: 'created', managerId: 'ms-python.python:venv' },
        } as PythonEnvironment;
        const manage = sinon.stub().resolves();
        const create = sinon.stub().resolves(createdEnvironment);
        const manager = { manage } as unknown as InternalPackageManager;
        const { api, getEnvironmentManager, getPackageManager } = createApi(manager);
        sinon.stub(api, 'getEnvironments').withArgs('global').resolves([environment]);
        getEnvironmentManager
            .withArgs('ms-python.python:venv')
            .returns({ supportsCreate: true, create } as unknown as InternalEnvironmentManager);
        sinon.stub(windowApis, 'showInformationMessage').resolves('Create New Virtual Environment');

        await api.managePackages(environment, { install: ['example'] });

        assert.ok(create.calledOnceWithExactly('global', { quickCreate: true }));
        assert.ok(getPackageManager.calledWithExactly(createdEnvironment));
        assert.ok(manage.calledOnceWithExactly(createdEnvironment, { install: ['example'] }));
    });

    test('delegates package management to a selected existing virtual environment', async () => {
        const selectedEnvironment = {
            envId: { id: 'selected', managerId: 'ms-python.python:venv' },
        } as PythonEnvironment;
        const manage = sinon.stub().resolves();
        const manager = { manage } as unknown as InternalPackageManager;
        const { api, getPackageManager } = createApi(manager);
        const getEnvironments = sinon.stub(api, 'getEnvironments');
        getEnvironments.withArgs('global').resolves([environment]);
        getEnvironments.withArgs('all').resolves([environment, selectedEnvironment]);
        sinon.stub(windowApis, 'showInformationMessage').resolves('Use Existing Virtual Environment');
        const pickEnvironment = sinon
            .stub(environmentPickers, 'pickEnvironmentFrom')
            .resolves(selectedEnvironment);

        await api.managePackages(environment, { install: ['example'] });

        assert.ok(pickEnvironment.calledOnceWithExactly([selectedEnvironment]));
        assert.ok(getPackageManager.calledWithExactly(selectedEnvironment));
        assert.ok(manage.calledOnceWithExactly(selectedEnvironment, { install: ['example'] }));
    });

    test('continues with the global environment when requested', async () => {
        const manage = sinon.stub().resolves();
        const manager = { manage } as unknown as InternalPackageManager;
        const { api } = createApi(manager);
        sinon.stub(api, 'getEnvironments').withArgs('global').resolves([environment]);
        sinon.stub(windowApis, 'showInformationMessage').resolves('Continue Globally');

        await api.managePackages(environment, { install: ['example'] });

        assert.ok(manage.calledOnceWithExactly(environment, { install: ['example'] }));
    });

    test('cancels package management when the global environment prompt is dismissed', async () => {
        const manage = sinon.stub().resolves();
        const manager = { manage } as unknown as InternalPackageManager;
        const { api, getPackageManager } = createApi(manager);
        sinon.stub(api, 'getEnvironments').withArgs('global').resolves([environment]);
        sinon.stub(windowApis, 'showInformationMessage').resolves(undefined);

        await api.managePackages(environment, { install: ['example'] });

        assert.ok(getPackageManager.notCalled);
        assert.ok(manage.notCalled);
    });

    test('does not prompt for headless or uninstall-only package management', async () => {
        const manage = sinon.stub().resolves();
        const manager = { manage } as unknown as InternalPackageManager;
        const { api } = createApi(manager);
        const getEnvironments = sinon.stub(api, 'getEnvironments');
        const showInformationMessage = sinon.stub(windowApis, 'showInformationMessage');

        await api.managePackages(environment, { install: ['example'], runHeadless: true });
        await api.managePackages(environment, { uninstall: ['example'] });

        assert.ok(getEnvironments.notCalled);
        assert.ok(showInformationMessage.notCalled);
        assert.strictEqual(manage.callCount, 2);
    });
});
