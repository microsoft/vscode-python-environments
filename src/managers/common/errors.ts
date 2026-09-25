// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { l10n } from 'vscode';
import { PackageManagerRequiresProjectError as PublicPackageManagerRequiresProjectError } from '../../publicErrors';

export class PackageManagerRequiresProjectError extends PublicPackageManagerRequiresProjectError {
    constructor() {
        super(l10n.t('Package operations require a Python project.'));
    }
}
