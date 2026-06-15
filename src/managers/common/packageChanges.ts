// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Package, PackageChangeKind, PackageManager, PythonEnvironment } from '../../api';

/**
 * Callback invoked with the computed changes when at least one change is detected.
 */
export type PackageChangesCallback = (changes: { kind: PackageChangeKind; pkg: Package }[]) => void;

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
 * This function calls {@link PackageManager.getPackages} with `skipCache` to fetch
 * the latest snapshot. The caller should pass the previously cached packages
 * so changes can be computed against the pre-refresh state.
 */
export async function updatePackagesAndNotify(
    packageManager: PackageManager,
    environment: PythonEnvironment,
    before: Package[] | undefined,
    onChanges: PackageChangesCallback,
): Promise<Package[] | undefined> {
    const [after, afterDirectDependenciesNames] = await Promise.all([
        packageManager.getPackages(environment, { skipCache: true }).then((pkgs) => pkgs ?? []),
        // Handle transitive dependencies (best-effort, don't break package refresh on failure)
        packageManager.getDirectPackageNames?.(environment).catch(() => undefined),
    ]);

    if (afterDirectDependenciesNames && afterDirectDependenciesNames.size > 0) {
        for (const pkg of after) {
            (pkg as { isTransitive?: boolean }).isTransitive = !afterDirectDependenciesNames.has(pkg.name);
        }
    }

    // Fire change event
    const changes = getPackageChanges(before ?? [], after);
    if (changes.length > 0) {
        onChanges(changes);
    }

    return after;
}
