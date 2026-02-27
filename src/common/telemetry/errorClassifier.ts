import { CancellationError } from 'vscode';
import { RpcTimeoutError } from '../../managers/common/nativePythonFinder';

export type DiscoveryErrorType =
    | 'spawn_timeout'
    | 'spawn_enoent'
    | 'permission_denied'
    | 'canceled'
    | 'parse_error'
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

    // Check message patterns
    const msg = ex.message.toLowerCase();
    if (msg.includes('timed out') || msg.includes('timeout')) {
        return 'spawn_timeout';
    }
    if (msg.includes('parse') || msg.includes('unexpected token') || msg.includes('json')) {
        return 'parse_error';
    }

    // Check error name for cancellation variants
    if (ex.name === 'CancellationError' || ex.name === 'AbortError') {
        return 'canceled';
    }

    return 'unknown';
}
