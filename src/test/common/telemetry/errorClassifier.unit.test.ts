import assert from 'node:assert';
import { CancellationError } from 'vscode';
import * as rpc from 'vscode-jsonrpc/node';
import { BaseError } from '../../../common/errors/types';
import { classifyError } from '../../../common/telemetry/errorClassifier';
import { RpcTimeoutError } from '../../../managers/common/nativePythonFinder';

suite('Error Classifier', () => {
    suite('classifyError', () => {
        test('should classify CancellationError as canceled', () => {
            assert.strictEqual(classifyError(new CancellationError()), 'canceled');
        });

        test('should classify RpcTimeoutError as spawn_timeout', () => {
            assert.strictEqual(classifyError(new RpcTimeoutError('resolve', 30000)), 'spawn_timeout');
        });

        test('should classify non-Error values as unknown', () => {
            assert.strictEqual(classifyError('string error'), 'unknown');
            assert.strictEqual(classifyError(42), 'unknown');
            assert.strictEqual(classifyError(null), 'unknown');
            assert.strictEqual(classifyError(undefined), 'unknown');
        });

        test('should classify ENOENT errors as spawn_enoent', () => {
            const err = new Error('spawn python ENOENT') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            assert.strictEqual(classifyError(err), 'spawn_enoent');
        });

        test('should classify EACCES errors as permission_denied', () => {
            const err = new Error('permission denied') as NodeJS.ErrnoException;
            err.code = 'EACCES';
            assert.strictEqual(classifyError(err), 'permission_denied');
        });

        test('should classify EPERM errors as permission_denied', () => {
            const err = new Error('operation not permitted') as NodeJS.ErrnoException;
            err.code = 'EPERM';
            assert.strictEqual(classifyError(err), 'permission_denied');
        });

        test('should classify timeout messages as spawn_timeout', () => {
            assert.strictEqual(classifyError(new Error('Request timed out')), 'spawn_timeout');
            assert.strictEqual(classifyError(new Error('Connection timeout')), 'spawn_timeout');
        });

        test('should classify parse errors as parse_error', () => {
            assert.strictEqual(classifyError(new Error('Failed to parse output')), 'parse_error');
            assert.strictEqual(classifyError(new Error('Unexpected token < in JSON')), 'parse_error');
            assert.strictEqual(classifyError(new Error('Invalid JSON response')), 'parse_error');
        });

        test('should classify AbortError name as canceled', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            assert.strictEqual(classifyError(err), 'canceled');
        });

        test('should classify error with CancellationError name as canceled', () => {
            const err = new Error('cancelled');
            err.name = 'CancellationError';
            assert.strictEqual(classifyError(err), 'canceled');
        });

        test('should classify unrecognized errors as unknown', () => {
            assert.strictEqual(classifyError(new Error('something went wrong')), 'unknown');
        });

        test('should classify ConnectionError as connection_error', () => {
            assert.strictEqual(
                classifyError(new rpc.ConnectionError(rpc.ConnectionErrors.Closed, 'Connection closed')),
                'connection_error',
            );
            assert.strictEqual(
                classifyError(new rpc.ConnectionError(rpc.ConnectionErrors.Disposed, 'Connection disposed')),
                'connection_error',
            );
        });

        test('should classify ResponseError as rpc_error', () => {
            assert.strictEqual(classifyError(new rpc.ResponseError(-32600, 'Invalid request')), 'rpc_error');
            assert.strictEqual(classifyError(new rpc.ResponseError(-32601, 'Method not found')), 'rpc_error');
        });

        test('should classify BaseError subclasses as already_registered', () => {
            // Using a concrete subclass to test (BaseError is abstract)
            class TestRegisteredError extends BaseError {
                constructor(message: string) {
                    super('InvalidArgument', message);
                }
            }
            assert.strictEqual(
                classifyError(new TestRegisteredError('Environment manager with id test already registered')),
                'already_registered',
            );
        });

        test('should classify "not found" messages as tool_not_found', () => {
            assert.strictEqual(classifyError(new Error('Conda not found')), 'tool_not_found');
            assert.strictEqual(classifyError(new Error('Python extension not found')), 'tool_not_found');
            assert.strictEqual(classifyError(new Error('Poetry executable not found')), 'tool_not_found');
        });

        test('should classify command execution failures as command_failed', () => {
            assert.strictEqual(
                classifyError(new Error('Failed to run "conda info --envs --json":\n some error')),
                'command_failed',
            );
            assert.strictEqual(classifyError(new Error('Failed to run poetry install')), 'command_failed');
            assert.strictEqual(classifyError(new Error('Error spawning conda: ENOENT')), 'command_failed');
        });

        test('should classify PET process crash/restart errors as process_crash', () => {
            assert.strictEqual(
                classifyError(new Error('Python Environment Tools (PET) is currently restarting. Please try again.')),
                'process_crash',
            );
            assert.strictEqual(
                classifyError(new Error('Python Environment Tools (PET) failed after 3 restart attempts.')),
                'process_crash',
            );
            assert.strictEqual(
                classifyError(new Error('Failed to create stdio streams for PET process')),
                'process_crash',
            );
        });
    });
});
