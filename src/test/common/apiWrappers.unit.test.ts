import assert from 'node:assert';
import { reset, verify, when } from 'ts-mockito';
import {
    Disposable,
    MessageItem,
    MessageOptions,
    QuickInputButton,
    QuickPick,
    QuickPickItem,
    TextDocument,
    ThemeIcon,
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

    function createQuickPickHarness() {
        const buttonListeners = new Set<(button: QuickInputButton) => void>();
        const acceptListeners = new Set<() => void>();
        const hideListeners = new Set<() => void>();
        let hideCount = 0;
        let disposeCount = 0;
        const register = <T>(listeners: Set<(event: T) => void>, listener: (event: T) => void) => {
            listeners.add(listener);
            return new Disposable(() => listeners.delete(listener));
        };
        const quickPick = {
            items: [],
            buttons: [],
            selectedItems: [],
            activeItems: [],
            onDidTriggerButton: (listener: (button: QuickInputButton) => void) => register(buttonListeners, listener),
            onDidAccept: (listener: () => void) => register(acceptListeners, listener),
            onDidHide: (listener: () => void) => register(hideListeners, listener),
            onDidTriggerItemButton: () => new Disposable(() => undefined),
            show: () => undefined,
            hide: () => {
                hideCount += 1;
                hideListeners.forEach((listener) => listener());
            },
            dispose: () => {
                disposeCount += 1;
            },
        } as unknown as QuickPick<QuickPickItem>;
        return {
            quickPick,
            triggerButton: (button: QuickInputButton) => buttonListeners.forEach((listener) => listener(button)),
            hide: () => quickPick.hide(),
            get hideCount() {
                return hideCount;
            },
            get disposeCount() {
                return disposeCount;
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

    test('keeps a quick pick open when a custom button handler succeeds', async () => {
        const harness = createQuickPickHarness();
        when(window.createQuickPick<QuickPickItem>()).thenReturn(harness.quickPick);
        const button: QuickInputButton = { iconPath: new ThemeIcon('refresh') };
        const handlerComplete = createDeferred<void>();
        let handled = false;
        const result = showQuickPickWithButtons([{ label: 'Environment' }], {
            buttons: [button],
            buttonHandler: () => {
                handled = true;
                return handlerComplete.promise;
            },
        });

        harness.triggerButton(button);
        await Promise.resolve();

        assert.strictEqual(handled, true);
        assert.strictEqual(harness.hideCount, 0);
        handlerComplete.resolve();
        await handlerComplete.promise;
        assert.strictEqual(harness.hideCount, 0);
        harness.hide();
        assert.strictEqual(await result, undefined);
        assert.strictEqual(harness.disposeCount, 1);
    });

    test('preserves legacy custom button rejection and hide behavior', async () => {
        const harness = createQuickPickHarness();
        when(window.createQuickPick<QuickPickItem>()).thenReturn(harness.quickPick);
        const button: QuickInputButton = { iconPath: new ThemeIcon('edit') };
        const item = { label: 'Environment' };
        const result = showQuickPickWithButtons([item], { buttons: [button], selected: [item] });

        harness.triggerButton(button);

        await assert.rejects(
            result,
            (error) =>
                typeof error === 'object' &&
                error !== null &&
                'button' in error &&
                error.button === button &&
                'item' in error &&
                Array.isArray(error.item) &&
                error.item[0] === item,
        );
        assert.strictEqual(harness.hideCount, 1);
    });

    test('rejects and hides a quick pick when its custom button handler fails', async () => {
        const harness = createQuickPickHarness();
        when(window.createQuickPick<QuickPickItem>()).thenReturn(harness.quickPick);
        const button: QuickInputButton = { iconPath: new ThemeIcon('refresh') };
        const failure = new Error('button handler failed');
        const result = showQuickPickWithButtons([{ label: 'Environment' }], {
            buttons: [button],
            buttonHandler: () => {
                throw failure;
            },
        });

        harness.triggerButton(button);

        await assert.rejects(result, (error) => error === failure);
        assert.strictEqual(harness.hideCount, 1);
    });
});
