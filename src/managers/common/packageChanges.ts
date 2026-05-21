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
