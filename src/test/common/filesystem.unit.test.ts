// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import { isFileNotFoundError } from '../../common/utils/filesystem';

suite('filesystem utilities', () => {
    test('recognizes ENOENT errors', () => {
        const error = Object.assign(new Error('missing'), { code: 'ENOENT' });

        assert.strictEqual(isFileNotFoundError(error), true);
    });

    test('returns true for VS Code missing file errors', () => {
        assert.strictEqual(isFileNotFoundError(Object.assign(new Error('missing'), { code: 'FileNotFound' })), true);
        assert.strictEqual(
            isFileNotFoundError(Object.assign(new Error('missing'), { name: 'EntryNotFound (FileSystemError)' })),
            true,
        );
    });

    test('rejects other errors and non-errors', () => {
        assert.strictEqual(
            isFileNotFoundError(Object.assign(new Error('not a directory'), { code: 'ENOTDIR' })),
            false,
        );
        assert.strictEqual(isFileNotFoundError(new Error('missing code')), false);
        assert.strictEqual(isFileNotFoundError(undefined), false);
        assert.strictEqual(isFileNotFoundError('ENOENT'), false);
    });
});
