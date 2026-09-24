// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

export function isFileNotFoundError(error: unknown): error is NodeJS.ErrnoException {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
    );
}
