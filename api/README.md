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

## Manager capabilities

Capabilities report general manager support without invoking an operation:

```typescript
const api = await PythonEnvironments.api();
const environment = await api.getEnvironment(undefined);
if (environment && typeof api.getPackageManagerCapability === 'function') {
    const support = await api.getPackageManagerCapability(environment, 'packages.direct');
    if (support.supported) {
        // Best-effort direct/transitive package classification is available.
    }
}
```

Managers advertise every capability key explicitly: there are no defaults, and
`capabilities` is a required property on both `EnvironmentManager` and
`PackageManager`. A key a manager omits at runtime resolves
`{ supported: false, reason: 'Capability not implemented' }`.

To change a manager's advertised support, update the check for that key in its
map; return `{ supported: false, reason }` to disable support. Checks must be
read-only and noninteractive.

Capability keys come from the `EnvironmentManagerCapability` and
`PackageManagerCapability` type unions. Adding a public key requires updating
every built-in manager's `capabilities` map, plus tests and documentation.
Removing a key from the type union is a breaking API change.

Feature-detect query methods when supporting older extension runtimes. Queries
use currently registered managers and describe support, not request validity or
guaranteed success.

See the [capability guide](https://github.com/microsoft/vscode-python-environments/blob/main/docs/README.md#manager-capabilities)
for the full catalog and provider maintenance.

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
