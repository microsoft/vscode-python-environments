import { Extension, extensions } from 'vscode';

/** Looks up an extension by ID; callers specify its exported API type when needed. */
export function getExtension<T = unknown>(extensionId: string): Extension<T> | undefined {
    return extensions.getExtension<T>(extensionId);
}

/** Returns installed extensions without assuming a shared exported API type. */
export function allExtensions(): readonly Extension<unknown>[] {
    return extensions.all;
}
