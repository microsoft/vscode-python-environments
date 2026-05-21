// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Package, PackageChangeKind, PackageManager, PythonEnvironment } from '../../api';

export async function getPackageChanges(
    packageManager: PackageManager,
    environment: PythonEnvironment,
    after: Package[],
): Promise<{ kind: PackageChangeKind; pkg: Package }[]> {
    const before = (await packageManager.getPackages(environment)) ?? [];
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

export async function updatePackagesAndNotify(
    packageManager: PackageManager,
    environment: PythonEnvironment,
): Promise<void> {
    packageManager.setPackages(environment, [], []);
    const after = await packageManager.fetchPackages(environment);
    const changes = await getPackageChanges(packageManager, environment, after);
    if (changes.length > 0) {
        packageManager.setPackages(environment, after, changes);
    }
}
