import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventEmitter, Uri } from 'vscode';
import { PythonEnvironment, PythonProject } from '../api';
import * as managerReady from '../features/common/managerReady';
import { PythonEnvironmentApiImpl } from '../extensionApi';
import type { PythonProjectManager } from '../features/projectManager';

suite('PythonEnvironmentApiImpl - onDidChangePythonProjects', () => {
    test('fires event with correct added and removed projects', () => {
        const onDidChangeProjectsEmitter = new EventEmitter<void>();
        let currentProjects: PythonProject[] = [];
        const mockProjectManager = {
            getProjects: () => currentProjects,
            onDidChangeProjects: onDidChangeProjectsEmitter.event,
        } as unknown as PythonProjectManager;

        type ApiArgs = ConstructorParameters<typeof PythonEnvironmentApiImpl>;
        const mockEnvManagers = { onDidChangeActiveEnvironment: new EventEmitter().event } as unknown as ApiArgs[0];
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

suite('PythonEnvironmentApiImpl - createEnvironment', () => {
    setup(() => {
        sinon.stub(managerReady, 'waitForEnvManager').resolves();
    });

    teardown(() => {
        sinon.restore();
    });

    function createApi(create: sinon.SinonStub): PythonEnvironmentApiImpl {
        type ApiArgs = ConstructorParameters<typeof PythonEnvironmentApiImpl>;
        const mockEnvManagers = {
            onDidChangeActiveEnvironment: new EventEmitter().event,
            getEnvironmentManager: sinon.stub().returns({
                id: 'ms-python.python:venv',
                supportsCreate: true,
                create,
            }),
        } as unknown as ApiArgs[0];

        return new PythonEnvironmentApiImpl(
            mockEnvManagers,
            { getProjects: () => [], onDidChangeProjects: new EventEmitter<void>().event } as unknown as ApiArgs[1],
            {} as unknown as ApiArgs[2],
            {} as unknown as ApiArgs[3],
            { onDidChangeEnvironmentVariables: new EventEmitter().event } as unknown as ApiArgs[4],
        );
    }

    test('forwards an explicit environment name to the selected manager', async () => {
        const created = {} as PythonEnvironment;
        const create = sinon.stub().resolves(created);
        const api = createApi(create);
        const scope = Uri.file('workspace');
        const options = { name: 'analysis-env', quickCreate: true };

        const result = await api.createEnvironment(scope, options);

        assert.strictEqual(result, created);
        assert.ok(create.calledOnceWithExactly(scope, options));
    });

    test('rejects invalid environment names', async () => {
        const create = sinon.stub();
        const api = createApi(create);

        for (const name of ['   ', '.', '..', '../outside', '..\\outside', 'nested/name', 'nested\\name']) {
            await assert.rejects(
                api.createEnvironment(Uri.file('workspace'), { name }),
                /must be a non-empty path segment/,
            );
        }

        assert.ok(create.notCalled);
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
