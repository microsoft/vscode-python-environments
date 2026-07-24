import * as assert from 'assert';
import { EventEmitter, Uri } from 'vscode';
import { PythonProject } from '../../api';
import { PythonEnvironmentApiImpl } from '../../features/pythonApi';
import { PythonProjectManager } from '../../internal.api';

suite('PythonEnvironmentApiImpl - onDidChangePythonProjects', () => {
    test('Fires event with correct added and removed projects', async () => {
        // 1. Create a mock EventEmitter to simulate the internal project manager
        const onDidChangeProjectsEmitter = new EventEmitter<void>();
        
        // 2. Mock the PythonProjectManager
        let currentProjects: PythonProject[] = [];
        const mockProjectManager = {
            getProjects: () => currentProjects,
            onDidChangeProjects: onDidChangeProjectsEmitter.event,
        } as unknown as PythonProjectManager;

        // 3. Mock the other required constructor arguments using ConstructorParameters
        type ApiArgs = ConstructorParameters<typeof PythonEnvironmentApiImpl>;
        
        const mockEnvManagers = { onDidChangeActiveEnvironment: new EventEmitter().event } as unknown as ApiArgs[0];
        const mockProjectCreators = {} as unknown as ApiArgs[2];
        const mockTerminalManager = {} as unknown as ApiArgs[3];
        const mockEnvVarManager = { onDidChangeEnvironmentVariables: new EventEmitter().event } as unknown as ApiArgs[4];

        // 4. Initialize the API instance
        const api = new PythonEnvironmentApiImpl(
            mockEnvManagers,
            mockProjectManager,
            mockProjectCreators,
            mockTerminalManager,
            mockEnvVarManager
        );

        // 5. Listen to the public event we are testing
        let firedEventPayload: unknown = null;
        api.onDidChangePythonProjects((e: unknown) => {
            firedEventPayload = e;
        });

        // 6. Simulate adding a project
        const newProject = { uri: Uri.joinPath(Uri.file(process.cwd()), 'fake', 'path') } as unknown as PythonProject;
        currentProjects = [newProject]; // Update the mock's state
        
        // Fire the internal event
        onDidChangeProjectsEmitter.fire();

        // 7. Assert the public event fired with the correct delta
        assert.ok(firedEventPayload, 'Event should have fired');
        assert.strictEqual((firedEventPayload as { added: PythonProject[] }).added.length, 1, 'Should have 1 added project');
        assert.strictEqual((firedEventPayload as { added: PythonProject[] }).added[0].uri.fsPath, newProject.uri.fsPath);
        assert.strictEqual((firedEventPayload as { removed: PythonProject[] }).removed.length, 0, 'Should have 0 removed projects');

        // 8. Simulate removing the project
        firedEventPayload = null;
        currentProjects = [];
        onDidChangeProjectsEmitter.fire();

        assert.ok(firedEventPayload, 'Event should have fired');
        assert.strictEqual((firedEventPayload as { added: PythonProject[] }).added.length, 0, 'Should have 0 added projects');
        assert.strictEqual((firedEventPayload as { removed: PythonProject[] }).removed.length, 1, 'Should have 1 removed project');
        assert.strictEqual((firedEventPayload as { removed: PythonProject[] }).removed[0].uri.fsPath, newProject.uri.fsPath);
    });
});