import { getDefaultEnvManagerSetting, getDefaultPkgManagerSetting } from '../../features/settings/settingHelpers';
import { PythonProjectManager } from '../../internal.api';
import { EventNames } from './constants';
import { sendTelemetryEvent } from './sender';
import { InternalDidChangePackagesEventArgs } from '../../internal.api';
import { PackageChangeKind } from '../../api';

export function sendManagerSelectionTelemetry(pm: PythonProjectManager) {
    const ems: Set<string> = new Set();
    const ps: Set<string> = new Set();
    pm.getProjects().forEach((project) => {
        const m = getDefaultEnvManagerSetting(pm, project.uri);
        if (m) {
            ems.add(m);
        }

        const p = getDefaultPkgManagerSetting(pm, project.uri);
        if (p) {
            ps.add(p);
        }
    });

    ems.forEach((em) => {
        sendTelemetryEvent(EventNames.ENVIRONMENT_MANAGER_SELECTED, undefined, { managerId: em });
    });

    ps.forEach((pkg) => {
        sendTelemetryEvent(EventNames.PACKAGE_MANAGER_SELECTED, undefined, { managerId: pkg });
    });
}

/**
 * Determines the environment type from the environment ID or manager ID.
 */
function getEnvironmentType(environmentId: string, packageManagerId: string): string {
    // Extract environment type from environment ID
    if (environmentId.includes('conda')) {
        return 'conda';
    }
    if (environmentId.includes('venv') || environmentId.includes('.venv')) {
        return 'venv';
    }
    if (environmentId.includes('virtualenv')) {
        return 'virtualenv';
    }
    if (environmentId.includes('pyenv')) {
        return 'pyenv';
    }
    
    // Fall back to package manager ID if environment ID doesn't contain type info
    if (packageManagerId.includes('conda')) {
        return 'conda';
    }
    if (packageManagerId.includes('pip')) {
        return 'venv'; // pip is commonly used with venv
    }
    if (packageManagerId.includes('poetry')) {
        return 'poetry';
    }
    
    return 'system'; // Default fallback
}

/**
 * Determines the action type from package changes.
 */
function getActionFromChanges(changes: { kind: PackageChangeKind; pkg: unknown }[]): string {
    const hasInstalls = changes.some(change => change.kind === PackageChangeKind.add);
    const hasRemovals = changes.some(change => change.kind === PackageChangeKind.remove);
    
    if (hasInstalls && hasRemovals) {
        return 'change'; // Both installs and removals (could be upgrade)
    } else if (hasInstalls) {
        return 'install';
    } else if (hasRemovals) {
        return 'uninstall';
    } else {
        return 'change'; // Fallback
    }
}

/**
 * Sends telemetry for package changes detected via site-packages watcher.
 */
export function sendPackageChangeTelemetry(eventArgs: InternalDidChangePackagesEventArgs) {
    const environmentType = getEnvironmentType(eventArgs.environment.envId.id, eventArgs.manager.id);
    const action = getActionFromChanges(eventArgs.changes);
    const packageManager = eventArgs.manager.id;
    const packageCount = eventArgs.changes.length;

    sendTelemetryEvent(EventNames.PACKAGE_CHANGES, undefined, {
        environmentType,
        action,
        packageManager,
        packageCount,
    });
}
