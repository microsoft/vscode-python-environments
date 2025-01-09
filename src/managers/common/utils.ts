import * as os from 'os';
import { Package, PythonEnvironment } from '../../api';
import { showQuickPick } from '../../common/window.apis';
import { PackageManagement } from '../../common/localize';

export function isWindows(): boolean {
    return process.platform === 'win32';
}

export function untildify(path: string): string {
    return path.replace(/^~($|\/|\\)/, `${os.homedir()}$1`);
}

export function getUserHomeDir(): string {
    return os.homedir();
}

export function noop() {
    // do nothing
}

export function shortVersion(version: string): string {
    const pattern = /(\d)\.(\d+)(?:\.(\d+)?)?/gm;
    const match = pattern.exec(version);
    if (match) {
        if (match[3]) {
            return `${match[1]}.${match[2]}.${match[3]}`;
        }
        return `${match[1]}.${match[2]}.x`;
    }
    return version;
}
export function isGreater(a: string | undefined, b: string | undefined): boolean {
    if (!a && !b) {
        return false;
    }
    if (!a) {
        return false;
    }
    if (!b) {
        return true;
    }

    try {
        const aParts = a.split('.');
        const bParts = b.split('.');
        for (let i = 0; i < aParts.length; i++) {
            if (i >= bParts.length) {
                return true;
            }
            const aPart = parseInt(aParts[i], 10);
            const bPart = parseInt(bParts[i], 10);
            if (aPart > bPart) {
                return true;
            }
            if (aPart < bPart) {
                return false;
            }
        }
    } catch {
        return false;
    }
    return false;
}

export function sortEnvironments(collection: PythonEnvironment[]): PythonEnvironment[] {
    return collection.sort((a, b) => {
        if (a.version !== b.version) {
            return isGreater(a.version, b.version) ? -1 : 1;
        }
        const value = a.name.localeCompare(b.name);
        if (value !== 0) {
            return value;
        }
        return a.environmentPath.fsPath.localeCompare(b.environmentPath.fsPath);
    });
}

export function getLatest(collection: PythonEnvironment[]): PythonEnvironment | undefined {
    if (collection.length === 0) {
        return undefined;
    }
    let latest = collection[0];
    for (const env of collection) {
        if (isGreater(env.version, latest.version)) {
            latest = env;
        }
    }
    return latest;
}

export async function getPackagesToUninstall(packages: Package[]): Promise<Package[] | undefined> {
    const items = packages.map((p) => ({
        label: p.name,
        description: p.version,
        p,
    }));
    const selected = await showQuickPick(items, {
        placeHolder: PackageManagement.selectPackagesToUninstall,
        ignoreFocusOut: true,
        canPickMany: true,
    });
    return Array.isArray(selected) ? selected?.map((s) => s.p) : undefined;
}
