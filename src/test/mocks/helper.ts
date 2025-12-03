/* eslint-disable @typescript-eslint/no-explicit-any */
// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { Readable } from 'stream';
import * as TypeMoq from 'typemoq';
import * as common from 'typemoq/Common/_all';

export class FakeReadableStream extends Readable {
    _read(_size: unknown): void | null {
        // custom reading logic here
        this.push(null); // end the stream
    }
}

/**
 * Type helper for accessing the `.then` property on mocks.
 * Used to prevent TypeMoq from treating mocks as thenables (Promise-like objects).
 * See: https://github.com/florinn/typemoq/issues/67
 */
export type Thenable = { then?: unknown };

/**
 * Sets up a mock to not be treated as a thenable (Promise-like object).
 * This is necessary due to a TypeMoq limitation where mocks can be confused with Promises.
 *
 * @param mock - The TypeMoq mock to configure
 * @example
 * const mock = TypeMoq.Mock.ofType<MyInterface>();
 * setupNonThenable(mock);
 */
export function setupNonThenable<T>(mock: TypeMoq.IMock<T>): void {
    mock.setup((x) => (x as unknown as Thenable).then).returns(() => undefined);
}

export function createTypeMoq<T>(
    targetCtor?: common.CtorWithArgs<T>,
    behavior?: TypeMoq.MockBehavior,
    shouldOverrideTarget?: boolean,
    ...targetCtorArgs: any[]
): TypeMoq.IMock<T> {
    // Use typemoqs for those things that are resolved as promises. mockito doesn't allow nesting of mocks. ES6 Proxy class
    // is the problem. We still need to make it thenable though. See this issue: https://github.com/florinn/typemoq/issues/67
    const result = TypeMoq.Mock.ofType<T>(targetCtor, behavior, shouldOverrideTarget, ...targetCtorArgs);
    setupNonThenable(result);
    return result;
}
