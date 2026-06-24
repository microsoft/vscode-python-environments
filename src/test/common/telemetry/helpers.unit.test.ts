import assert from 'node:assert';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import { PythonEnvironment, PythonProject } from '../../../api';
import { sendProjectStructureTelemetry } from '../../../common/telemetry/helpers';
import { EventNames } from '../../../common/telemetry/constants';
import * as sender from '../../../common/telemetry/sender';
import * as workspaceApis from '../../../common/workspace.apis';
import { EnvironmentManagers, PythonProjectManager } from '../../../internal.api';

suite('Telemetry Helpers', () => {
    suite('sendProjectStructureTelemetry', () => {
        let sendTelemetryEventStub: sinon.SinonStub;
        let getWorkspaceFoldersStub: sinon.SinonStub;
        let mockProjectManager: PythonProjectManager;
        let mockEnvManagers: EnvironmentManagers;

        setup(() => {
            sendTelemetryEventStub = sinon.stub(sender, 'sendTelemetryEvent');
            getWorkspaceFoldersStub = sinon.stub(workspaceApis, 'getWorkspaceFolders');
        });

        teardown(() => {
            sinon.restore();
        });

        test('should send telemetry with correct totalProjectCount', async () => {
            // Mock
            const projects: PythonProject[] = [
                { name: 'project1', uri: Uri.file('/workspace/project1') } as PythonProject,
                { name: 'project2', uri: Uri.file('/workspace/project2') } as PythonProject,
                { name: 'project3', uri: Uri.file('/other/project3') } as PythonProject,
            ];

            mockProjectManager = {
                getProjects: () => projects,
            } as unknown as PythonProjectManager;

            mockEnvManagers = {
                getEnvironment: sinon.stub().resolves(undefined),
            } as unknown as EnvironmentManagers;

            getWorkspaceFoldersStub.returns([]);

            // Run
            await sendProjectStructureTelemetry(mockProjectManager, mockEnvManagers);

            // Assert
            assert(sendTelemetryEventStub.calledOnce, 'sendTelemetryEvent should be called once');
            const call = sendTelemetryEventStub.firstCall;
            assert.strictEqual(call.args[0], EventNames.PROJECT_STRUCTURE);
            assert.strictEqual(call.args[2].totalProjectCount, 3);
        });

        test('should send telemetry with correct uniqueInterpreterCount', async () => {
            // Mock
            const projects: PythonProject[] = [
                { name: 'project1', uri: Uri.file('/workspace/project1') } as PythonProject,
                { name: 'project2', uri: Uri.file('/workspace/project2') } as PythonProject,
                { name: 'project3', uri: Uri.file('/other/project3') } as PythonProject,
            ];

            mockProjectManager = {
                getProjects: () => projects,
            } as unknown as PythonProjectManager;

            const env1 = { environmentPath: Uri.file('/path/to/python1') } as PythonEnvironment;
            const env2 = { environmentPath: Uri.file('/path/to/python2') } as PythonEnvironment;
            const env3 = { environmentPath: Uri.file('/path/to/python1') } as PythonEnvironment; // Same as env1

            const getEnvironmentStub = sinon.stub();
            getEnvironmentStub.withArgs(projects[0].uri).resolves(env1);
            getEnvironmentStub.withArgs(projects[1].uri).resolves(env2);
            getEnvironmentStub.withArgs(projects[2].uri).resolves(env3);

            mockEnvManagers = {
                getEnvironment: getEnvironmentStub,
            } as unknown as EnvironmentManagers;

            getWorkspaceFoldersStub.returns([]);

            // Run
            await sendProjectStructureTelemetry(mockProjectManager, mockEnvManagers);

            // Assert
            assert(sendTelemetryEventStub.calledOnce, 'sendTelemetryEvent should be called once');
            const call = sendTelemetryEventStub.firstCall;
            assert.strictEqual(call.args[2].uniqueInterpreterCount, 2, 'Should have 2 unique interpreters');
        });

        test('should send telemetry with correct projectUnderRoot count', async () => {
            // Mock
            const projects: PythonProject[] = [
                { name: 'project1', uri: Uri.file('/workspace/project1') } as PythonProject, // Under root
                { name: 'project2', uri: Uri.file('/workspace/subfolder/project2') } as PythonProject, // Under root
                { name: 'workspace', uri: Uri.file('/workspace') } as PythonProject, // Equal to root, not counted
                { name: 'project3', uri: Uri.file('/other/project3') } as PythonProject, // Not under root
            ];

            mockProjectManager = {
                getProjects: () => projects,
            } as unknown as PythonProjectManager;

            mockEnvManagers = {
                getEnvironment: sinon.stub().resolves(undefined),
            } as unknown as EnvironmentManagers;

            getWorkspaceFoldersStub.returns([{ uri: Uri.file('/workspace'), name: 'workspace' }]);

            // Run
            await sendProjectStructureTelemetry(mockProjectManager, mockEnvManagers);

            // Assert
            assert(sendTelemetryEventStub.calledOnce, 'sendTelemetryEvent should be called once');
            const call = sendTelemetryEventStub.firstCall;
            assert.strictEqual(call.args[2].projectUnderRoot, 2, 'Should count 2 projects under workspace root');
        });

        test('should handle projects with no environments', async () => {
            // Mock
            const projects: PythonProject[] = [
                { name: 'project1', uri: Uri.file('/workspace/project1') } as PythonProject,
                { name: 'project2', uri: Uri.file('/workspace/project2') } as PythonProject,
            ];

            mockProjectManager = {
                getProjects: () => projects,
            } as unknown as PythonProjectManager;

            mockEnvManagers = {
                getEnvironment: sinon.stub().resolves(undefined),
            } as unknown as EnvironmentManagers;

            getWorkspaceFoldersStub.returns([]);

            // Run
            await sendProjectStructureTelemetry(mockProjectManager, mockEnvManagers);

            // Assert
            assert(sendTelemetryEventStub.calledOnce, 'sendTelemetryEvent should be called once');
            const call = sendTelemetryEventStub.firstCall;
            assert.strictEqual(call.args[2].uniqueInterpreterCount, 0, 'Should have 0 interpreters');
        });

        test('should handle getEnvironment errors gracefully', async () => {
            // Mock
            const projects: PythonProject[] = [
                { name: 'project1', uri: Uri.file('/workspace/project1') } as PythonProject,
                { name: 'project2', uri: Uri.file('/workspace/project2') } as PythonProject,
            ];

            mockProjectManager = {
                getProjects: () => projects,
            } as unknown as PythonProjectManager;

            const getEnvironmentStub = sinon.stub();
            getEnvironmentStub.withArgs(projects[0].uri).rejects(new Error('Failed to get environment'));
            getEnvironmentStub.withArgs(projects[1].uri).resolves({
                environmentPath: Uri.file('/path/to/python'),
            } as PythonEnvironment);

            mockEnvManagers = {
                getEnvironment: getEnvironmentStub,
            } as unknown as EnvironmentManagers;

            getWorkspaceFoldersStub.returns([]);

            // Run
            await sendProjectStructureTelemetry(mockProjectManager, mockEnvManagers);

            // Assert
            assert(sendTelemetryEventStub.calledOnce, 'sendTelemetryEvent should be called once');
            const call = sendTelemetryEventStub.firstCall;
            assert.strictEqual(
                call.args[2].uniqueInterpreterCount,
                1,
                'Should count only the successful environment',
            );
        });

        test('should handle empty projects list', async () => {
            // Mock
            mockProjectManager = {
                getProjects: () => [],
            } as unknown as PythonProjectManager;

            mockEnvManagers = {
                getEnvironment: sinon.stub().resolves(undefined),
            } as unknown as EnvironmentManagers;

            getWorkspaceFoldersStub.returns([]);

            // Run
            await sendProjectStructureTelemetry(mockProjectManager, mockEnvManagers);

            // Assert
            assert(sendTelemetryEventStub.calledOnce, 'sendTelemetryEvent should be called once');
            const call = sendTelemetryEventStub.firstCall;
            assert.strictEqual(call.args[2].totalProjectCount, 0);
            assert.strictEqual(call.args[2].uniqueInterpreterCount, 0);
            assert.strictEqual(call.args[2].projectUnderRoot, 0);
        });

        test('should handle multiple workspace folders', async () => {
            // Mock
            const projects: PythonProject[] = [
                { name: 'project1', uri: Uri.file('/workspace1/project1') } as PythonProject, // Under workspace1
                { name: 'project2', uri: Uri.file('/workspace2/project2') } as PythonProject, // Under workspace2
                { name: 'project3', uri: Uri.file('/other/project3') } as PythonProject, // Not under any workspace
            ];

            mockProjectManager = {
                getProjects: () => projects,
            } as unknown as PythonProjectManager;

            mockEnvManagers = {
                getEnvironment: sinon.stub().resolves(undefined),
            } as unknown as EnvironmentManagers;

            getWorkspaceFoldersStub.returns([
                { uri: Uri.file('/workspace1'), name: 'workspace1' },
                { uri: Uri.file('/workspace2'), name: 'workspace2' },
            ]);

            // Run
            await sendProjectStructureTelemetry(mockProjectManager, mockEnvManagers);

            // Assert
            assert(sendTelemetryEventStub.calledOnce, 'sendTelemetryEvent should be called once');
            const call = sendTelemetryEventStub.firstCall;
            assert.strictEqual(call.args[2].projectUnderRoot, 2, 'Should count 2 projects under workspace roots');
        });

        test('should not count projects with path prefix that are not actually nested', async () => {
            // Mock - Test edge case where path starts with workspace path but is not nested
            const projects: PythonProject[] = [
                { name: 'workspace', uri: Uri.file('/workspace') } as PythonProject, // Equal to root
                { name: 'workspace2', uri: Uri.file('/workspace2') } as PythonProject, // Starts with prefix but not nested
            ];

            mockProjectManager = {
                getProjects: () => projects,
            } as unknown as PythonProjectManager;

            mockEnvManagers = {
                getEnvironment: sinon.stub().resolves(undefined),
            } as unknown as EnvironmentManagers;

            getWorkspaceFoldersStub.returns([{ uri: Uri.file('/workspace'), name: 'workspace' }]);

            // Run
            await sendProjectStructureTelemetry(mockProjectManager, mockEnvManagers);

            // Assert
            assert(sendTelemetryEventStub.calledOnce, 'sendTelemetryEvent should be called once');
            const call = sendTelemetryEventStub.firstCall;
            assert.strictEqual(
                call.args[2].projectUnderRoot,
                0,
                'Should not count projects that are not actually nested',
            );
        });
    });
});
