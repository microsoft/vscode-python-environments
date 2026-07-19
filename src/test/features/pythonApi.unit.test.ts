// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventEmitter, Uri } from 'vscode';
import { PythonProject } from '../../api';
import { PythonEnvironmentApiImpl } from '../../features/pythonApi';
import { EnvironmentManagers, ProjectCreators, PythonProjectManager } from '../../internal.api';
import { EnvVarManager } from '../../features/execution/envVariableManager';
import { TerminalManager } from '../../features/terminal/terminalManager';

suite('PythonEnvironmentApiImpl - onDidChangePythonProjects', () => {
    let sandbox: sinon.SinonSandbox;
    let mockEnvManagers: sinon.SinonStubbedInstance<EnvironmentManagers>;
    let mockProjectManager: sinon.SinonStubbedInstance<PythonProjectManager>;
    let mockProjectCreators: sinon.SinonStubbedInstance<ProjectCreators>;
    let mockTerminalManager: sinon.SinonStubbedInstance<TerminalManager>;
    let mockEnvVarManager: sinon.SinonStubbedInstance<EnvVarManager>;
    let onDidChangeProjectsEmitter: EventEmitter<PythonProject[] | undefined>;

    setup(() => {
        sandbox = sinon.createSandbox();
        onDidChangeProjectsEmitter = new EventEmitter<PythonProject[] | undefined>();

        mockEnvManagers = {
            onDidChangeActiveEnvironment: new EventEmitter<any>().event,
        } as any;
        mockProjectCreators = {} as any;
        mockTerminalManager = {} as any;
        mockEnvVarManager = {
            onDidChangeEnvironmentVariables: new EventEmitter<any>().event,
        } as any;

        mockProjectManager = {
            getProjects: sandbox.stub().returns([]),
            onDidChangeProjects: onDidChangeProjectsEmitter.event,
        } as any;
    });

    teardown(() => {
        sandbox.restore();
        onDidChangeProjectsEmitter.dispose();
    });

    test('Fires onDidChangePythonProjects with added/removed projects when projects change', () => {
        const p1: PythonProject = { name: 'Proj1', uri: Uri.file('/path/p1') };
        const p2: PythonProject = { name: 'Proj2', uri: Uri.file('/path/p2') };
        const p3: PythonProject = { name: 'Proj3', uri: Uri.file('/path/p3') };

        // Initially we return p1 and p2
        mockProjectManager.getProjects.returns([p1, p2]);

        const api = new PythonEnvironmentApiImpl(
            mockEnvManagers as any,
            mockProjectManager as any,
            mockProjectCreators as any,
            mockTerminalManager as any,
            mockEnvVarManager as any,
        );

        const events: { added: PythonProject[]; removed: PythonProject[] }[] = [];
        api.onDidChangePythonProjects((e) => {
            events.push(e);
        });

        // Add p3, remove p1 -> current projects are p2, p3
        onDidChangeProjectsEmitter.fire([p2, p3]);

        assert.strictEqual(events.length, 1);
        assert.deepStrictEqual(events[0].added.map(p => p.uri.toString()), [p3.uri.toString()]);
        assert.deepStrictEqual(events[0].removed.map(p => p.uri.toString()), [p1.uri.toString()]);
    });
});
