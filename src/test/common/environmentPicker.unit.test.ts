// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'node:assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import { PythonEnvironment } from '../../api';
import { Interpreter } from '../../common/localize';
import { pickEnvironment } from '../../common/pickers/environments';
import * as managerPicker from '../../common/pickers/managers';
import * as windowApis from '../../common/window.apis';
import * as workspaceApis from '../../common/workspace.apis';
import { createMockPythonEnvironment } from '../mocks/pythonEnvironment';

suite('Environment Picker Creation Availability', () => {
    const folder = { uri: Uri.file(process.cwd()), name: 'workspace', index: 0 };

    teardown(() => {
        sinon.restore();
    });

    for (const { name, folders, canCreate } of [
        { name: 'no workspace', folders: undefined, canCreate: false },
        { name: 'an empty workspace', folders: [], canCreate: false },
        { name: 'an open folder without detected projects', folders: [folder], canCreate: true },
        {
            name: 'a multi-root workspace',
            folders: [folder, { uri: Uri.file(path.join(process.cwd(), 'second')), name: 'second', index: 1 }],
            canCreate: true,
        },
    ]) {
        test(`only offers creation with an open folder: ${name}`, async () => {
            sinon.stub(workspaceApis, 'getWorkspaceFolders').returns(folders);
            const pickManager = sinon.stub(managerPicker, 'pickEnvironmentManager');
            const picker = sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async (items) => {
                assert.strictEqual(
                    items.some((item) => item.label === Interpreter.createVirtualEnvironment),
                    canCreate,
                );
                assert.ok(items.some((item) => item.label === Interpreter.browsePath));
                return undefined;
            });

            assert.strictEqual(await pickEnvironment([], [], { projects: [] }), undefined);
            sinon.assert.calledOnce(picker);
            sinon.assert.notCalled(pickManager);
        });
    }

    test('still selects an existing environment without an open folder', async () => {
        const environment = createMockPythonEnvironment({ envPath: path.join(process.cwd(), 'python') });
        sinon.stub(workspaceApis, 'getWorkspaceFolders').returns(undefined);
        sinon
            .stub(windowApis, 'showQuickPickWithButtons')
            .callsFake(async (items) => items.find((item) => item.label === environment.displayName));

        const selected = await pickEnvironment([], [], { projects: [], recommended: environment });

        assert.strictEqual(selected, environment);
    });

    test('still allows browsing for an interpreter without an open folder', async () => {
        sinon.stub(workspaceApis, 'getWorkspaceFolders').returns(undefined);
        sinon
            .stub(windowApis, 'showQuickPickWithButtons')
            .callsFake(async (items) => items.find((item) => item.label === Interpreter.browsePath));
        const browse = sinon.stub(windowApis, 'showOpenDialog').resolves(undefined);

        assert.strictEqual(await pickEnvironment([], [], { projects: [] }), undefined);
        sinon.assert.calledOnce(browse);
    });
});

/**
 * Test the logic used in environment pickers to include interpreter paths in descriptions
 */
suite('Environment Picker Description Logic', () => {
    const createMockEnvironment = (
        displayPath: string,
        description?: string,
        name: string = 'Python 3.9.0',
    ): PythonEnvironment => ({
        envId: { id: 'test', managerId: 'test-manager' },
        name,
        displayName: name,
        displayPath,
        version: '3.9.0',
        environmentPath: Uri.file(displayPath),
        description,
        sysPrefix: '/path/to/prefix',
        execInfo: { run: { executable: displayPath } },
    });

    suite('Description formatting with interpreter path', () => {
        test('should use displayPath as description when no original description exists', () => {
            const env = createMockEnvironment('/usr/local/bin/python');

            // This is the logic from our updated picker
            const pathDescription = env.displayPath;
            const description =
                env.description && env.description.trim() ? `${env.description} (${pathDescription})` : pathDescription;

            assert.strictEqual(description, '/usr/local/bin/python');
        });

        test('should append displayPath to existing description in parentheses', () => {
            const env = createMockEnvironment('/home/user/.venv/bin/python', 'Virtual Environment');

            // This is the logic from our updated picker
            const pathDescription = env.displayPath;
            const description =
                env.description && env.description.trim() ? `${env.description} (${pathDescription})` : pathDescription;

            assert.strictEqual(description, 'Virtual Environment (/home/user/.venv/bin/python)');
        });

        test('should handle complex paths correctly', () => {
            const complexPath = '/usr/local/anaconda3/envs/my-project-env/bin/python';
            const env = createMockEnvironment(complexPath, 'Conda Environment');

            // This is the logic from our updated picker
            const pathDescription = env.displayPath;
            const description =
                env.description && env.description.trim() ? `${env.description} (${pathDescription})` : pathDescription;

            assert.strictEqual(description, `Conda Environment (${complexPath})`);
        });

        test('should handle empty description correctly', () => {
            const env = createMockEnvironment('/opt/python/bin/python', '');

            // This is the logic from our updated picker
            const pathDescription = env.displayPath;
            const description =
                env.description && env.description.trim() ? `${env.description} (${pathDescription})` : pathDescription;

            // Empty string should be treated like no description, so just use path
            assert.strictEqual(description, '/opt/python/bin/python');
        });

        test('should handle Windows paths correctly', () => {
            const windowsPath = 'C:\\Python39\\python.exe';
            const env = createMockEnvironment(windowsPath, 'System Python');

            // This is the logic from our updated picker
            const pathDescription = env.displayPath;
            const description =
                env.description && env.description.trim() ? `${env.description} (${pathDescription})` : pathDescription;

            assert.strictEqual(description, 'System Python (C:\\Python39\\python.exe)');
        });
    });
});
