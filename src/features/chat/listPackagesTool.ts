// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { CancellationToken } from 'vscode';
import { raceCancellationError } from './utils';
import { PythonEnvironment, PythonEnvironmentApi } from '../../api';

export async function getPythonPackagesResponse(
    environment: PythonEnvironment,
    api: PythonEnvironmentApi,
    token: CancellationToken,
): Promise<string> {
    await raceCancellationError(api.refreshPackages(environment), token);
    const installedPackages = await raceCancellationError(api.getPackages(environment), token);
    if (!installedPackages || installedPackages.length === 0) {
        return 'No packages found';
    }
    // Installed Python packages, each in the format <name> or <name> (<version>). The version may be omitted if unknown. Returns an empty array if no packages are installed.
    const response = [
        'Below is a list of the Python packages, each in the format <name> or <name> (<version>). The version may be omitted if unknown: ',
    ];
    installedPackages.forEach((pkg) => {
        const info = pkg.version ? `${pkg.name} (${pkg.version})` : pkg.name;
        response.push(`- ${info}`);
    });

    return response.join('\n');
}
