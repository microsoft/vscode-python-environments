import { PythonEnvironment } from '../../api';
import { isWindows } from '../../common/utils/platformUtils';
import { Installable } from './types';

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

export function pathForGitBash(binPath: string): string {
    return isWindows() ? binPath.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, '/$1') : binPath;
}

/**
 * Compares two semantic version strings. Support sonly simple 1.1.1 style versions.
 * @param version1 First version
 * @param version2 Second version
 * @returns -1 if version1 < version2, 0 if equal, 1 if version1 > version2
 */
export function compareVersions(version1: string, version2: string): number {
    const v1Parts = version1.split('.').map(Number);
    const v2Parts = version2.split('.').map(Number);

    for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
        const v1Part = v1Parts[i] || 0;
        const v2Part = v2Parts[i] || 0;

        if (v1Part > v2Part) {
            return 1;
        }
        if (v1Part < v2Part) {
            return -1;
        }
    }

    return 0;
}
