/* eslint-disable @typescript-eslint/no-explicit-any */
import { Extension, extensions } from 'vscode';

export function getExtension<T = any>(extensionId: string): Extension<T> | undefined {
    return extensions.getExtension(extensionId);
}

export function allExtensions(): readonly Extension<any>[] {
    return extensions.all;
}

export function allExternalExtensions(): readonly Extension<any>[] {
    return allExtensions().filter((extension) => {
        try {
            return extension.packageJSON.publisher !== 'vscode';
        } catch {
            // No publisher
            return false;
        }
    });
}
