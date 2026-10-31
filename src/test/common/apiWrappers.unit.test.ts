import assert from 'node:assert';
import { reset, verify, when } from 'ts-mockito';
import {
    Disposable,
    EventEmitter,
    MessageItem,
    MessageOptions,
    QuickInputButton,
    QuickPick,
    QuickPickItem,
    QuickPickItemButtonEvent,
    TextDocument,
    WindowState,
} from 'vscode';
import { executeCommand, registerCommand } from '../../common/command.api';
import { createDeferred } from '../../common/utils/deferred';
import { onDidChangeWindowState, showQuickPickWithButtons, showWarningMessage } from '../../common/window.apis';
import { onDidOpenTextDocument } from '../../common/workspace.apis';
import { mockedVSCodeNamespaces } from '../unittests';

suite('Typed API wrappers', () => {
    const commands = mockedVSCodeNamespaces.commands!;
    const window = mockedVSCodeNamespaces.window!;
    const workspace = mockedVSCodeNamespaces.workspace!;

    function createFakeQuickPick<T extends QuickPickItem>() {
        const didAccept = new EventEmitter<void>();
        const didHide = new EventEmitter<void>();
        const didTriggerButton = new EventEmitter<QuickInputButton>();
        const didTriggerItemButton = new EventEmitter<QuickPickItemButtonEvent<T>>();
        let items: readonly T[] = [];
        let activeItems: readonly T[] = [];
        let selectedItems: readonly T[] = [];
        let activeItemsSetCount = 0;
        let showCount = 0;
        let disposeCount = 0;
        const quickPick = {
            get items() {
                return items;
            },
            set items(value: readonly T[]) {
                items = value;
                activeItems = [];
                selectedItems = [];
            },
            get activeItems() {
                return activeItems;
            },
            set activeItems(value: readonly T[]) {
                activeItems = value;
                activeItemsSetCount += 1;
            },
            get selectedItems() {
                return selectedItems;
            },
            set selectedItems(value: readonly T[]) {
                selectedItems = value;
            },
            buttons: [],
            show: () => {
                showCount += 1;
            },
            hide: () => didHide.fire(),
            dispose: () => {
                disposeCount += 1;
            },
            onDidAccept: didAccept.event,
            onDidHide: didHide.event,
            onDidTriggerButton: didTriggerButton.event,
            onDidTriggerItemButton: didTriggerItemButton.event,
        } as unknown as QuickPick<T>;
        return {
            quickPick,
            hide: () => didHide.fire(),
            get showCount() {
                return showCount;
            },
            get disposeCount() {
                return disposeCount;
            },
            get activeItemsSetCount() {
                return activeItemsSetCount;
            },
        };
    }

    teardown(() => {
        reset(commands);
        reset(window);
        reset(workspace);
    });

    test('registers typed command arguments and receiver without replacing the callback', () => {
        const receiver = { prefix: 'result' };
        const callback = function (this: typeof receiver, count: number, enabled: boolean): string {
            return `${this.prefix}:${count}:${enabled}`;
        };
        const disposable = new Disposable(() => {});
        when(commands.registerCommand('test.typed', callback, receiver)).thenReturn(disposable);

        assert.strictEqual(registerCommand('test.typed', callback, receiver), disposable);
        verify(commands.registerCommand('test.typed', callback, receiver)).once();
    });

    test('forwards heterogeneous command arguments and the result', async () => {
        const options = { enabled: true };
        const result = { count: 2 };
        when(commands.executeCommand('test.typed', 'value', 2, options)).thenReturn(Promise.resolve(result));

        const actual = await executeCommand<typeof result>('test.typed', 'value', 2, options);

        assert.strictEqual(actual, result);
        assert.strictEqual(actual.count, 2);
    });

    test('forwards window event listeners, receivers, and disposables', () => {
        const receiver = { focused: false };
        const listener = function (this: typeof receiver, event: WindowState): void {
            this.focused = event.focused;
        };
        const disposables: Disposable[] = [];
        const disposable = new Disposable(() => {});
        when(window.onDidChangeWindowState(listener, receiver, disposables)).thenReturn(disposable);

        assert.strictEqual(onDidChangeWindowState(listener, receiver, disposables), disposable);
        verify(window.onDidChangeWindowState(listener, receiver, disposables)).once();
    });

    test('accepts async workspace listeners with a typed receiver', () => {
        const receiver = { language: '' };
        const listener = async function (this: typeof receiver, document: TextDocument): Promise<void> {
            this.language = document.languageId;
        };
        const disposables: Disposable[] = [];
        const disposable = new Disposable(() => {});
        when(workspace.onDidOpenTextDocument(listener, receiver, disposables)).thenReturn(disposable);

        assert.strictEqual(onDidOpenTextDocument(listener, receiver, disposables), disposable);
        verify(workspace.onDidOpenTextDocument(listener, receiver, disposables)).once();
    });

    test('shows a warning without actions', async () => {
        when(window.showWarningMessage('warning')).thenReturn(Promise.resolve(undefined));

        assert.strictEqual(await showWarningMessage('warning'), undefined);
        verify(window.showWarningMessage('warning')).once();
    });

    test('preserves string warning actions without options', async () => {
        when(window.showWarningMessage('warning', 'Continue', 'Cancel')).thenReturn(Promise.resolve('Continue'));

        const selected: 'Continue' | 'Cancel' | undefined = await showWarningMessage('warning', 'Continue', 'Cancel');

        assert.strictEqual(selected, 'Continue');
    });

    test('preserves string warning actions with options', async () => {
        const options: MessageOptions = { modal: true };
        when(window.showWarningMessage('warning', options, 'Continue', 'Cancel')).thenReturn(Promise.resolve('Cancel'));

        const selected: 'Continue' | 'Cancel' | undefined = await showWarningMessage(
            'warning',
            options,
            'Continue',
            'Cancel',
        );

        assert.strictEqual(selected, 'Cancel');
    });

    test('preserves object warning actions without options', async () => {
        const action = { title: 'Continue', id: 1 } satisfies MessageItem & { id: number };
        when(window.showWarningMessage('warning', action)).thenReturn(Promise.resolve(action));

        const selected = await showWarningMessage('warning', action);

        assert.strictEqual(selected, action);
        assert.strictEqual(selected?.id, 1);
    });

    test('preserves object warning actions with options', async () => {
        const options: MessageOptions = { modal: true };
        const action = { title: 'Continue', id: 1 } satisfies MessageItem & { id: number };
        when(window.showWarningMessage('warning', options, action)).thenReturn(Promise.resolve(action));

        const selected = await showWarningMessage('warning', options, action);

        assert.strictEqual(selected, action);
        assert.strictEqual(selected?.id, 1);
    });

    test('updates quick pick items without losing focus while loading', async () => {
        const fake = createFakeQuickPick<QuickPickItem>();
        const initial = { label: 'initial' };
        const discovered = { label: 'discovered' };
        const release = createDeferred<void>();
        const loaderStarted = createDeferred<void>();
        const loaderFinished = createDeferred<void>();
        when(window.createQuickPick<QuickPickItem>()).thenReturn(fake.quickPick);

        const selection = showQuickPickWithButtons([initial], {
            itemLoader: async (updateItems) => {
                loaderStarted.resolve();
                await release.promise;
                updateItems([initial, discovered]);
                loaderFinished.resolve();
            },
        });
        await loaderStarted.promise;

        fake.quickPick.activeItems = [initial];
        fake.quickPick.selectedItems = [initial];
        assert.strictEqual(fake.quickPick.busy, true);
        assert.strictEqual(fake.showCount, 1);

        release.resolve();
        await loaderFinished.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));

        assert.deepStrictEqual(fake.quickPick.items, [initial, discovered]);
        assert.deepStrictEqual(fake.quickPick.activeItems, [initial]);
        assert.deepStrictEqual(fake.quickPick.selectedItems, [initial]);
        assert.strictEqual(fake.activeItemsSetCount, 2);
        assert.strictEqual(fake.quickPick.keepScrollPosition, true);
        assert.strictEqual(fake.quickPick.busy, false);

        fake.hide();
        assert.strictEqual(await selection, undefined);
    });

    test('ignores item updates after the quick pick is dismissed', async () => {
        const fake = createFakeQuickPick<QuickPickItem>();
        const initial = { label: 'initial' };
        const release = createDeferred<void>();
        const loaderStarted = createDeferred<void>();
        const loaderFinished = createDeferred<void>();
        when(window.createQuickPick<QuickPickItem>()).thenReturn(fake.quickPick);

        const selection = showQuickPickWithButtons([initial], {
            itemLoader: async (updateItems) => {
                loaderStarted.resolve();
                await release.promise;
                updateItems([{ label: 'late result' }]);
                loaderFinished.resolve();
            },
        });
        await loaderStarted.promise;

        fake.hide();
        assert.strictEqual(await selection, undefined);
        assert.strictEqual(fake.disposeCount, 1);

        release.resolve();
        await loaderFinished.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));

        assert.deepStrictEqual(fake.quickPick.items, [initial]);
        assert.strictEqual(fake.showCount, 1);
    });

    test('does not clear focus when items load before the initial focus is established', async () => {
        const fake = createFakeQuickPick<QuickPickItem>();
        const loaderFinished = createDeferred<void>();
        when(window.createQuickPick<QuickPickItem>()).thenReturn(fake.quickPick);

        const selection = showQuickPickWithButtons([{ label: 'initial' }], {
            itemLoader: async (updateItems) => {
                updateItems([{ label: 'initial' }, { label: 'discovered' }]);
                loaderFinished.resolve();
            },
        });
        await loaderFinished.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));

        assert.strictEqual(fake.activeItemsSetCount, 0);

        fake.hide();
        assert.strictEqual(await selection, undefined);
    });
});
