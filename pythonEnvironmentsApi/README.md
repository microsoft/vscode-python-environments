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

## API

The full API surface is exported from the package. Key interfaces include:

- **`PythonEnvironmentApi`** – the top-level composite interface returned by `PythonEnvironments.api()`.
- **`PythonEnvironment`** – represents a single Python environment.
- **`EnvironmentManager`** – register and manage environment managers.
- **`PackageManager`** – register and manage package managers.
- **`PythonProject`** – represents a Python project.

See the [API reference](https://github.com/microsoft/vscode-python-environments/blob/main/docs/projects-api-reference.md) for complete documentation.

## License

MIT
