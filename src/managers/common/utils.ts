import * as os from 'os';
import { PythonEnvironment } from '../../api';
import { Uri } from 'vscode';

export interface Installable {
    /**
     * The name of the package, requirements, lock files, or step name.
     */
    readonly name: string;

    /**
     * The name of the package, requirements, pyproject.toml or any other project file, etc.
     */
    readonly displayName: string;

    /**
     * Arguments passed to the package manager to install the package.
     *
     * @example
     *  ['debugpy==1.8.7'] for `pip install debugpy==1.8.7`.
     *  ['--pre', 'debugpy'] for `pip install --pre debugpy`.
     *  ['-r', 'requirements.txt'] for `pip install -r requirements.txt`.
     */
    readonly args?: string[];

    /**
     * Installable group name, this will be used to group installable items in the UI.
     *
     * @example
     *  `Requirements` for any requirements file.
     *  `Packages` for any package.
     */
    readonly group?: string;

    /**
     * Description about the installable item. This can also be path to the requirements,
     * version of the package, or any other project file path.
     */
    readonly description?: string;

    /**
     * External Uri to the package on pypi or docs.
     * @example
     *  https://pypi.org/project/debugpy/ for `debugpy`.
     */
    readonly uri?: Uri;
}

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

export function mergePackages(common: Installable[], installed: string[]): Installable[] {
    const notInCommon = installed.filter((pkg) => !common.some((c) => c.name === pkg));
    return common
        .concat(notInCommon.map((pkg) => ({ name: pkg, displayName: pkg })))
        .sort((a, b) => a.name.localeCompare(b.name));
}
