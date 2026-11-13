// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'node:assert';
import * as path from 'path';
import * as sinon from 'sinon';
import {
    CancellationTokenSource,
    QuickInputButtons,
    QuickPick,
    QuickPickItem,
    Uri,
} from 'vscode';
import { PythonEnvironment } from '../../api';
import * as errorUtils from '../../common/errors/utils';
import { Interpreter, Pickers } from '../../common/localize';
import * as logging from '../../common/logging';
import { pickEnvironment } from '../../common/pickers/environments';
import * as managerPicker from '../../common/pickers/managers';
import { createDeferred } from '../../common/utils/deferred';
import * as pythonPath from '../../common/utils/pythonPath';
import type { QuickPickWithButtonsOptions } from '../../common/window.apis';
import * as windowApis from '../../common/window.apis';
import * as workspaceApis from '../../common/workspace.apis';
import type { InternalEnvironmentManager } from '../../managers/common/registeredManagers';
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
                assert.ok(items.some((item) => item.label === Interpreter.enterInterpreterPath));
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

suite('Environment Picker Refresh', () => {
    interface TestEnvironmentPickItem extends QuickPickItem {
        readonly result?: PythonEnvironment;
    }

    interface TestQuickPick extends QuickPick<TestEnvironmentPickItem> {
        fireHide(): void;
    }

    type TestPickerOptions = QuickPickWithButtonsOptions<TestEnvironmentPickItem>;

    function createManager(
        id: string,
        getEnvironments: sinon.SinonStub,
        refresh: sinon.SinonStub,
    ): InternalEnvironmentManager {
        return {
            id,
            displayName: id,
            supportsCreate: false,
            getEnvironments,
            refresh,
        } as unknown as InternalEnvironmentManager;
    }

    function createQuickPick(
        items: readonly TestEnvironmentPickItem[],
        activeItem?: TestEnvironmentPickItem,
    ): TestQuickPick {
        let hideListener: (() => void) | undefined;
        return {
            items,
            activeItems: activeItem ? [activeItem] : [],
            busy: false,
            enabled: true,
            keepScrollPosition: false,
            onDidHide: (listener: () => void) => {
                hideListener = listener;
                return {
                    dispose: () => {
                        hideListener = undefined;
                    },
                };
            },
            fireHide: () => hideListener?.(),
        } as unknown as TestQuickPick;
    }

    function getRefreshHandler(options: TestPickerOptions) {
        const button = options.buttons?.[0];
        const handler = options.buttonHandler;
        assert.ok(button, 'Expected a refresh button');
        assert.ok(handler, 'Expected a refresh button handler');
        return { button, handler };
    }

    setup(() => {
        sinon.stub(workspaceApis, 'getWorkspaceFolders').returns(undefined);
    });

    teardown(() => {
        sinon.restore();
    });

    test('refreshes every manager, rebuilds items, and preserves the recommended selection', async () => {
        const beforeRefresh = createMockPythonEnvironment({
            envPath: path.join(process.cwd(), 'current', 'python'),
            id: 'current-environment',
            managerId: 'first-manager',
            displayName: 'Current Python',
        });
        const afterRefresh = createMockPythonEnvironment({
            envPath: path.join(process.cwd(), 'current', 'python'),
            id: 'current-environment',
            managerId: 'first-manager',
            displayName: 'Current Python (refreshed)',
        });
        const firstGetEnvironments = sinon
            .stub()
            .onFirstCall()
            .resolves([beforeRefresh])
            .onSecondCall()
            .resolves([afterRefresh]);
        const secondGetEnvironments = sinon.stub().resolves([]);
        const firstRefresh = sinon.stub().resolves();
        const secondRefresh = sinon.stub().resolves();
        const managers = [
            createManager('first-manager', firstGetEnvironments, firstRefresh),
            createManager('second-manager', secondGetEnvironments, secondRefresh),
        ];

        sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async (items, options) => {
            const initialItems = items as readonly TestEnvironmentPickItem[];
            const recommendedItem = initialItems.find((item) => item.result === beforeRefresh);
            assert.strictEqual(recommendedItem?.result, beforeRefresh);
            const quickPick = createQuickPick(initialItems, recommendedItem);
            const { button, handler } = getRefreshHandler(options as TestPickerOptions);

            assert.strictEqual(button.tooltip, Pickers.Environments.refresh);
            await handler(button, quickPick);

            const refreshedItems = quickPick.items as readonly TestEnvironmentPickItem[];
            const refreshedRecommended = refreshedItems.find((item) => item.result === beforeRefresh);
            assert.ok(refreshedItems.some((item) => item.result === afterRefresh));
            assert.strictEqual(quickPick.activeItems[0], refreshedRecommended);
            assert.strictEqual(quickPick.keepScrollPosition, true);
            assert.strictEqual(quickPick.busy, false);
            assert.strictEqual(quickPick.enabled, true);
            return undefined;
        });

        assert.strictEqual(
            await pickEnvironment(managers, [], { projects: [], recommended: beforeRefresh }),
            undefined,
        );
        sinon.assert.calledOnceWithExactly(firstRefresh, undefined);
        sinon.assert.calledOnceWithExactly(secondRefresh, undefined);
        sinon.assert.calledTwice(firstGetEnvironments);
        sinon.assert.calledTwice(secondGetEnvironments);
    });

    test('coalesces duplicate refresh clicks while a refresh is running', async () => {
        const refreshComplete = createDeferred<void>();
        const refresh = sinon.stub().returns(refreshComplete.promise);
        const manager = createManager('test-manager', sinon.stub().resolves([]), refresh);

        sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async (items, options) => {
            const quickPick = createQuickPick(items as readonly TestEnvironmentPickItem[]);
            const { button, handler } = getRefreshHandler(options as TestPickerOptions);

            const first = handler(button, quickPick);
            const second = handler(button, quickPick);
            sinon.assert.calledOnce(refresh);

            refreshComplete.resolve();
            await Promise.all([first, second]);
            return undefined;
        });

        assert.strictEqual(await pickEnvironment([manager], [], { projects: [] }), undefined);
        sinon.assert.calledOnce(refresh);
    });

    test('does not rebuild or notify after the picker is cancelled during refresh', async () => {
        const refreshComplete = createDeferred<void>();
        const getEnvironments = sinon.stub().resolves([]);
        const manager = createManager('test-manager', getEnvironments, sinon.stub().returns(refreshComplete.promise));
        const showError = sinon.stub(errorUtils, 'showErrorMessageWithLogs').resolves();

        sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async (items, options) => {
            const initialItems = items as readonly TestEnvironmentPickItem[];
            const quickPick = createQuickPick(initialItems);
            const { button, handler } = getRefreshHandler(options as TestPickerOptions);

            const refreshing = handler(button, quickPick);
            quickPick.fireHide();
            refreshComplete.resolve();
            await refreshing;

            assert.strictEqual(quickPick.items, initialItems);
            return undefined;
        });

        assert.strictEqual(await pickEnvironment([manager], [], { projects: [] }), undefined);
        sinon.assert.calledOnce(getEnvironments);
        sinon.assert.notCalled(showError);
    });

    test('reports refresh and rebuild failures without blocking the existing picker', async () => {
        const getEnvironments = sinon
            .stub()
            .onFirstCall()
            .resolves([])
            .onSecondCall()
            .rejects(new Error('rebuild failed'));
        const refresh = sinon
            .stub()
            .onFirstCall()
            .resolves()
            .onSecondCall()
            .rejects(new Error('refresh failed'));
        const manager = createManager('test-manager', getEnvironments, refresh);
        const notificationComplete = createDeferred<void>();
        const showError = sinon.stub(errorUtils, 'showErrorMessageWithLogs').returns(notificationComplete.promise);
        const traceError = sinon.stub(logging, 'traceError');

        sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async (items, options) => {
            const initialItems = items as readonly TestEnvironmentPickItem[];
            const quickPick = createQuickPick(initialItems);
            const { button, handler } = getRefreshHandler(options as TestPickerOptions);

            await handler(button, quickPick);
            await handler(button, quickPick);

            assert.strictEqual(quickPick.items, initialItems);
            assert.strictEqual(quickPick.busy, false);
            assert.strictEqual(quickPick.enabled, true);
            return undefined;
        });

        assert.strictEqual(await pickEnvironment([manager], [], { projects: [] }), undefined);
        sinon.assert.calledTwice(refresh);
        sinon.assert.calledOnceWithExactly(showError, Pickers.Environments.refreshFailed);
        sinon.assert.calledTwice(getEnvironments);
        sinon.assert.calledTwice(traceError);
        notificationComplete.resolve();
    });

    test('preserves back and cancel semantics when the refresh button is present', async () => {
        const picker = sinon.stub(windowApis, 'showQuickPickWithButtons');
        picker.callsFake(async (_items, options) => {
            const pickerOptions = options as TestPickerOptions;
            assert.strictEqual(pickerOptions.showBackButton, true);
            assert.strictEqual(pickerOptions.buttons?.[0].tooltip, Pickers.Environments.refresh);
            throw QuickInputButtons.Back;
        });

        await assert.rejects(
            pickEnvironment([], [], { projects: [], showBackButton: true }),
            (error) => error === QuickInputButtons.Back,
        );

        picker.resolves(undefined);
        assert.strictEqual(await pickEnvironment([], [], { projects: [] }), undefined);
    });
});

