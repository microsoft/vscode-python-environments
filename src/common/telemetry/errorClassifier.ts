import { CancellationError } from 'vscode';
import * as rpc from 'vscode-jsonrpc/node';
import { RpcTimeoutError } from '../../managers/common/nativePythonFinder';
import { BaseError } from '../errors/types';

export type DiscoveryErrorType =
    | 'spawn_timeout'
    | 'spawn_enoent'
    | 'permission_denied'
    | 'canceled'
    | 'parse_error'
    | 'tool_not_found'
    | 'command_failed'
    | 'connection_error'
    | 'rpc_error'
    | 'process_crash'
    | 'already_registered'
    | 'unknown';

/**
 * Classifies an error into a telemetry-safe category for the `errorType` property.
 * Does NOT include raw error messages — only the category.
 */
export function classifyError(ex: unknown): DiscoveryErrorType {
    if (ex instanceof CancellationError) {
        return 'canceled';
    }

    if (ex instanceof RpcTimeoutError) {
        return 'spawn_timeout';
    }

    // JSON-RPC connection errors (e.g., PET process died mid-request, connection closed/disposed)
    if (ex instanceof rpc.ConnectionError) {
        return 'connection_error';
    }

    // JSON-RPC response errors (PET returned an error response, e.g., internal error)
    if (ex instanceof rpc.ResponseError) {
        return 'rpc_error';
    }

    // BaseError subclasses: EnvironmentManagerAlreadyRegisteredError, PackageManagerAlreadyRegisteredError
    if (ex instanceof BaseError) {
        return 'already_registered';
    }

    if (!(ex instanceof Error)) {
        return 'unknown';
    }

    // Check error code for spawn failures (Node.js sets `code` on spawn errors)
    const code = (ex as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
        return 'spawn_enoent';
    }
    if (code === 'EACCES' || code === 'EPERM') {
        return 'permission_denied';
    }

    // Check message patterns (order matters — more specific patterns first)
    const msg = ex.message.toLowerCase();
    if (msg.includes('timed out') || msg.includes('timeout')) {
        return 'spawn_timeout';
    }
    if (msg.includes('parse') || msg.includes('unexpected token') || msg.includes('json')) {
        return 'parse_error';
    }

    // Tool/executable not found — e.g., "Conda not found", "Python extension not found",
    // "Poetry executable not found"
    if (msg.includes('not found')) {
        return 'tool_not_found';
    }

    // CLI command execution failures — e.g., 'Failed to run "conda ..."',
    // "Failed to run poetry ...", "Error spawning conda: ..."
    if (msg.includes('failed to run') || msg.includes('error spawning')) {
        return 'command_failed';
    }

    // PET process crash/hang recovery failures — e.g., "PET is currently restarting",
    // "failed after 3 restart attempts", "Failed to create stdio streams for PET process"
    if (msg.includes('restart') || msg.includes('stdio stream')) {
        return 'process_crash';
    }

    // Check error name for cancellation variants
    if (ex.name === 'CancellationError' || ex.name === 'AbortError') {
        return 'canceled';
    }

    return 'unknown';
}
