// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import {
    Capabilities,
    EnvironmentCapability,
    EnvironmentManagerCapability,
    PackageCapability,
    PackageManagerCapability,
    supportedCapability,
} from '../capabilities';

export const allSupportedEnvironmentCapabilities: Capabilities<EnvironmentManagerCapability> = {
    [EnvironmentCapability.List]: supportedCapability,
    [EnvironmentCapability.Resolve]: supportedCapability,
    [EnvironmentCapability.GetSelected]: supportedCapability,
    [EnvironmentCapability.SetSelected]: supportedCapability,
    [EnvironmentCapability.Create]: supportedCapability,
    [EnvironmentCapability.CreateNamed]: supportedCapability,
    [EnvironmentCapability.Remove]: supportedCapability,
};

export const allSupportedPackageCapabilities: Capabilities<PackageManagerCapability> = {
    [PackageCapability.List]: supportedCapability,
    [PackageCapability.Install]: supportedCapability,
    [PackageCapability.Uninstall]: supportedCapability,
    [PackageCapability.Upgrade]: supportedCapability,
    [PackageCapability.ListDirect]: supportedCapability,
    [PackageCapability.FetchAvailableVersions]: supportedCapability,
};
