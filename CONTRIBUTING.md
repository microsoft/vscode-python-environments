# Contributing to Python Environments Extension

Thank you for your interest in contributing to the Python Environments extension! This guide will help you get started.

## Prerequisites

- Node.js (LTS version recommended)
- npm
- VS Code Insiders (recommended for development)
- Git
- Python

## Getting Started

1. **Clone the repository**
   ```bash
   cd vscode-python-environments
   ```

2. **Create a Python virtual environment**

   A Python virtual environment is important for development because it isolates the Python dependencies used for testing and development from your system Python installation. This ensures reproducible builds and prevents conflicts with other projects.

   **Using the Python Environments extension (recommended):**

   1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
   2. Run **Python: Create Environment**
   3. Select **Venv** as the environment type
   4. Choose your preferred Python interpreter
   5. The extension will create the `.venv` folder and configure your workspace automatically

   **Alternatively, from the command line:**

   ```bash
   # Create the virtual environment
   python -m venv .venv

   # Activate it (Linux/macOS)
   source .venv/bin/activate

   # Activate it (Windows - Command Prompt)
   .venv\Scripts\activate.bat

   # Activate it (Windows - PowerShell)
   .venv\Scripts\Activate.ps1
   ```

   > **Note:** Keep the virtual environment activated while developing. The extension uses this environment for running Python-related tests and for environment discovery during development.


3. **Install dependencies**
   ```bash
   npm install
   ```

4. **Build and watch**
   ```bash
   npm run watch
   ```

5. **Run tests**
   ```bash
   npm run unittest
   ```

## Development Workflow

### Running the Extension

1. Open the project in VS Code
2. Press `F5` to launch the Extension Development Host
3. The extension will be loaded in the new VS Code window

### Making Changes

- **Localization**: Use VS Code's `l10n` API for all user-facing messages
- **Logging**: Use `traceLog` or `traceVerbose` instead of `console.log`
- **Error Handling**: Track error state to avoid duplicate notifications
- **Documentation**: Add clear docstrings to public functions

### Testing
Run unit tests with the different configurations in the "Run and Debug" panel

## Contributor License Agreement (CLA)

This project requires contributors to sign a Contributor License Agreement (CLA). When you submit a pull request, a CLA bot will automatically check if you need to provide a CLA and guide you through the process. You only need to do this once across all Microsoft repositories.

## Code of Conduct

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information, see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with questions.

## Public API package (`@vscode/python-environments`)

The npm package under [`api/`](./api) is the public API facade other extensions consume. Its sources — `api/src/main.ts`, `api/src/types.ts`, and `api/src/publicErrors.ts` — are **copies** of [`src/api.ts`](./src/api.ts), [`src/types.ts`](./src/types.ts), and [`src/publicErrors.ts`](./src/publicErrors.ts) respectively — the single sources of truth — and are **not committed** (see [`api/.gitignore`](./api/.gitignore)).

- Edit the public API only in `src/api.ts` (the runtime facade: `PythonEnvironments.api()` helper and `EXTENSION_ID`), `src/types.ts` (public contracts: interfaces, types, enums), and `src/publicErrors.ts` (concrete public error classes and type guards). `api/src/*.ts` files are build artifacts — never edit or commit them.
- `api/src/main.ts`, `api/src/types.ts`, and `api/src/publicErrors.ts` are produced by the publish pipeline ([`build/azure-pipeline.npm.yml`](./build/azure-pipeline.npm.yml)), which copies `src/api.ts` to `api/src/main.ts`, `src/types.ts` to `api/src/types.ts`, and `src/publicErrors.ts` to `api/src/publicErrors.ts` before compiling. The api package is therefore built in CI only; to build it locally, copy the files first (e.g. `cp src/api.ts api/src/main.ts && cp src/types.ts api/src/types.ts && cp src/publicErrors.ts api/src/publicErrors.ts`).
- `src/api.ts`, `src/types.ts`, and `src/publicErrors.ts` are validated on every PR by the extension's own lint and TypeScript compile.
- **Versioning and compatibility:** the published package version in [`api/package.json`](./api/package.json) is maintained independently of the extension version in [`package.json`](./package.json) — the two do not need to match. Compatibility is based on the API shape exported by the installed Python Environments extension at runtime. Package updates must preserve backwards-compatible contracts unless the API package version intentionally communicates a breaking change; consumers should treat newly added members as optional when they may run against older installed extension versions. Any PR that edits `src/api.ts`, `src/types.ts`, or `src/publicErrors.ts` must bump `api/package.json` (use the `skip api version` label to bypass) and add an entry to [`api/CHANGELOG.md`](./api/CHANGELOG.md) (use the `skip api changelog` label to bypass).

## Questions or Issues?

- **Questions**: Start a [discussion](https://github.com/microsoft/vscode-python/discussions/categories/q-a)
- **Bugs**: File an [issue](https://github.com/microsoft/vscode-python-environments/issues)
- **Feature Requests**: Start a [discussion](https://github.com/microsoft/vscode-python/discussions/categories/ideas)

## Additional Resources

- [Development Process](https://github.com/Microsoft/vscode-python/blob/main/CONTRIBUTING.md#development-process)
- [API Documentation](./src/api.ts)
- [Project Documentation](./docs/projects-api-reference.md)

Thank you for contributing! 🎉
