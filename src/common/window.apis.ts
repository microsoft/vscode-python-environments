import {
    CancellationToken,
    Disposable,
    ExtensionTerminalOptions,
    InputBox,
    InputBoxOptions,
    QuickInputButton,
    QuickInputButtons,
    QuickPick,
    QuickPickItem,
    QuickPickItemButtonEvent,
    QuickPickOptions,
    StatusBarAlignment,
    StatusBarItem,
    Terminal,
    TerminalOptions,
    TerminalShellExecutionEndEvent,
    TerminalShellIntegrationChangeEvent,
    TextEditor,
    Uri,
    window,
} from 'vscode';
import { createDeferred } from './utils/deferred';

export function createStatusBarItem(id: string, alignment?: StatusBarAlignment, priority?: number): StatusBarItem {
    return window.createStatusBarItem(id, alignment, priority);
}

export function createTerminal(options: ExtensionTerminalOptions | TerminalOptions): Terminal {
    return window.createTerminal(options);
}

export function onDidChangeTerminalShellIntegration(
    listener: (e: TerminalShellIntegrationChangeEvent) => any,
    thisArgs?: any,
    disposables?: Disposable[],
): Disposable {
    return window.onDidChangeTerminalShellIntegration(listener, thisArgs, disposables);
}

export function terminals(): readonly Terminal[] {
    return window.terminals;
}

export function activeTerminal(): Terminal | undefined {
    return window.activeTerminal;
}

export function onDidEndTerminalShellExecution(
    listener: (e: TerminalShellExecutionEndEvent) => any,
    thisArgs?: any,
    disposables?: Disposable[],
): Disposable {
    return window.onDidEndTerminalShellExecution(listener, thisArgs, disposables);
}

export function onDidOpenTerminal(
    listener: (terminal: Terminal) => any,
    thisArgs?: any,
    disposables?: Disposable[],
): Disposable {
    return window.onDidOpenTerminal(listener, thisArgs, disposables);
}

export function onDidCloseTerminal(
    listener: (terminal: Terminal) => any,
    thisArgs?: any,
    disposables?: Disposable[],
): Disposable {
    return window.onDidCloseTerminal(listener, thisArgs, disposables);
}

export function showTextDocument(uri: Uri): Thenable<TextEditor> {
    return window.showTextDocument(uri);
}

export interface QuickPickButtonEvent<T extends QuickPickItem> {
    readonly item: T | readonly T[] | undefined;
    readonly button: QuickInputButton;
}

export async function showQuickPickWithButtons<T extends QuickPickItem>(
    items: readonly T[],
    options?: QuickPickOptions & { showBackButton?: boolean; buttons?: QuickInputButton[]; selected?: T[] },
    token?: CancellationToken,
    itemButtonHandler?: (e: QuickPickItemButtonEvent<T>) => void,
): Promise<T | T[] | undefined> {
    const quickPick: QuickPick<T> = window.createQuickPick<T>();
    const disposables: Disposable[] = [quickPick];
    const deferred = createDeferred<T | T[] | undefined>();

    quickPick.items = items;
    quickPick.canSelectMany = options?.canPickMany ?? false;
    quickPick.ignoreFocusOut = options?.ignoreFocusOut ?? false;
    quickPick.matchOnDescription = options?.matchOnDescription ?? false;
    quickPick.matchOnDetail = options?.matchOnDetail ?? false;
    quickPick.placeholder = options?.placeHolder;
    quickPick.title = options?.title;
    quickPick.selectedItems = options?.selected ?? [];

    if (options?.showBackButton) {
        quickPick.buttons = [QuickInputButtons.Back];
    }

    if (options?.buttons) {
        quickPick.buttons = [...quickPick.buttons, ...options.buttons];
    }

    disposables.push(
        quickPick.onDidTriggerButton((button) => {
            if (button === QuickInputButtons.Back) {
                deferred.reject(QuickInputButtons.Back);
                quickPick.hide();
            } else if (options?.buttons?.includes(button)) {
                deferred.reject({ item: quickPick.selectedItems, button });
                quickPick.hide();
            }
        }),
        quickPick.onDidAccept(() => {
            if (!deferred.completed) {
                if (quickPick.canSelectMany) {
                    deferred.resolve(quickPick.selectedItems.map((item) => item));
                } else {
                    deferred.resolve(quickPick.selectedItems[0]);
                }

                quickPick.hide();
            }
        }),
        quickPick.onDidHide(() => {
            if (!deferred.completed) {
                deferred.resolve(undefined);
            }
        }),
        quickPick.onDidTriggerItemButton((e) => {
            if (itemButtonHandler) {
                itemButtonHandler(e);
            }
        }),
    );
    if (token) {
        disposables.push(
            token.onCancellationRequested(() => {
                quickPick.hide();
            }),
        );
    }
    quickPick.show();

    try {
        return await deferred.promise;
    } finally {
        disposables.forEach((d) => d.dispose());
    }
}

export async function showInputBoxWithButtons(
    options?: InputBoxOptions & { showBackButton?: boolean },
): Promise<string | undefined> {
    const inputBox: InputBox = window.createInputBox();
    const disposables: Disposable[] = [inputBox];
    const deferred = createDeferred<string | undefined>();

    inputBox.placeholder = options?.placeHolder;
    inputBox.title = options?.title;
    inputBox.value = options?.value ?? '';
    inputBox.ignoreFocusOut = options?.ignoreFocusOut ?? false;
    inputBox.password = options?.password ?? false;
    inputBox.prompt = options?.prompt;

    if (options?.valueSelection) {
        inputBox.valueSelection = options?.valueSelection;
    }

    if (options?.showBackButton) {
        inputBox.buttons = [QuickInputButtons.Back];
    }

    disposables.push(
        inputBox.onDidTriggerButton((button) => {
            if (button === QuickInputButtons.Back) {
                deferred.reject(QuickInputButtons.Back);
                inputBox.hide();
            }
        }),
        inputBox.onDidAccept(() => {
            if (!deferred.completed) {
                deferred.resolve(inputBox.value);
                inputBox.hide();
            }
        }),
        inputBox.onDidHide(() => {
            if (!deferred.completed) {
                deferred.resolve(undefined);
            }
        }),
        inputBox.onDidChangeValue(async (value) => {
            if (options?.validateInput) {
                const validation = await options?.validateInput(value);
                if (validation === null || validation === undefined) {
                    inputBox.validationMessage = undefined;
                } else {
                    inputBox.validationMessage = validation;
                }
            }
        }),
    );

    inputBox.show();

    try {
        return await deferred.promise;
    } finally {
        disposables.forEach((d) => d.dispose());
    }
}
