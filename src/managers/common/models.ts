// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { MarkdownString, Uri } from 'vscode';
import type {
    EnvironmentGroupInfo,
    IconPath,
    Package,
    PackageId,
    PackageInfo,
    PythonEnvironment,
    PythonEnvironmentExecutionInfo,
    PythonEnvironmentId,
    PythonEnvironmentInfo,
} from '../../types';

/*
 * Concrete, minimal implementations of the {@link PythonEnvironment} and {@link Package} public
 * contracts (see `../../types`). These are used by the extension when constructing environment
 * and package items on behalf of registered managers.
 */

export class PythonEnvironmentImpl implements PythonEnvironment {
    public readonly name: string;
    public readonly displayName: string;
    public readonly shortDisplayName?: string;
    public readonly displayPath: string;
    public readonly version: string;
    public readonly environmentPath: Uri;
    public readonly description?: string;
    public readonly tooltip?: string | MarkdownString;
    public readonly iconPath?: IconPath;
    public readonly execInfo: PythonEnvironmentExecutionInfo;
    public readonly sysPrefix: string;
    public readonly group?: string | EnvironmentGroupInfo;
    public readonly error?: string;

    constructor(
        public readonly envId: PythonEnvironmentId,
        info: PythonEnvironmentInfo,
    ) {
        this.name = info.name;
        this.displayName = info.displayName ?? this.name;
        this.shortDisplayName = info.shortDisplayName;
        this.displayPath = info.displayPath;
        this.version = info.version;
        this.environmentPath = info.environmentPath;
        this.description = info.description;
        this.tooltip = info.tooltip;
        this.iconPath = info.iconPath;
        this.execInfo = info.execInfo;
        this.sysPrefix = info.sysPrefix;
        this.group = info.group;
        this.error = info.error;
    }
}

export class PythonPackageImpl implements Package {
    public readonly name: string;
    public readonly displayName: string;
    public readonly version?: string;
    public readonly description?: string;
    public readonly tooltip?: string | MarkdownString;
    public readonly iconPath?: IconPath;
    public readonly uris?: readonly Uri[];

    public readonly isTransitive?: boolean;

    constructor(
        public readonly pkgId: PackageId,
        info: PackageInfo,
    ) {
        this.name = info.name;
        this.displayName = info.displayName ?? this.name;
        this.version = info.version;
        this.description = info.description;
        this.tooltip = info.tooltip;
        this.iconPath = info.iconPath;
        this.uris = info.uris;
        this.isTransitive = info.isTransitive;
    }
}
