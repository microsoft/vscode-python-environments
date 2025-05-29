// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Extension, extensions, Uri } from 'vscode';
import { PYTHON_EXTENSION_ID } from '../../common/constants';
import { CancellationToken } from 'vscode-jsonrpc';
import { Package, PythonEnvironmentApi } from '../../api';
import { ListInstalledPackagesTool } from './listPackagesTool';
import { InstallPackageTool } from './installPackagesTool';

let regsitered = false;
export function registerPrivateApi(api: PythonEnvironmentApi) {
    const listInstalledPackages = new ListInstalledPackagesTool(api);
    const installPackages = new InstallPackageTool(api);
    findAndRegisterExtension(listInstalledPackages, installPackages);
    const dispsoble = extensions.onDidChange(() => {
        if (regsitered) {
            dispsoble.dispose();
            return;
        }
        findAndRegisterExtension(listInstalledPackages, installPackages);
    });
    return dispsoble;
}

function findAndRegisterExtension(
    listInstalledPackages: ListInstalledPackagesTool,
    installPackages: InstallPackageTool,
) {
    const pythonExtension = extensions.getExtension<PrivatePythonApi>(PYTHON_EXTENSION_ID);
    if (pythonExtension) {
        registerApi(pythonExtension, listInstalledPackages, installPackages);
    }
}

type PrivatePythonApi = {
    pythonEnvironment: {
        registerApi: (api: {
            listPackages: (resource: Uri | undefined, token: CancellationToken) => Promise<Package[] | undefined>;
            installPackages: (resource: Uri | undefined, packages: string[], token: CancellationToken) => Promise<void>;
        }) => void;
    };
};
async function registerApi(
    pythonExtension: Extension<PrivatePythonApi>,
    listInstalledPackages: ListInstalledPackagesTool,
    installPackages: InstallPackageTool,
) {
    if (regsitered) {
        return;
    }
    try {
        await pythonExtension.activate();
    } catch (error) {
        console.error('Failed to activate Python extension:', error);
    }

    try {
        pythonExtension.exports.pythonEnvironment.registerApi({
            listPackages: async (resource, token) => {
                return listInstalledPackages.listPackages(resource, token);
            },
            installPackages: async (resource, packages, token) => {
                return installPackages.installPackages(resource, packages, token);
            },
        });
        regsitered = true;
    } catch (error) {
        console.error('Failed to register Python API:', error);
    }
}
