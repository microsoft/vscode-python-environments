import path from 'path';
import { PythonEnvironment } from '../../api';
import { INLINE_SCRIPT_MANAGER_ID } from '../constants';
import { normalizePath } from './pathUtils';

/**
 * Determines whether two descriptors should represent the same checked project
 * in an environment-selection picker.
 *
 * Stable IDs take precedence. A normalized absolute interpreter path is used as
 * a fallback because manager discovery can recreate an equivalent descriptor.
 */
export function isSameEnvironmentForProjectSelection(
    first: PythonEnvironment | undefined,
    second: PythonEnvironment | undefined,
): boolean {
    if (first === second) {
        return true;
    }
    if (!first || !second || first.envId.managerId !== second.envId.managerId) {
        return false;
    }
    if (first.envId.managerId === INLINE_SCRIPT_MANAGER_ID) {
        return haveSameEnvironmentPath(first, second) && first.version === second.version;
    }
    return first.envId.id === second.envId.id || haveSameEnvironmentPath(first, second);
}

function haveSameEnvironmentPath(first: PythonEnvironment, second: PythonEnvironment): boolean {
    return (
        normalizePath(path.resolve(first.environmentPath.fsPath)) ===
        normalizePath(path.resolve(second.environmentPath.fsPath))
    );
}
