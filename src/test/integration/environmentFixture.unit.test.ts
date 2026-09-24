// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import { createSingleFlightOperation } from './environmentFixture';

suite('Environment fixture helpers', () => {
    test('shares a delayed operation across retries', async () => {
        let calls = 0;
        let resolveOperation: (() => void) | undefined;
        const getOperation = createSingleFlightOperation(
            () =>
                new Promise<void>((resolve) => {
                    calls++;
                    resolveOperation = resolve;
                }),
        );

        const first = getOperation();
        const retry = getOperation();

        assert.strictEqual(retry, first);
        assert.strictEqual(calls, 1);
        assert.ok(resolveOperation);
        resolveOperation();
        await Promise.all([first, retry]);
        assert.strictEqual(getOperation(), first);
        assert.strictEqual(calls, 1);
    });
});
