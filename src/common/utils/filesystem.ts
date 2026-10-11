// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Determines whether an error indicates that a file system entry does not exist.
 *
 * Supports Node.js and VS Code file system error codes.
 *
 * @param error The error to inspect.
 * @returns Whether the error represents a missing file system entry.
 */
export function isFileNotFoundError(error: unknown): error is NodeJS.ErrnoException {
    return (
        typeof error === 'object' &&
        error !== null &&
        (('code' in error &&
            ((error as NodeJS.ErrnoException).code === 'ENOENT' ||
                (error as NodeJS.ErrnoException).code === 'FileNotFound')) ||
            ('name' in error && String(error.name).startsWith('EntryNotFound')))
    );
}
