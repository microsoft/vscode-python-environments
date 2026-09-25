// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { l10n } from 'vscode';

/**
 * Raised when a package-management operation is invoked on a package manager that is not
 * bound to a Python project (for example, Poetry, which needs a project to determine the
 * working directory for its commands).
 *
 * Callers that resolve package managers without a specific project (e.g. the environment
 * manager view) should catch this error and surface a friendly message rather than letting
 * it propagate as an unhandled failure.
 */
export class PackageManagerRequiresProjectError extends Error {
    constructor() {
        super(l10n.t('Poetry package operations require a Python project.'));
        this.name = 'PackageManagerRequiresProjectError';
    }
}
