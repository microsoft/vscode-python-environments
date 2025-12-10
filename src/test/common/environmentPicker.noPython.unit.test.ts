// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'node:assert';
import * as sinon from 'sinon';
import { QuickPickItem, Uri } from 'vscode';
import { PythonEnvironment } from '../../api';
import { InternalEnvironmentManager } from '../../internal.api';
import { Interpreter } from '../../common/localize';
import { pickEnvironment } from '../../common/pickers/environments';
import * as windowApis from '../../common/window.apis';

/**
 * Test that the environment picker shows a warning when Python is not installed
 */
suite('Environment Picker - No Python Warning', () => {
    let showQuickPickWithButtonsStub: sinon.SinonStub;
    let mockSystemManager: Partial<InternalEnvironmentManager>;

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

    setup(() => {
        showQuickPickWithButtonsStub = sinon.stub(windowApis, 'showQuickPickWithButtons');
    });

    teardown(() => {
        sinon.restore();
    });

    test('should show warning when no Python is installed', async () => {
        // Mock - system manager with no environments
        mockSystemManager = {
            id: 'ms-python.python:system',
            name: 'system',
            displayName: 'Global',
            getEnvironments: sinon.stub().resolves([]),
        };

        // Capture what items are shown in the quick pick
        let capturedItems: readonly QuickPickItem[] = [];
        showQuickPickWithButtonsStub.callsFake((items: readonly QuickPickItem[]) => {
            capturedItems = items;
            return Promise.resolve(undefined);
        });

        await pickEnvironment([mockSystemManager as InternalEnvironmentManager], [], { projects: [] });

        // Assert - warning item should be shown instead of "Create Virtual Environment"
        const warningItem = capturedItems.find((item) => item.label === Interpreter.noPythonInstalled);
        assert.ok(warningItem, 'Warning item should be present');
        assert.strictEqual(warningItem.description, Interpreter.noPythonInstalledDescription);

        // Assert - "Create Virtual Environment" should NOT be shown
        const createEnvItem = capturedItems.find((item) => item.label === Interpreter.createVirtualEnvironment);
        assert.strictEqual(createEnvItem, undefined, 'Create Virtual Environment should not be shown');

        // Assert - "Browse..." should still be shown
        const browseItem = capturedItems.find((item) => item.label === Interpreter.browsePath);
        assert.ok(browseItem, 'Browse option should still be present');
    });

    test('should show Create Virtual Environment when Python is installed', async () => {
        // Mock - system manager with one Python environment
        const pythonEnv = createMockEnvironment('/usr/bin/python3');
        mockSystemManager = {
            id: 'ms-python.python:system',
            name: 'system',
            displayName: 'Global',
            getEnvironments: sinon.stub().resolves([pythonEnv]),
        };

        // Capture what items are shown in the quick pick
        let capturedItems: readonly QuickPickItem[] = [];
        showQuickPickWithButtonsStub.callsFake((items: readonly QuickPickItem[]) => {
            capturedItems = items;
            return Promise.resolve(undefined);
        });

        await pickEnvironment([mockSystemManager as InternalEnvironmentManager], [], { projects: [] });

        // Assert - "Create Virtual Environment" SHOULD be shown
        const createEnvItem = capturedItems.find((item) => item.label === Interpreter.createVirtualEnvironment);
        assert.ok(createEnvItem, 'Create Virtual Environment should be shown when Python is installed');

        // Assert - warning item should NOT be shown
        const warningItem = capturedItems.find((item) => item.label === Interpreter.noPythonInstalled);
        assert.strictEqual(warningItem, undefined, 'Warning should not be shown when Python is installed');

        // Assert - "Browse..." should still be shown
        const browseItem = capturedItems.find((item) => item.label === Interpreter.browsePath);
        assert.ok(browseItem, 'Browse option should still be present');
    });

    test('should handle missing system manager gracefully', async () => {
        // Mock - no system manager in the list
        const otherManager = {
            id: 'ms-python.python:conda',
            name: 'conda',
            displayName: 'Conda',
            getEnvironments: sinon.stub().resolves([]),
        };

        // Capture what items are shown in the quick pick
        let capturedItems: readonly QuickPickItem[] = [];
        showQuickPickWithButtonsStub.callsFake((items: readonly QuickPickItem[]) => {
            capturedItems = items;
            return Promise.resolve(undefined);
        });

        await pickEnvironment([otherManager as unknown as InternalEnvironmentManager], [], { projects: [] });

        // Assert - warning item should be shown when system manager is not found
        const warningItem = capturedItems.find((item) => item.label === Interpreter.noPythonInstalled);
        assert.ok(warningItem, 'Warning item should be present when system manager is missing');
    });
});
