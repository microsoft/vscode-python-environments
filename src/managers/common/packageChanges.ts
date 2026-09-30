// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Package, PackageChangeKind, PackageManager, PythonEnvironment } from '../../api';
import { normalizePackageName } from './packageUtils';

/**
 * Callback invoked with the computed changes when at least one change is detected.
 */
export type PackageChangesCallback = (changes: { kind: PackageChangeKind; pkg: Package }[]) => void;

type PackageFetcher = () => Promise<Package[] | undefined>;

/**
 * Computes the list of package changes between a before and after snapshot.
 * @param before - The previous list of packages.
 * @param after - The new list of packages.
 * @returns An array of changes indicating which packages were added or removed.
 */
export function getPackageChanges(before: Package[], after: Package[]): { kind: PackageChangeKind; pkg: Package }[] {
    const beforeSet = new Set(before.map(({ name, version }) => `${normalizePackageName(name)}==${version}`));
    const afterSet = new Set(after.map(({ name, version }) => `${normalizePackageName(name)}==${version}`));
    const changes: { kind: PackageChangeKind; pkg: Package }[] = [];

    for (const pkg of after) {
        if (!beforeSet.has(`${normalizePackageName(pkg.name)}==${pkg.version}`)) {
            changes.push({ kind: PackageChangeKind.add, pkg });
        }
    }
    for (const pkg of before) {
        if (!afterSet.has(`${normalizePackageName(pkg.name)}==${pkg.version}`)) {
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
 *
 * @param packageManager The package manager whose packages changed.
 * @param environment The environment whose packages should be refreshed.
 * @param before The package snapshot from before the operation.
 * @param onChanges Callback invoked when package changes are detected.
 * @param fetchPackages Optional internal fetcher for operation-specific refresh behavior.
 */
export async function updatePackagesAndNotify(
    packageManager: PackageManager,
    environment: PythonEnvironment,
    before: Package[] | undefined,
    onChanges: PackageChangesCallback,
    fetchPackages?: PackageFetcher,
): Promise<Package[] | undefined> {
    const [after, afterDirectDependenciesNames] = await Promise.all([
        fetchPackages?.() ?? packageManager.getPackages(environment, { skipCache: true }),
        // Handle transitive dependencies (best-effort, don't break package refresh on failure)
        packageManager.getDirectPackageNames?.(environment).catch(() => undefined),
    ]);

    if (after === undefined) {
        return undefined;
    }

    // Enrich packages with transitive dependency info (best-effort, creates new objects to respect readonly)
    const enriched = afterDirectDependenciesNames && afterDirectDependenciesNames.size > 0
        ? after.map((pkg) => ({
              ...pkg,
              isTransitive: !afterDirectDependenciesNames.has(normalizePackageName(pkg.name)),
          }))
        : after;

    // Fire change event
    const changes = getPackageChanges(before ?? [], enriched);
    if (changes.length > 0) {
        onChanges(changes);
    }

    return enriched;
}
