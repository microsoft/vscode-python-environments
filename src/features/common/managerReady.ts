import { Disposable, l10n, Uri } from 'vscode';
import { getExtension } from '../../common/extension.apis';
import { WorkbenchStrings } from '../../common/localize';
import { traceError, traceInfo, traceWarn } from '../../common/logging';
import { EventNames } from '../../common/telemetry/constants';
import { sendTelemetryEvent } from '../../common/telemetry/sender';
import { createDeferred, Deferred } from '../../common/utils/deferred';
import { showErrorMessage } from '../../common/window.apis';
import { installExtension } from '../../common/workbenchCommands';
import { EnvironmentManagers, PythonProjectManager } from '../../internal.api';
import { getDefaultEnvManagerSetting, getDefaultPkgManagerSetting } from '../settings/settingHelpers';

export const MANAGER_READY_TIMEOUT_MS = 30_000;

interface ManagerReady extends Disposable {
    waitForEnvManager(uris?: Uri[]): Promise<void>;
    waitForEnvManagerId(managerIds: string[]): Promise<void>;
    waitForAllEnvManagers(): Promise<void>;
    waitForPkgManager(uris?: Uri[]): Promise<void>;
    waitForPkgManagerId(managerIds: string[]): Promise<void>;
}

function getExtensionId(managerId: string): string | undefined {
    // format <extension-id>:<manager-name>
    const regex = /^(.*):([a-zA-Z0-9-_]*)$/;
    const parts = regex.exec(managerId);
    return parts ? parts[1] : undefined;
}

/**
 * Wraps a deferred with a timeout so a missing/dead manager cannot block the API forever.
 * On timeout the deferred is resolved (not rejected) so callers proceed with degraded results
 * instead of hanging. If the manager's extension is genuinely not installed when the timeout
 * fires, the user is prompted to install it.
 */
export function withManagerTimeout(
    deferred: Deferred<void>,
    managerId: string,
    kind: 'environment' | 'package',
): Promise<void> {
    if (deferred.completed) {
        return deferred.promise;
    }

    return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
            if (!deferred.completed) {
                traceWarn(
                    `Timed out after ${MANAGER_READY_TIMEOUT_MS / 1000}s waiting for ${kind} manager "${managerId}" to register. ` +
                        `The manager may not be installed or its extension failed to activate. Proceeding without it. ` +
                        `To prevent this, check your "python-envs.defaultEnvManager" and "python-envs.pythonProjects" settings.`,
                );
                sendTelemetryEvent(EventNames.MANAGER_READY_TIMEOUT, undefined, {
                    managerId,
                    managerKind: kind,
                });
                deferred.resolve();
                void promptInstallExtensionIfMissing(managerId).catch((err) => {
                    traceError(`Failed to prompt installation for manager extension "${managerId}".`, err);
                });
            }
        }, MANAGER_READY_TIMEOUT_MS);

        deferred.promise.then(
            () => {
                clearTimeout(timer);
                resolve();
            },
            () => {
                clearTimeout(timer);
                resolve();
            },
        );
    });
}

/**
 * Shows an install prompt only if the extension for the given manager ID
 * is genuinely not available. Called after the timeout expires, giving the
 * extension host ample time to initialize. Deduplicated per extension ID
 * so each missing extension only prompts once per session.
 */
