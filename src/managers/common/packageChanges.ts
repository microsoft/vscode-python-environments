// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Package, PackageChangeKind, PackageManager, PythonEnvironment } from '../../api';

export async function getPackageChanges(
    packageManager: PackageManager,
    environment: PythonEnvironment,
    after: Package[],
): Promise<{ kind: PackageChangeKind; pkg: Package }[]> {
    const before = (await packageManager.getPackages(environment)) ?? [];
    const changes: { kind: PackageChangeKind; pkg: Package }[] = [];
    before.forEach((pkg) => {
        changes.push({ kind: PackageChangeKind.remove, pkg });
    });
    after.forEach((pkg) => {
        changes.push({ kind: PackageChangeKind.add, pkg });
    });
    return changes;
}

export async function updatePackagesAndNotify(
    packageManager: PackageManager,
    environment: PythonEnvironment,
    onChanged: (after: Package[], changes: { kind: PackageChangeKind; pkg: Package }[]) => void,
): Promise<void> {
    const after = await packageManager.fetchPackages(environment);
    const changes = await getPackageChanges(packageManager, environment, after);
    if (changes.length > 0) {
        onChanged(after, changes);
    }
}
