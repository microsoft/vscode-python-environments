// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { QuickInputButtons, Uri } from 'vscode';
import { EnvironmentManager, PythonEnvironment, PythonProject } from '../../api';
import { INLINE_SCRIPT_MANAGER_ID } from '../../common/constants';
import {
    InlineScriptEnvironmentModifiedError,
    InlineScriptPackagesNotManagedError,
} from '../../common/inlineScript/errors';
import * as logging from '../../common/logging';
import * as environmentPickers from '../../common/pickers/environments';
import * as projectPickers from '../../common/pickers/projects';
import * as windowApis from '../../common/window.apis';
import { getPackageCommandOptions, setEnvironmentCommand } from '../../features/envCommands';
import { EnvManagerTreeItem, ProjectItem, PythonEnvTreeItem } from '../../features/views/treeViewItems';
import {
    EnvironmentManagers,
    InternalEnvironmentManager,
    InternalPackageManager,
    PythonProjectManager,
} from '../../internal.api';
import { createMockPythonEnvironment } from '../mocks/pythonEnvironment';

suite('Inline environment selection error feedback', () => {
    const uri = Uri.file(path.join(process.cwd(), 'selection-script.py'));
    const project: PythonProject = { uri, name: 'script' };
    const environment = createMockPythonEnvironment({
        envPath: path.join(process.cwd(), 'inline-selection-env'),
        managerId: INLINE_SCRIPT_MANAGER_ID,
    });
    let setEnvironments: sinon.SinonStub;
    let pickEnvironment: sinon.SinonStub;
    let showError: sinon.SinonStub;
    let managers: EnvironmentManagers;
    let projects: PythonProjectManager;

    setup(() => {
        setEnvironments = sinon.stub().rejects(new InlineScriptEnvironmentModifiedError());
        pickEnvironment = sinon.stub(environmentPickers, 'pickEnvironment').resolves(environment);
        sinon.stub(projectPickers, 'pickProjectMany').resolves([project]);
        showError = sinon.stub(windowApis, 'showErrorMessage').resolves(undefined);
        sinon.stub(logging, 'traceError');
        const managerMock: Partial<EnvironmentManagers> = {
            managers: [],
            getEnvironment: async () => undefined,
            getEnvironmentManager: () => undefined,
            getProjectEnvManagers: () => [],
            setEnvironments,
        };
        const projectMock: Partial<PythonProjectManager> = { getProjects: () => [project] };
        managers = managerMock as EnvironmentManagers;
        projects = projectMock as PythonProjectManager;
    });

    teardown(() => sinon.restore());

    for (const kind of ['uri', 'array', 'project', 'environment'] as const) {
        test(`shows actionable guidance once for a ${kind} selection`, async () => {
            let context: unknown = uri;
            if (kind === 'array') {
                context = [uri];
            } else if (kind === 'project') {
                context = new ProjectItem(project);
            } else if (kind === 'environment') {
                const provider: EnvironmentManager = {
                    name: 'inline-script',
                    preferredPackageManagerId: 'ms-python.python:pip',
                    get: async () => environment,
                    set: async () => undefined,
                    getEnvironments: async () => [environment],
                    refresh: async () => undefined,
                    resolve: async () => undefined,
                };
                const parent = new EnvManagerTreeItem(new InternalEnvironmentManager(INLINE_SCRIPT_MANAGER_ID, provider));
                context = new PythonEnvTreeItem(environment, parent);
            }

            await setEnvironmentCommand(context, managers, projects);

            assert.ok(setEnvironments.calledOnce);
            assert.ok(showError.calledOnceWithExactly(new InlineScriptEnvironmentModifiedError().message));
        });
    }

    test('does not swallow unrelated provider failures', async () => {
        const failure = new Error('Unexpected provider failure');
        setEnvironments.rejects(failure);

        await assert.rejects(setEnvironmentCommand(uri, managers, projects), (error: unknown) => error === failure);

        assert.ok(showError.notCalled);
    });

    test('does not show an error when the user cancels the picker', async () => {
        pickEnvironment.resolves(undefined);

        await setEnvironmentCommand(uri, managers, projects);

        assert.ok(setEnvironments.notCalled);
        assert.ok(showError.notCalled);
    });

    test('does not consume the Back navigation sentinel', async () => {
        pickEnvironment.rejects(QuickInputButtons.Back);

        await assert.rejects(
            setEnvironmentCommand(uri, managers, projects),
            (error: unknown) => error === QuickInputButtons.Back,
        );
        assert.ok(showError.notCalled);
    });
});

suite('Inline environment package command guard', () => {
    const uri = Uri.file(path.join(process.cwd(), 'guarded-script.py'));
    const project: PythonProject = { uri, name: 'script' };
    const packageManager = {} as InternalPackageManager;

    teardown(() => sinon.restore());

    function createManagers(environment: PythonEnvironment): EnvironmentManagers {
        const managerMock: Partial<EnvironmentManagers> = {
            getEnvironmentManager: () => ({ get: async () => environment } as unknown as InternalEnvironmentManager),
            getPackageManager: () => packageManager,
        };
        return managerMock as EnvironmentManagers;
    }

    const projects = { getProjects: () => [project] } as unknown as PythonProjectManager;

    // The tree view hides package actions for these environments, but the command palette can
    // still resolve one from the active script, so the chokepoint must refuse it too.
    test('refuses a package command that resolves to an inline-script environment', async () => {
        const environment = createMockPythonEnvironment({
            envPath: path.join(process.cwd(), 'inline-package-env'),
            managerId: INLINE_SCRIPT_MANAGER_ID,
        });

        await assert.rejects(
            getPackageCommandOptions(uri, createManagers(environment), projects),
            (error: unknown) => error instanceof InlineScriptPackagesNotManagedError,
        );
    });

    test('still resolves package commands for ordinary environments', async () => {
        const environment = createMockPythonEnvironment({
            envPath: path.join(process.cwd(), 'venv-package-env'),
            managerId: 'ms-python.python:venv',
        });

        const options = await getPackageCommandOptions(uri, createManagers(environment), projects);

        assert.strictEqual(options.environment, environment);
        assert.strictEqual(options.packageManager, packageManager);
    });
});
