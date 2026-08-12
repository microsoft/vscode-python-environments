# Changelog

All notable changes to the `@vscode/python-environments` API package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0]

### Added

- Added `getPackageManager` to retrieve the registered package manager for an environment.
- Added `PackageManagementInteractionOptions` with an optional `runHeadless?: boolean` property, mixed into `PackageManagementOptions`. When `true`, package management operations run without any user prompts or interaction — steps that would normally require input, such as selecting packages to install when none are specified, are skipped instead of prompting — for automated or headless scenarios such as integration tests.
- Added `RemoveEnvironmentOptions` with an optional `runHeadless?: boolean` property to remove environments without a confirmation prompt in automated or headless scenarios.
