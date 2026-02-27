import assert from 'node:assert';
import { CancellationError } from 'vscode';
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
    });
});
