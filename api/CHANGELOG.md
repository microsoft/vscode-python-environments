# Changelog

All notable changes to the `@vscode/python-environments` API package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
