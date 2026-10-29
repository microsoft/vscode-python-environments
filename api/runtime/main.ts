// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import semver from 'semver';
import { extensions, l10n } from 'vscode';
import { EXTENSION_ID, PythonEnvironments as ExtensionEnvironments } from './api.js';
import { minimumExtensionVersion } from './packageMetadata.js';
import type { PythonEnvironmentApi } from './types.js';

export * from './api.js';

export namespace PythonEnvironments {
    /**
     * Returns the installed extension's API after verifying this package's minimum extension version.
     * Rejects before activation when the installed version is invalid or too old.
     */
    export async function api(): Promise<PythonEnvironmentApi> {
        const extension = extensions.getExtension<PythonEnvironmentApi | undefined>(EXTENSION_ID);
        if (extension !== undefined) {
            const version: unknown = extension.packageJSON?.version;
            if (typeof version !== 'string' || semver.valid(version) === null) {
                throw new Error(
                    l10n.t(
                        'Cannot verify the Python Environments extension version. Update or reinstall the extension and reload VS Code.',
                    ),
                );
            }
            if (!semver.gte(version, minimumExtensionVersion)) {
                throw new Error(
                    l10n.t(
                        'Python Environments extension version {0} is installed, but this API package requires version {1} or newer. Update the extension and reload VS Code.',
                        version,
                        minimumExtensionVersion,
                    ),
                );
            }
        }
        return ExtensionEnvironments.api();
    }
}
