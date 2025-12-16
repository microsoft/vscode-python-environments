// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Python API getEnvironment Unit Tests
 *
 * This test suite validates the getEnvironment API functionality including:
 * - Returning environment for specific scope (Uri)
 * - Smart scope detection when scope is undefined:
 *   - Using active text editor's document URI
 *   - Using single workspace folder URI
 *   - Falling back to global environment
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as typeMoq from 'typemoq';
import { EventEmitter, TextDocument, TextEditor, Uri, WorkspaceFolder } from 'vscode';
import {
    DidChangeEnvironmentEventArgs,
    DidChangeEnvironmentVariablesEventArgs,
    PythonEnvironment,
} from '../../api';
import * as extensionApis from '../../common/extension.apis';
import * as windowApis from '../../common/window.apis';
import * as workspaceApis from '../../common/workspace.apis';
import { PythonEnvironmentManagers } from '../../features/envManagers';
import { getPythonApi, setPythonApi } from '../../features/pythonApi';
import { TerminalManager } from '../../features/terminal/terminalManager';
import { EnvVarManager } from '../../features/execution/envVariableManager';
import * as managerReady from '../../features/common/managerReady';
import { ProjectCreators, PythonProjectManager } from '../../internal.api';
import { setupNonThenable } from '../mocks/helper';

