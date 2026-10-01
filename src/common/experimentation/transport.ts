// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as https from 'https';
import type { FetchFn, IFetchResponse } from 'vscode-tas-client';

export const TAS_REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Create a cancellable HTTPS transport with request and response bounds. */
export function createExperimentationFetch(
    signal: AbortSignal,
    request: typeof https.request = https.request,
): FetchFn {
    return async (url, init): Promise<IFetchResponse> => {
        if (signal.aborted) {
            throw new Error('Experimentation request cancelled.');
        }
        if (new URL(url).protocol !== 'https:') {
            throw new Error('Experimentation requests require HTTPS.');
        }

        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await new Promise<IFetchResponse>((resolve, reject) => {
                let responseReceived = false;
                const fail = (error: Error) => reject(Object.assign(error, { responseReceived }));
                const req = request(url, {
                    method: init.method,
                    headers: {
                        ...init.headers,
                        ...(init.body === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(init.body)) }),
                    },
                    signal,
                }, (response) => {
                    responseReceived = true;
                    const chunks: Buffer[] = [];
                    let size = 0;
                    response.on('data', (chunk: Buffer | string) => {
                        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
                        size += buffer.length;
                        if (size > MAX_RESPONSE_BYTES) {
                            const error = new Error('Experimentation response exceeded the size limit.');
                            fail(error);
                            req.destroy(error);
                            return;
                        }
                        chunks.push(buffer);
                    });
                    response.on('error', fail);
                    response.on('aborted', () => fail(new Error('Experimentation response was interrupted.')));
                    response.on('end', () => {
                        const text = Buffer.concat(chunks).toString('utf8');
                        resolve({
                            status: response.statusCode ?? 0,
                            json: async (): Promise<unknown> => JSON.parse(text),
                        });
                    });
                });
                req.on('error', fail);
                timer = setTimeout(
                    () => req.destroy(new Error('Experimentation request timed out.')),
                    TAS_REQUEST_TIMEOUT_MS,
                );
                timer.unref();
                req.end(init.body);
            });
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    };
}