const prompted: Set<string> = new Set();
async function promptInstallExtensionIfMissing(managerId: string): Promise<void> {
    const extId = getExtensionId(managerId);
    if (!extId) {
        showErrorMessage(l10n.t(`Extension for {0} is not installed or enabled for this workspace.`, managerId));
        return;
    }

    const ext = getExtension(extId);
    if (ext) {
        // Extension is installed but the manager never registered — don't prompt to install.
        // Attempt activation as a recovery step since the extension host is reliable at this point.
        if (!ext.isActive) {
            traceWarn(
                `Extension ${extId} is installed but manager "${managerId}" never registered. Attempting activation...`,
            );
            try {
                await ext.activate();
                traceInfo(`Extension ${extId} activated post-timeout for manager "${managerId}".`);
            } catch (err) {
                traceError(`Failed to activate extension ${extId} post-timeout for: ${managerId}`, err);
            }
        } else {
            traceWarn(
                `Extension ${extId} is installed and active but manager "${managerId}" never registered. ` +
                    `The extension may have failed during manager registration.`,
            );
        }
        return;
    }

    if (prompted.has(extId)) {
        return;
    }
    prompted.add(extId);

    traceError(`Extension for manager ${managerId} is not installed. Looked up extId="${extId}" via getExtension().`);
    const result = await showErrorMessage(
        l10n.t(`Do you want to install extension {0} to enable {1} support?`, extId, managerId),
        WorkbenchStrings.installExtension,
    );
    if (result === WorkbenchStrings.installExtension) {
        traceInfo(`Installing extension: ${extId}`);
        try {
            await installExtension(extId);
            traceInfo(`Extension ${extId} installed.`);
        } catch (err) {
            traceError(`Failed to install extension: ${extId}`, err);
        }

        try {
            const installedExt = getExtension(extId);
            if (installedExt && !installedExt.isActive) {
                traceInfo(`Extension for manager ${managerId} is not active: Activating...`);
                await installedExt.activate();
            }
        } catch (err) {
            traceError(`Failed to activate extension ${extId}, required for: ${managerId}`, err);
        }
    }
}

class ManagerReadyImpl implements ManagerReady {
    private readonly envManagers: Map<string, Deferred<void>> = new Map();
    private readonly pkgManagers: Map<string, Deferred<void>> = new Map();
    private readonly checked: Set<string> = new Set();
    private readonly disposables: Disposable[] = [];

    constructor(
        em: EnvironmentManagers,
        private readonly pm: PythonProjectManager,
    ) {
        this.disposables.push(
            em.onDidChangeEnvironmentManager((e) => {
                if (this.envManagers.has(e.manager.id)) {
                    this.envManagers.get(e.manager.id)?.resolve();
                } else {
                    const deferred = createDeferred<void>();
                    this.envManagers.set(e.manager.id, deferred);
                    deferred.resolve();
                }
            }),
            em.onDidChangePackageManager((e) => {
                if (this.pkgManagers.has(e.manager.id)) {
                    this.pkgManagers.get(e.manager.id)?.resolve();
                } else {
                    const deferred = createDeferred<void>();
                    this.pkgManagers.set(e.manager.id, deferred);
                    deferred.resolve();
                }
            }),
        );
    }

    /**
     * Best-effort activation nudge for the extension that provides the given manager.
     * Uses setImmediate so the extension host has a chance to finish initializing before
     * we query it. Deduplicated per manager ID to avoid redundant activation calls.
     */
    private checkExtension(managerId: string): void {
        if (this.checked.has(managerId)) {
            return;
        }
        this.checked.add(managerId);
        const extId = getExtensionId(managerId);
        if (extId) {
            setImmediate(async () => {
                const ext = getExtension(extId);
                if (ext && !ext.isActive) {
                    traceInfo(`Extension for manager ${managerId} is not active: Activating...`);
                    try {
                        await ext.activate();
                        traceInfo(`Extension for manager ${managerId} is now active.`);
                    } catch (err) {
                        traceError(`Failed to activate extension ${extId}, required for: ${managerId}`, err);
                    }
                }
            });
        }
    }

