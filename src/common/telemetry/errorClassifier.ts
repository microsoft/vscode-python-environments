import { CancellationError } from 'vscode';
import { RpcTimeoutError } from '../../managers/common/nativePythonFinder';

export type DiscoveryErrorType =
    | 'spawn_timeout'
    | 'spawn_enoent'
    | 'spawn_error'
    | 'permission_denied'
    | 'canceled'
    | 'parse_error'
    | 'pet_crash'
    | 'pet_not_found'
    | 'tool_exec_failed'
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

    const msg = ex.message;
    const msgLower = msg.toLowerCase();

    // PET process failures (crash, restart exhaustion, stdio failure)
    if (
        msgLower.includes('python environment tools (pet)') ||
        msgLower.includes('failed to create stdio streams for pet')
    ) {
        return 'pet_crash';
    }

    // Missing PET binary / Python extension not found
    if (msgLower.includes('python extension not found')) {
        return 'pet_not_found';
    }

    // Wrapped spawn errors from condaUtils / other managers (e.g. "Error spawning conda: spawn conda ENOENT")
    if (msgLower.includes('error spawning')) {
        if (msgLower.includes('enoent')) {
            return 'spawn_enoent';
        }
        if (msgLower.includes('eacces') || msgLower.includes('eperm')) {
            return 'permission_denied';
        }
        return 'spawn_error';
    }

    // Non-zero exit code failures (e.g. "Failed to run "conda info --envs --json":\n ...")
    if (msgLower.includes('failed to run')) {
        return 'tool_exec_failed';
    }

    // Check message patterns for timeouts
    if (msgLower.includes('timed out') || msgLower.includes('timeout')) {
        return 'spawn_timeout';
    }

    // Parse / JSON errors (including "conda info returned invalid data type")
    if (
        msgLower.includes('parse') ||
        msgLower.includes('unexpected token') ||
        msgLower.includes('json') ||
        msgLower.includes('invalid data type')
    ) {
        return 'parse_error';
    }

    // Check error name for cancellation variants
    if (ex.name === 'CancellationError' || ex.name === 'AbortError') {
        return 'canceled';
    }

    return 'unknown';
}
