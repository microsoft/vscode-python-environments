// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Package, PackageChangeKind, PackageManager, PythonEnvironment } from '../../api';

/**
 * Computes the list of package changes between a before and after snapshot.
 * @param before - The previous list of packages.
 * @param after - The new list of packages.
 * @returns An array of changes indicating which packages were added or removed.
 */
export function getPackageChanges(before: Package[], after: Package[]): { kind: PackageChangeKind; pkg: Package }[] {
    const beforeSet = new Set(before.map(({ name, version }) => `${name}==${version}`));
    const afterSet = new Set(after.map(({ name, version }) => `${name}==${version}`));
    const changes: { kind: PackageChangeKind; pkg: Package }[] = [];

    for (const pkg of after) {
        if (!beforeSet.has(`${pkg.name}==${pkg.version}`)) {
            changes.push({ kind: PackageChangeKind.add, pkg });
        }
    }
    for (const pkg of before) {
        if (!afterSet.has(`${pkg.name}==${pkg.version}`)) {
            changes.push({ kind: PackageChangeKind.remove, pkg });
        }
    }

    return changes;
}

/**
 * Fetches the latest packages, computes changes against the current cache,
 * and updates the cache. Fires a change event only when there are actual changes.
 *
 * This function does not call {@link PackageManager.getPackages} to avoid
 * re-entering {@link PackageManager.refresh} on a cold cache. Instead, the
 * caller should pass the previously cached packages (or an empty array for
 * the first load).
 */
export async function updatePackagesAndNotify(
    packageManager: PackageManager,
    environment: PythonEnvironment,
    before?: Package[],
): Promise<void> {
    const after = (await packageManager.getPackages(environment, { skipCache: true })) ?? [];
    const changes = getPackageChanges(before ?? [], after);
    packageManager.setPackages(environment, after, changes);
}
