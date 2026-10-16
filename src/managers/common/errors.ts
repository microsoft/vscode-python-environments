// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { l10n } from 'vscode';

/**
 * Raised when a project-aware package manager (such as Poetry) is asked to run an operation
 * without a bound Python project. Package operations that depend on the working directory must
 * fail clearly rather than run from an arbitrary location.
 */
export class PackageManagerRequiresProjectError extends Error {
    constructor() {
        super(l10n.t('Package operations require a Python project.'));
        this.name = 'PackageManagerRequiresProjectError';
    }
}