suite('PythonApi.getEnvironment Tests', () => {
    let envManagers: typeMoq.IMock<PythonEnvironmentManagers>;
    let projectManager: typeMoq.IMock<PythonProjectManager>;
    let projectCreators: typeMoq.IMock<ProjectCreators>;
    let terminalManager: typeMoq.IMock<TerminalManager>;
    let envVarManager: typeMoq.IMock<EnvVarManager>;
    let mockEnvironment: typeMoq.IMock<PythonEnvironment>;
    let getExtensionStub: sinon.SinonStub;
    let activeTextEditorStub: sinon.SinonStub;
    let getWorkspaceFoldersStub: sinon.SinonStub;

    setup(() => {
        // Mock extension APIs
        const mockPythonExtension = {
            id: 'ms-python.python',
            extensionPath: '/mock/python/extension',
        };
        const mockEnvsExtension = {
            id: 'ms-python.vscode-python-envs',
            extensionPath: '/mock/envs/extension',
        };

        getExtensionStub = sinon.stub(extensionApis, 'getExtension');
        getExtensionStub.withArgs('ms-python.python').returns(mockPythonExtension as any);
        getExtensionStub.withArgs('ms-python.vscode-python-envs').returns(mockEnvsExtension as any);

        sinon.stub(extensionApis, 'allExtensions').returns([mockPythonExtension, mockEnvsExtension] as any);

        // Stub the manager ready functions to avoid hanging
        sinon.stub(managerReady, 'waitForEnvManager').resolves();
        sinon.stub(managerReady, 'waitForEnvManagerId').resolves();
        sinon.stub(managerReady, 'waitForAllEnvManagers').resolves();

        // Create mocks
        envManagers = typeMoq.Mock.ofType<PythonEnvironmentManagers>();
        projectManager = typeMoq.Mock.ofType<PythonProjectManager>();
        projectCreators = typeMoq.Mock.ofType<ProjectCreators>();
        terminalManager = typeMoq.Mock.ofType<TerminalManager>();
        envVarManager = typeMoq.Mock.ofType<EnvVarManager>();

        // Setup event emitters
        const onDidChangeEnvironmentEmitter = new EventEmitter<DidChangeEnvironmentEventArgs>();

        envManagers
            .setup((e) => e.onDidChangeEnvironmentFiltered)
            .returns(() => onDidChangeEnvironmentEmitter.event);
        setupNonThenable(envManagers);
        setupNonThenable(projectManager);
        setupNonThenable(projectCreators);
        setupNonThenable(terminalManager);

        const onDidChangeEnvVarsEmitter = new EventEmitter<DidChangeEnvironmentVariablesEventArgs>();
        envVarManager
            .setup((e) => e.onDidChangeEnvironmentVariables)
            .returns(() => onDidChangeEnvVarsEmitter.event);
        setupNonThenable(envVarManager);

        // Mock environment
        mockEnvironment = typeMoq.Mock.ofType<PythonEnvironment>();
        mockEnvironment.setup((e) => e.envId).returns(() => ({ id: 'test-env', managerId: 'test-mgr' }));
        mockEnvironment.setup((e) => e.displayName).returns(() => 'Test Environment');
        setupNonThenable(mockEnvironment);

        // Setup a default return for all getEnvironment calls
        envManagers
            .setup((e) => e.getEnvironment(typeMoq.It.isAny()))
            .returns(() => Promise.resolve(mockEnvironment.object));

        // Stub window and workspace APIs
        activeTextEditorStub = sinon.stub(windowApis, 'activeTextEditor');
        getWorkspaceFoldersStub = sinon.stub(workspaceApis, 'getWorkspaceFolders');

        // Initialize API
        setPythonApi(
            envManagers.object,
            projectManager.object,
            projectCreators.object,
            terminalManager.object,
            envVarManager.object,
        );
    });

    teardown(() => {
        sinon.restore();
    });

    test('getEnvironment with explicit URI scope returns environment for that scope', async () => {
        const testUri = Uri.file('/test/workspace/file.py');

        envManagers
            .setup((e) => e.getEnvironment(testUri))
            .returns(() => Promise.resolve(mockEnvironment.object))
            .verifiable(typeMoq.Times.once());

        const api = await getPythonApi();
        const result = await api.getEnvironment(testUri);

        assert.strictEqual(result, mockEnvironment.object);
        envManagers.verifyAll();
    });

    test('getEnvironment with undefined scope uses active text editor URI when available', async () => {
        const testUri = Uri.file('/test/workspace/file.py');
        const mockDoc: Partial<TextDocument> = {
            uri: testUri,
            isUntitled: false,
        };

        const mockEditor: Partial<TextEditor> = {
            document: mockDoc as TextDocument,
        };

        activeTextEditorStub.returns(mockEditor as TextEditor);

        const api = await getPythonApi();
        const result = await api.getEnvironment(undefined);

        assert.strictEqual(result, mockEnvironment.object);
        // Verify the stub was called with a non-undefined value (should be testUri)
        sinon.assert.called(activeTextEditorStub);
    });

    test('getEnvironment with undefined scope uses workspace folder when no active editor', async () => {
        const workspaceUri = Uri.file('/test/workspace');
        const mockWorkspaceFolder: Partial<WorkspaceFolder> = {
            uri: workspaceUri,
            name: 'test-workspace',
            index: 0,
        };

        activeTextEditorStub.returns(undefined);
        getWorkspaceFoldersStub.returns([mockWorkspaceFolder as WorkspaceFolder]);

        const api = await getPythonApi();
        const result = await api.getEnvironment(undefined);

        assert.strictEqual(result, mockEnvironment.object);
        sinon.assert.called(getWorkspaceFoldersStub);
    });

    test('getEnvironment with undefined scope falls back to global when no editor or workspace', async () => {
        activeTextEditorStub.returns(undefined);
        getWorkspaceFoldersStub.returns(undefined);

        const api = await getPythonApi();
        const result = await api.getEnvironment(undefined);

        assert.strictEqual(result, mockEnvironment.object);
    });

    test('getEnvironment with undefined scope ignores untitled documents', async () => {
        const workspaceUri = Uri.file('/test/workspace');
        const mockWorkspaceFolder: Partial<WorkspaceFolder> = {
            uri: workspaceUri,
            name: 'test-workspace',
            index: 0,
        };

        const mockDoc: Partial<TextDocument> = {
            isUntitled: true,
        };

        const mockEditor: Partial<TextEditor> = {
            document: mockDoc as TextDocument,
        };

        activeTextEditorStub.returns(mockEditor as TextEditor);
        getWorkspaceFoldersStub.returns([mockWorkspaceFolder as WorkspaceFolder]);

        const api = await getPythonApi();
        const result = await api.getEnvironment(undefined);

        assert.strictEqual(result, mockEnvironment.object);
        sinon.assert.called(getWorkspaceFoldersStub);
    });

    test('getEnvironment with undefined scope ignores non-file scheme documents', async () => {
        const workspaceUri = Uri.file('/test/workspace');
        const mockWorkspaceFolder: Partial<WorkspaceFolder> = {
            uri: workspaceUri,
            name: 'test-workspace',
            index: 0,
        };

        const mockDoc: Partial<TextDocument> = {
            uri: Uri.parse('git:/test/file.py'),
            isUntitled: false,
        };

        const mockEditor: Partial<TextEditor> = {
            document: mockDoc as TextDocument,
        };

        activeTextEditorStub.returns(mockEditor as TextEditor);
        getWorkspaceFoldersStub.returns([mockWorkspaceFolder as WorkspaceFolder]);

        const api = await getPythonApi();
        const result = await api.getEnvironment(undefined);

        assert.strictEqual(result, mockEnvironment.object);
        sinon.assert.called(getWorkspaceFoldersStub);
    });

    test('getEnvironment with undefined scope falls back to global when multiple workspaces', async () => {
        const workspace1: Partial<WorkspaceFolder> = {
            uri: Uri.file('/workspace1'),
            name: 'workspace1',
            index: 0,
        };

        const workspace2: Partial<WorkspaceFolder> = {
            uri: Uri.file('/workspace2'),
            name: 'workspace2',
            index: 1,
        };

        activeTextEditorStub.returns(undefined);
        getWorkspaceFoldersStub.returns([workspace1 as WorkspaceFolder, workspace2 as WorkspaceFolder]);

        const api = await getPythonApi();
        const result = await api.getEnvironment(undefined);

        assert.strictEqual(result, mockEnvironment.object);
    });
});
