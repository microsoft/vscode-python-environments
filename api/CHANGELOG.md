# Changelog

All notable changes to the `@vscode/python-environments` API package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0]

### Added

- Added `PackageVersionLookupNotSupportedError`, thrown when a package manager cannot list a package's available versions (an unsupported capability, as distinct from an operational failure). The error exposes a stable `code` (`'PackageVersionLookupNotSupported'`) discriminator.
- Added the `isPackageVersionLookupNotSupportedError(error): error is PackageVersionLookupNotSupportedError` type guard. It recognizes the error via its stable `code`, so it works even when the error crosses an extension bundle boundary and `instanceof` would fail.
- Added an optional `errorMode` to `PythonPackageGetterApi.getPackageAvailableVersions`. The default `legacy` mode preserves the existing `undefined` result for unsupported lookups and operational failures. The opt-in `throw` mode rejects with `PackageVersionLookupNotSupportedError` for unsupported capabilities and propagates operational failures unchanged.

### Changed

- Documented that `PackageManager.getPackageAvailableVersions` implementations should throw `PackageVersionLookupNotSupportedError` when version lookup is unsupported and let operational failures propagate. Resolving to `undefined` continues to be treated by callers as an unsupported capability.

## [1.2.0]

### Added

- Added `PackageManagementInteractionOptions` with an optional `runHeadless?: boolean` property, mixed into `PackageManagementOptions`. When `true`, package management operations run without any user prompts or interaction — steps that would normally require input, such as selecting packages to install when none are specified, are skipped instead of prompting — for automated or headless scenarios such as integration tests.
- Added `RemoveEnvironmentOptions` with an optional `runHeadless?: boolean` property to remove environments without a confirmation prompt in automated or headless scenarios.

## [1.1.0]

### Added

- Re-exported the `Pep440Version` type from `@renovatebot/pep440` for use with the new package version APIs.
- Added the optional `PackageInfo.isTransitive?: boolean` property to indicate whether a package is a transitive dependency.
- Added `GetPackagesOptions` with an optional `skipCache?: boolean` property. When `true`, package managers bypass cached data and query the underlying package management tool.
- Added optional `PackageManager.getPackageWatchTargets?(environment: PythonEnvironment): RelativePattern[]` to return manager-specific filesystem patterns to monitor for package installation and removal changes, in addition to the default site-packages metadata locations.
- Added optional `PackageManager.getDirectPackageNames?(environment: PythonEnvironment): Promise<Set<string> | undefined>` to return a best-effort set of direct, non-transitive package names when supported by the package manager.
- Added optional `PackageManager.getVersion?(environment: PythonEnvironment): Promise<Pep440Version | undefined>` to return the version of the underlying package management tool, such as pip, uv, or conda.
- Added optional `PackageManager.getPackageAvailableVersions?(environment: PythonEnvironment, packageName: string): Promise<Pep440Version[] | undefined>` to return the available versions of a package in newest-first order when supported.
- Added optional `PackageManager.formatInstallSpec?(packageName: string, version: string): string` to format a versioned install specification using manager-specific syntax, such as `name==version` for pip or `name=version` for conda.
- Added `PythonPackageGetterApi.getPackageAvailableVersions(environment: PythonEnvironment, packageName: string): Promise<Pep440Version[] | undefined>` so API consumers can query a package's available versions in newest-first order. Resolves to `undefined` when the environment's package manager does not support version listing.

### Changed

- Added the optional `options?: GetPackagesOptions` parameter to `PackageManager.getPackages(environment, options?)` and `PythonPackageGetterApi.getPackages(environment, options?)`. Consumers can set `options.skipCache` to request fresh package data.
