// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { CancellationToken, Uri, workspace } from 'vscode';
import { PackageManagementOptions, PythonEnvironmentApi } from '../../api';
import { raceCancellationError } from './utils';

export class InstallPackageTool {
    constructor(private readonly api: PythonEnvironmentApi) {}

    async installPackages(resource: Uri | undefined, packages: string[], token: CancellationToken): Promise<void> {
        if (!workspace.isTrusted) {
            throw new Error('Workspace must be trusted to install packages');
        }
        if (!packages || packages.length === 0) {
            throw new Error('Invalid input: packageList is required and cannot be empty');
        }

        const environment = await this.api.getEnvironment(resource);
        if (!environment) {
            // Check if the file is a notebook or a notebook cell to throw specific error messages.
            if (resource && (resource.fsPath.endsWith('.ipynb') || resource.fsPath.includes('.ipynb#'))) {
                throw new Error('Unable to access Jupyter kernels for notebook cells');
            }
            throw new Error('No environment found');
        }

        // Install the packages
        const pkgManagementOptions: PackageManagementOptions = { install: packages };
        await raceCancellationError(this.api.managePackages(environment, pkgManagementOptions), token);
    }
}
