// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Capabilities, EnvironmentManagerCapability, PackageManagerCapability, supportedCapability, EnvironmentCapability, PackageCapability } from '../capabilities';

export const allSupportedEnvironmentCapabilities: Capabilities<EnvironmentManagerCapability> = {
    [EnvironmentCapability.List]: supportedCapability,
    [EnvironmentCapability.Resolve]: supportedCapability,
    [EnvironmentCapability.GetSelected]: supportedCapability,
    [EnvironmentCapability.SetSelected]: supportedCapability,
    [EnvironmentCapability.Create]: supportedCapability,
    [EnvironmentCapability.Remove]: supportedCapability,
};

export const allSupportedPackageCapabilities: Capabilities<PackageManagerCapability> = {
    [PackageCapability.List]: supportedCapability,
    [PackageCapability.Install]: supportedCapability,
    [PackageCapability.Uninstall]: supportedCapability,
    [PackageCapability.Upgrade]: supportedCapability,
    [PackageCapability.ListDirect]: supportedCapability,
    [PackageCapability.ListAvailableVersions]: supportedCapability,
};
