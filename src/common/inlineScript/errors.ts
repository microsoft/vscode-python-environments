// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { l10n } from 'vscode';

export class InlineScriptEnvironmentModifiedError extends Error {
    constructor() {
        super(l10n.t(
            'This inline-script environment has modified packages. Set up the script environment again before selecting it.',
        ));
        this.name = 'InlineScriptEnvironmentModifiedError';
    }
}

/**
 * Raised when a package-management command targets an inline-script environment.
 *
 * These environments are built from a script's `# /// script` block and are shared by every
 * script with the same dependencies and base interpreter, so editing their packages by hand
 * would silently change other scripts. The tree view hides the actions; this covers the command
 * palette, which can still resolve one from the active script.
 */
export class InlineScriptPackagesNotManagedError extends Error {
    constructor() {
        super(l10n.t(
            'Packages of an inline-script environment are managed by its "# /// script" block. Edit the script\'s dependencies and set up its environment again.',
        ));
        this.name = 'InlineScriptPackagesNotManagedError';
    }
}
