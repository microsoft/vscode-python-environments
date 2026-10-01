// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import * as sinon from 'sinon';
import { createExperimentationFetch, TAS_REQUEST_TIMEOUT_MS } from '../../../common/experimentation/transport';

suite('Experimentation transport', () => {
    let clock: sinon.SinonFakeTimers;
    let controller: AbortController;
    let request: ClientRequest;
    let response: IncomingMessage;
    let requestStub: sinon.SinonStub;
    let end: sinon.SinonStub;
    let destroy: sinon.SinonStub;
    let respond: (() => void) | undefined;

    setup(() => {
        clock = sinon.useFakeTimers();
        controller = new AbortController();
        end = sinon.stub();
        destroy = sinon.stub();
        request = Object.assign(new EventEmitter(), { end, destroy }) as unknown as ClientRequest;
        response = Object.assign(new EventEmitter(), { statusCode: 200 }) as unknown as IncomingMessage;
        destroy.callsFake((error: Error) => {
            request.emit('error', error);
            return request;
        });
        requestStub = sinon.stub().callsFake((
            _url: string,
            options: RequestOptions,
            callback: (message: IncomingMessage) => void,
        ) => {
            respond = () => callback(response);
            options.signal?.addEventListener('abort', () => request.destroy(new Error('aborted')), { once: true });
            return request;
        });
    });

    teardown(() => {
        clock.restore();
        sinon.restore();
    });

    test('passes method, headers, body and cancellation through the HTTPS stack', async () => {
        const fetch = createExperimentationFetch(controller.signal, requestStub);
        const pending = fetch('https://assignments.example.invalid/api/v1/assignments', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"value":true}',
        });
        respond!();
        response.emit('data', Buffer.from('{"value":'));
        response.emit('data', Buffer.from('true}'));
        response.emit('end');
        const result = await pending;
        assert.strictEqual(result.status, 200);
        assert.deepStrictEqual(await result.json(), { value: true });
        sinon.assert.calledOnceWithExactly(end, '{"value":true}');
        assert.strictEqual(requestStub.firstCall.args[1].signal, controller.signal);
        assert.strictEqual(requestStub.firstCall.args[1].headers['Content-Length'], '14');
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('preserves HTTP failure status without pretending malformed bodies are valid JSON', async () => {
        response.statusCode = 503;
        const pending = createExperimentationFetch(controller.signal, requestStub)(
            'https://assignments.example.invalid/api/v1/assignments', { method: 'GET', headers: {} },
        );
        respond!();
        response.emit('data', Buffer.from('unavailable'));
        response.emit('end');
        const result = await pending;
        assert.strictEqual(result.status, 503);
        await assert.rejects(result.json());
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('network failure is distinguishable from a server response', async () => {
        const pending = createExperimentationFetch(controller.signal, requestStub)(
            'https://assignments.example.invalid/api/v1/assignments', { method: 'GET', headers: {} },
        );
        const assertion = assert.rejects(pending, { responseReceived: false });
        request.emit('error', new Error('offline'));
        await assertion;
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('a deadline destroys a request and releases its timer', async () => {
        const pending = createExperimentationFetch(controller.signal, requestStub)(
            'https://assignments.example.invalid/api/v1/assignments', { method: 'GET', headers: {} },
        );
        const assertion = assert.rejects(pending, /timed out/);
        await clock.tickAsync(TAS_REQUEST_TIMEOUT_MS);
        await assertion;
        sinon.assert.calledOnce(destroy);
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('revocation aborts an in-flight request', async () => {
        const pending = createExperimentationFetch(controller.signal, requestStub)(
            'https://assignments.example.invalid/api/v1/assignments', { method: 'GET', headers: {} },
        );
        const assertion = assert.rejects(pending, /aborted/);
        controller.abort();
        await assertion;
        sinon.assert.calledOnce(destroy);
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('never starts a request after its lifetime is cancelled', async () => {
        controller.abort();
        await assert.rejects(createExperimentationFetch(controller.signal, requestStub)(
            'https://assignments.example.invalid/api/v1/assignments', { method: 'GET', headers: {} },
        ));
        sinon.assert.notCalled(requestStub);
    });

    test('rejects plaintext requests rather than sending identifiers over HTTP', async () => {
        await assert.rejects(createExperimentationFetch(controller.signal, requestStub)(
            'http://assignments.example.invalid/api/v1/assignments', { method: 'GET', headers: {} },
        ));
        sinon.assert.notCalled(requestStub);
    });

    test('caps response bodies', async () => {
        const pending = createExperimentationFetch(controller.signal, requestStub)(
            'https://assignments.example.invalid/api/v1/assignments', { method: 'GET', headers: {} },
        );
        const assertion = assert.rejects(pending, /size limit/);
        respond!();
        response.emit('data', Buffer.alloc(2 * 1024 * 1024 + 1));
        await assertion;
        sinon.assert.calledOnce(destroy);
    });

    test('an interrupted response is a failure, not a successful empty body', async () => {
        const pending = createExperimentationFetch(controller.signal, requestStub)(
            'https://assignments.example.invalid/api/v1/assignments', { method: 'GET', headers: {} },
        );
        const assertion = assert.rejects(pending, { responseReceived: true });
        respond!();
        response.emit('aborted');
        await assertion;
        assert.strictEqual(clock.countTimers(), 0);
    });
});
