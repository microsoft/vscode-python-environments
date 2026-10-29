# @vscode/python-environments

This package provides type declarations and a helper to access the API exposed by the [Python Environments](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-python-envs) extension for VS Code.

## Usage

1. Install the package and add an `extensionDependencies` entry in your extension's `package.json`:

```jsonc
// package.json
{
    "extensionDependencies": ["ms-python.vscode-python-envs"]
}
```

2. Install the npm package:

```
npm install @vscode/python-environments
```

3. Import and use the API in your extension:

```typescript
import { PythonEnvironments } from '@vscode/python-environments';

export async function activate() {
    const api = await PythonEnvironments.api();

    // Get all discovered environments
    const envs = await api.getEnvironments('all');
    for (const env of envs) {
        console.log(env.displayName, env.version);
    }
}
```

## Extension compatibility

The npm package and extension are versioned independently. Each npm release declares
an exact `minimumExtensionVersion` in its `package.json`. `PythonEnvironments.api()`
checks the installed extension version against that floor before activating it or
returning its API, including when the extension is already active. An older extension
is rejected with an error explaining which version is required; update the extension
and reload VS Code. Missing or invalid version metadata is also rejected.

Versions use SemVer ordering, not string comparison. For example, a `1.40.0` floor
accepts `1.40.0`, `1.40.1`, and `1.41.0` (including odd-minor preview-channel builds),
but rejects `1.40.0-rc.1`. A newer prerelease such as `1.41.0-rc.1` meets that floor.
Build metadata does not affect ordering.

The minimum is fixed for an already-published npm release. New npm releases use the
latest stable extension as their baseline, which can raise the minimum even when
their API changes would otherwise work on an older extension. Pin an older npm
package if your extension must retain support for an older runtime.

Acquire the API through this helper: type-only imports and direct access to the
extension's exports bypass the check. The floor does not replace feature detection
for optional manager methods or guarantee compatibility with future breaking releases.
Compatibility errors use `vscode.l10n.t()`; the npm package does not configure the
consuming extension's localization bundles, so untranslated messages fall back to English.

## Manager capabilities

Capabilities report general manager support without invoking an operation:

```typescript
import { PackageCapability, PythonEnvironments } from '@vscode/python-environments';

const api = await PythonEnvironments.api();
const environment = await api.getEnvironment(undefined);
if (environment) {
    const support = await api.getPackageManagerCapability(environment, PackageCapability.ListDirect);
    if (support.supported) {
        // Best-effort direct/transitive package classification is available.
    }
}
```

Manager advertisements are optional for legacy compatibility. Missing maps use
method-presence inference and return `isLegacy: true`; missing keys in a supplied
map report unsupported. Support is advisory, not a guarantee that an operation succeeds.

See the [capability guide](https://github.com/microsoft/vscode-python-environments/blob/main/docs/README.md#manager-capabilities)
for the full catalog and provider authoring.

## Full API reference

📘 **[Python Environments API reference](https://github.com/microsoft/vscode-python-environments/blob/main/docs/README.md)**

The complete manual documents every method and data type, organized by domain -
environments, packages, projects, execution, environment variables, and
extensibility - with field tables, parameter tables, return types, and examples.

- [Environments](https://github.com/microsoft/vscode-python-environments/blob/main/docs/README.md#environments) - discover, resolve, select, create, and remove interpreters
- [Packages](https://github.com/microsoft/vscode-python-environments/blob/main/docs/README.md#packages) - list, install, uninstall, and look up versions
- [Projects](https://github.com/microsoft/vscode-python-environments/blob/main/docs/README.md#projects) - the folders the extension tracks
- [Execution](https://github.com/microsoft/vscode-python-environments/blob/main/docs/README.md#execution) - run Python in terminals, tasks, and background processes
- [Environment variables](https://github.com/microsoft/vscode-python-environments/blob/main/docs/README.md#environment-variables) - resolved variables for a scope
- [Extensibility](https://github.com/microsoft/vscode-python-environments/blob/main/docs/README.md#extensibility) - register your own environment manager, package manager, or project creator

See [`CHANGELOG.md`](https://github.com/microsoft/vscode-python-environments/blob/main/api/CHANGELOG.md) for API changes between versions.
