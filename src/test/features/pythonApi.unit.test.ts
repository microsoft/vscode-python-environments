import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventEmitter, Uri } from 'vscode';
import { PythonEnvironment, PythonProject } from '../../api';
import * as managerReady from '../../features/common/managerReady';
import { PythonEnvironmentApiImpl } from '../../features/pythonApi';
import { PythonProjectManager } from '../../internal.api';

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
});