suite('Environment Picker Interpreter Path Entry', () => {
    const interpreter = Uri.file(path.join(process.cwd(), 'project with spaces', '.venv', 'python'));
    const environment = createMockPythonEnvironment({ envPath: interpreter.fsPath });
    const managers = [{ getEnvironments: async () => [] }] as unknown as InternalEnvironmentManager[];
    const projectManagers = [{}] as InternalEnvironmentManager[];
    let input: sinon.SinonStub;
    let resolve: sinon.SinonStub;
    let showError: sinon.SinonStub;
    let tokenSource: CancellationTokenSource;
    const reporter = { report: sinon.stub() };

    setup(() => {
        tokenSource = new CancellationTokenSource();
        sinon.stub(workspaceApis, 'getWorkspaceFolders').returns(undefined);
        sinon
            .stub(windowApis, 'showQuickPickWithButtons')
            .callsFake(async (items) => items.find((item) => item.label === Interpreter.enterInterpreterPath));
        input = sinon.stub(windowApis, 'showInputBox');
        resolve = sinon.stub(pythonPath, 'handlePythonPath').resolves(environment);
        showError = sinon.stub(windowApis, 'showErrorMessage');
        sinon.stub(windowApis, 'withProgress').callsFake(async (_options, task) => task(reporter, tokenSource.token));
    });

    teardown(() => {
        tokenSource.dispose();
        sinon.restore();
    });

    for (const [name, typedInterpreter] of [
        ['native path', interpreter],
        [
            'uppercase Windows drive letter',
            Uri.from({
                scheme: 'file',
                path: path.posix.join('/', 'D:', 'project with spaces', '.venv', 'python.exe'),
            }),
        ],
    ] as const) {
        test(`resolves a typed path using the project and available managers: ${name}`, async () => {
            input.resolves(`  ${typedInterpreter.fsPath}  `);

            const selected = await pickEnvironment(managers, projectManagers, { projects: [] });

            assert.strictEqual(selected, environment);
            sinon.assert.calledOnce(input);
            sinon.assert.calledOnceWithExactly(
                resolve,
                sinon.match.instanceOf(Uri).and(sinon.match.has('fsPath', typedInterpreter.fsPath)),
                managers,
                projectManagers,
                reporter,
                tokenSource.token,
            );
            sinon.assert.notCalled(showError);
        });
    }

    for (const value of [undefined, '', '   ']) {
        test(`does not resolve or select an interpreter for cancelled or empty input: ${JSON.stringify(value)}`, async () => {
            input.resolves(value);

            assert.strictEqual(await pickEnvironment(managers, projectManagers, { projects: [] }), undefined);

            sinon.assert.notCalled(resolve);
            sinon.assert.notCalled(showError);
        });
    }

    test('reports an invalid interpreter without selecting an environment', async () => {
        input.resolves(interpreter.fsPath);
        resolve.resolves(undefined);

        assert.strictEqual(await pickEnvironment(managers, projectManagers, { projects: [] }), undefined);

        sinon.assert.calledOnce(resolve);
        sinon.assert.calledOnce(showError);
        assert.ok(showError.firstCall.args[0].includes(interpreter.fsPath));
    });

    test('still resolves an interpreter selected through Browse', async () => {
        (windowApis.showQuickPickWithButtons as sinon.SinonStub).callsFake(async (items) =>
            items.find((item: { label: string }) => item.label === Interpreter.browsePath),
        );
        sinon.stub(windowApis, 'showOpenDialog').resolves([interpreter]);

        assert.strictEqual(await pickEnvironment(managers, projectManagers, { projects: [] }), environment);

        sinon.assert.calledOnceWithExactly(
            resolve,
            interpreter,
            managers,
            projectManagers,
            reporter,
            tokenSource.token,
        );
        sinon.assert.notCalled(input);
        sinon.assert.notCalled(showError);
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
