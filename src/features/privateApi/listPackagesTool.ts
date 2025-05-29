// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { CancellationToken, Uri, workspace } from 'vscode';
import { Package, PythonEnvironmentApi } from '../../api';
import { raceCancellationError } from './utils';

export class ListInstalledPackagesTool {
    constructor(private readonly api: PythonEnvironmentApi) {}
    async listPackages(resource: Uri | undefined, token: CancellationToken): Promise<Package[] | undefined> {
        if (!workspace.isTrusted) {
            throw new Error('Workspace must be trusted to list installed packages');
        }
        const environment = await raceCancellationError(this.api.getEnvironment(resource), token);
        if (!environment) {
            throw new Error(`No environment found for the provided resource path ${resource?.fsPath}`);
        }

        await raceCancellationError(this.api.refreshPackages(environment), token);
        return raceCancellationError(this.api.getPackages(environment), token);
    }
}