    public dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.envManagers.clear();
        this.pkgManagers.clear();
    }

    private _waitForEnvManager(managerId: string): Promise<void> {
        if (this.envManagers.has(managerId)) {
            return this.envManagers.get(managerId)!.promise;
        }
        const deferred = createDeferred<void>();
        this.envManagers.set(managerId, deferred);
        return withManagerTimeout(deferred, managerId, 'environment');
    }

    public async waitForEnvManager(uris?: Uri[]): Promise<void> {
        const ids: Set<string> = new Set();
        if (uris) {
            uris.forEach((uri) => {
                const m = getDefaultEnvManagerSetting(this.pm, uri);
                if (!ids.has(m)) {
                    ids.add(m);
                }
            });
        } else {
            const m = getDefaultEnvManagerSetting(this.pm, undefined);
            if (m) {
                ids.add(m);
            }
        }

        await this.waitForEnvManagerId(Array.from(ids));
    }

    public async waitForEnvManagerId(managerIds: string[]): Promise<void> {
        managerIds.forEach((managerId) => this.checkExtension(managerId));
        await Promise.all(managerIds.map((managerId) => this._waitForEnvManager(managerId)));
    }

    public async waitForAllEnvManagers(): Promise<void> {
        const ids: Set<string> = new Set();
        this.pm.getProjects().forEach((project) => {
            const m = getDefaultEnvManagerSetting(this.pm, project.uri);
            if (m && !ids.has(m)) {
                ids.add(m);
            }
        });

        const m = getDefaultEnvManagerSetting(this.pm, undefined);
        if (m) {
            ids.add(m);
        }
        await this.waitForEnvManagerId(Array.from(ids));
    }

    private _waitForPkgManager(managerId: string): Promise<void> {
        if (this.pkgManagers.has(managerId)) {
            return this.pkgManagers.get(managerId)!.promise;
        }
        const deferred = createDeferred<void>();
        this.pkgManagers.set(managerId, deferred);
        return withManagerTimeout(deferred, managerId, 'package');
    }

    public async waitForPkgManager(uris?: Uri[]): Promise<void> {
        const ids: Set<string> = new Set();

        if (uris) {
            uris.forEach((uri) => {
                const m = getDefaultPkgManagerSetting(this.pm, uri);
                if (!ids.has(m)) {
                    ids.add(m);
                }
            });
        } else {
            const m = getDefaultPkgManagerSetting(this.pm, undefined);
            if (m) {
                ids.add(m);
            }
        }

        await this.waitForPkgManagerId(Array.from(ids));
    }
    public async waitForPkgManagerId(managerIds: string[]): Promise<void> {
        managerIds.forEach((managerId) => this.checkExtension(managerId));
        await Promise.all(managerIds.map((managerId) => this._waitForPkgManager(managerId)));
    }
}

let _deferred = createDeferred<ManagerReady>();
export function createManagerReady(em: EnvironmentManagers, pm: PythonProjectManager, disposables: Disposable[]) {
    if (!_deferred.completed) {
        const mr = new ManagerReadyImpl(em, pm);
        disposables.push(mr);
        _deferred.resolve(mr);
    }
}

/**
 * Reset the module-level singleton so `createManagerReady` can be called again.
 * Only for use in tests.
 */
export function _resetManagerReadyForTesting(): void {
    _deferred = createDeferred<ManagerReady>();
    prompted.clear();
}

export async function waitForEnvManager(uris?: Uri[]): Promise<void> {
    const mr = await _deferred.promise;
    return mr.waitForEnvManager(uris);
}

export async function waitForEnvManagerId(managerIds: string[]): Promise<void> {
    const mr = await _deferred.promise;
    return mr.waitForEnvManagerId(managerIds);
}

export async function waitForAllEnvManagers(): Promise<void> {
    const mr = await _deferred.promise;
    return mr.waitForAllEnvManagers();
}

export async function waitForPkgManager(uris?: Uri[]): Promise<void> {
    const mr = await _deferred.promise;
    return mr.waitForPkgManager(uris);
}

export async function waitForPkgManagerId(managerIds: string[]): Promise<void> {
    const mr = await _deferred.promise;
    return mr.waitForPkgManagerId(managerIds);
}
