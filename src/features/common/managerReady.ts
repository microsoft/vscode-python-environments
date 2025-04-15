import { Disposable, Uri } from 'vscode';
import { EnvironmentManagers, PythonProjectManager } from '../../internal.api';
import { createDeferred, Deferred } from '../../common/utils/deferred';
import { allExtensions } from '../../common/extension.apis';
import { traceError } from '../../common/logging';
import { showErrorMessage } from '../../common/window.apis';
import { getDefaultEnvManagerSetting, getDefaultPkgManagerSetting } from '../settings/settingHelpers';

interface ManagerReady extends Disposable {
    waitForEnvManager(uris?: Uri[]): Promise<void>;
    waitForPkgManager(uris?: Uri[]): Promise<void>;
}

class ManagerReadyImpl implements ManagerReady {
    private readonly envManagers: Map<string, Deferred<void>> = new Map();
    private readonly pkgManagers: Map<string, Deferred<void>> = new Map();
    private readonly checked: Set<string> = new Set();
    private readonly disposables: Disposable[] = [];

    constructor(em: EnvironmentManagers, private readonly pm: PythonProjectManager) {
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

    private checkExtension(managerId: string) {
        const installed = allExtensions().some((ext) => managerId.startsWith(`${ext.id}:`));
        if (!installed && !this.checked.has(managerId)) {
            this.checked.add(managerId);
            traceError(`Extension for manager ${managerId} is not installed.`);
            showErrorMessage(`Extension for manager ${managerId} is not installed.`);
        }
        return installed;
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
        return deferred.promise;
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

        ids.forEach((managerId) => this.checkExtension(managerId));
        await Promise.all(Array.from(ids).map((managerId) => this._waitForEnvManager(managerId)));
    }

    private _waitForPkgManager(managerId: string): Promise<void> {
        if (this.pkgManagers.has(managerId)) {
            return this.pkgManagers.get(managerId)!.promise;
        }
        const deferred = createDeferred<void>();
        this.pkgManagers.set(managerId, deferred);
        return deferred.promise;
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

        ids.forEach((managerId) => this.checkExtension(managerId));
        await Promise.all(
            Array.from(ids).map((managerId) => {
                return this._waitForPkgManager(managerId);
            }),
        );
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

export async function waitForEnvManager(uris?: Uri[]): Promise<void> {
    const mr = await _deferred.promise;
    return mr.waitForEnvManager(uris);
}

export async function waitForPkgManager(uris?: Uri[]): Promise<void> {
    const mr = await _deferred.promise;
    return mr.waitForPkgManager(uris);
}
