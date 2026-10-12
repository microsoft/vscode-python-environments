// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Shared, fully-supported capability maps for unit test fixtures. Every manager must advertise
 * every capability key; tests that aren't exercising capability behavior itself can spread these
 * constants into their fake managers instead of repeating the full key list.
 */

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
