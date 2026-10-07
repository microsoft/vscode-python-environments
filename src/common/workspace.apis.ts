import {
    CancellationToken,
    ConfigurationChangeEvent,
    ConfigurationScope,
    Disposable,
    FileDeleteEvent,
    FileRenameEvent,
    FileSystemWatcher,
    GlobPattern,
    TextDocument,
    TextDocumentChangeEvent,
    Uri,
    workspace,
    WorkspaceConfiguration,
    WorkspaceFolder,
    WorkspaceFoldersChangeEvent,
} from 'vscode';

export function getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined {
    return workspace.getWorkspaceFolder(uri);
}

export function getWorkspaceFolders(): readonly WorkspaceFolder[] | undefined {
    return workspace.workspaceFolders;
}

/** Returns whether the workspace is trusted. */
export function isWorkspaceTrusted(): boolean {
    return workspace.isTrusted;
}

export function getWorkspaceFile(): Uri | undefined {
    return workspace.workspaceFile;
}

export function getConfiguration(section?: string, scope?: ConfigurationScope | null): WorkspaceConfiguration {
    return workspace.getConfiguration(section, scope);
}

/** Subscribes the listener to configuration changes; its return value is ignored. */
export function onDidChangeConfiguration(listener: (e: ConfigurationChangeEvent) => void): Disposable {
    return workspace.onDidChangeConfiguration(listener);
}

/** Subscribes the listener to workspace folder changes; its return value is ignored. */
export function onDidChangeWorkspaceFolders(listener: (e: WorkspaceFoldersChangeEvent) => void): Disposable {
    return workspace.onDidChangeWorkspaceFolders(listener);
}

export function findFiles(
    include: GlobPattern,
    exclude?: GlobPattern | null,
    maxResults?: number,
    token?: CancellationToken,
): Thenable<Uri[]> {
    return workspace.findFiles(include, exclude, maxResults, token);
}

export function asRelativePath(pathOrUri: string | Uri, includeWorkspaceFolder?: boolean): string {
    return workspace.asRelativePath(pathOrUri, includeWorkspaceFolder);
}

export function createFileSystemWatcher(
    globPattern: GlobPattern,
    ignoreCreateEvents?: boolean,
    ignoreChangeEvents?: boolean,
    ignoreDeleteEvents?: boolean,
): FileSystemWatcher {
    return workspace.createFileSystemWatcher(globPattern, ignoreCreateEvents, ignoreChangeEvents, ignoreDeleteEvents);
}

/** Subscribes to deleted files, binding the listener to the optional receiver. */
export function onDidDeleteFiles<TThis = void>(
    listener: (this: TThis, e: FileDeleteEvent) => void,
    thisArgs?: TThis,
    disposables?: Disposable[],
): Disposable {
    return workspace.onDidDeleteFiles(listener, thisArgs, disposables);
}

/** Subscribes to renamed files, binding the listener to the optional receiver. */
export function onDidRenameFiles<TThis = void>(
    listener: (this: TThis, e: FileRenameEvent) => void,
    thisArgs?: TThis,
    disposables?: Disposable[],
): Disposable {
    return workspace.onDidRenameFiles(listener, thisArgs, disposables);
}

/** Subscribes to opened documents, binding the listener to the optional receiver. */
export function onDidOpenTextDocument<TThis = void>(
    listener: (this: TThis, e: TextDocument) => void,
    thisArgs?: TThis,
    disposables?: Disposable[],
): Disposable {
    return workspace.onDidOpenTextDocument(listener, thisArgs, disposables);
}

/** Subscribes to saved documents, binding the listener to the optional receiver. */
export function onDidSaveTextDocument<TThis = void>(
    listener: (this: TThis, e: TextDocument) => void,
    thisArgs?: TThis,
    disposables?: Disposable[],
): Disposable {
    return workspace.onDidSaveTextDocument(listener, thisArgs, disposables);
}

/** Subscribes to closed documents, binding the listener to the optional receiver. */
export function onDidCloseTextDocument<TThis = void>(
    listener: (this: TThis, e: TextDocument) => void,
    thisArgs?: TThis,
    disposables?: Disposable[],
): Disposable {
    return workspace.onDidCloseTextDocument(listener, thisArgs, disposables);
}

/** Subscribes to document changes, binding the listener to the optional receiver. */
export function onDidChangeTextDocument<TThis = void>(
    listener: (this: TThis, e: TextDocumentChangeEvent) => void,
    thisArgs?: TThis,
    disposables?: Disposable[],
): Disposable {
    return workspace.onDidChangeTextDocument(listener, thisArgs, disposables);
}

/**
 * Snapshot of the text documents VS Code has already opened. Useful
 * for extensions activated by `onLanguage:*` events, which miss the
 * `onDidOpenTextDocument` fired for the activating document.
 */
export function getOpenTextDocuments(): readonly TextDocument[] {
    return workspace.textDocuments;
}
