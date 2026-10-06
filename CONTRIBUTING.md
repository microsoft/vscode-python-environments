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

## Internal Python agent-tool bridge

The extension's existing **flat** export also provides `__pythonTools.version === 1`.
This is an internal convention, not a security boundary or a supported public API.
Its types live only in `src/internal/pythonToolsApi.ts`; do not copy them into
`src/types.ts`, `src/api.ts`, or the published API package. Consumers must check the
version and all three methods at runtime before using the private API. The Python
consumer uses its previous public Environments integration when that capability
is absent or incompatible; that compatibility route can still prompt. It never
falls back after a private operation starts, including errors, partial results,
timeouts, or cancellation. Environments-disabled users retain the legacy Python
route.
Explicit compatibility selection persists through the public Environments setter, not
just the Python extension's cached interpreter path, so later package operations
use the same environment. Reusing an already-selected environment is read-only;
it does not reselect or wait for an interpreter-change event.

| Method | Request | Result |
| --- | --- | --- |
| `configureEnvironment(request, token)` | `{ resourcePath?: string, pythonPath?: string }` | Select an explicit interpreter exactly; otherwise reuse an isolated environment or create one for the project. Success includes `created`. |
| `getEnvironment(request, token)` | `{ resourcePath?: string, includePackages?: boolean }` | Resolve the real selected environment, not the public API's short-timeout cache. `includePackages: true` returns `{ name, version?: string }[]`, including `[]`, or an error. |
| `installPackages(request, token)` | `{ resourcePath?: string, packages: string[] }` | Install into an isolated environment. Does not create or change selection implicitly, or modify any global/base interpreter. |

Automatic configuration uses isolation by default, regardless of whether a global
interpreter was selected automatically or by a person. Virtual environments are
recognized by `pyvenv.cfg`; non-base Conda and inline-script environments are also
isolated. Existing isolated environments outside the workspace remain reusable.
When no isolated environment is selected, configuration can resolve Poetry/Pipenv
caches through the native finder's project association. It does not infer ownership
from the cache location or record selection history; ambiguous project matches
require an explicit `pythonPath`. Read-only queries do not select these candidates.
There is no selection-origin bookkeeping or persistence. Old origin records are
ignored; ordinary current-interpreter selection and its persistence are unchanged.
An explicit `pythonPath` selects that interpreter without creating an environment.
This can select global Python for execution or queries, but does not authorize
package installation into it: `ENVIRONMENT_NOT_ISOLATED` directs the caller to
configure without `pythonPath` or select an existing isolated environment.

All methods require a VS Code `CancellationToken` and a trusted workspace.
`resourcePath` accepts an absolute path or a `file:` URI within an open workspace.
The Python tools default an omitted or empty path to the first workspace folder and
pass it explicitly. They disclose the target in preparation/results and instruct agents
to reuse the returned `resourcePath`. Editor focus does not change this default.
At the direct private API boundary, omission selects the only workspace root;
zero/multiple roots still produce actionable errors. The consumer default does not
relax that backend validation.
Other explicit input is never replaced by that default. Because the route is
workspace scoped, read-only tools keep their previous Environments behaviour when
no folder is open. Configuration and installation with a compatible private API
report `NO_WORKSPACE` instead of opening a picker or modifying global Python.
Nested projects and per-script selections retain their scope; a file is
never used as an environment creation directory. There is no User/global settings
fallback. An explicit `pythonPath` can switch away from an unavailable manager.
New nested targets persist as exact project entries without changing root defaults;
their automatic dependency discovery is restricted to that target directory.
Tool selections at the workspace root persist an explicit workspace manager, even
when it matches the extension default. This prevents `python.defaultInterpreterPath`
from restoring global Python on reload without rewriting that interpreter setting.
Ordinary human selections retain their existing settings-write behavior.

Results are `{ status: 'success', environment, resourcePath?, created?, packages? }`
or `{ status: 'error', code, message, environment?, resourcePath? }`. Errors retain
an already-created environment when subsequent package installation or selection
fails; retries reuse a resolvable `.venv`/`.conda` rather than creating a suffixed
directory. Selecting an existing environment does not reinstall project
dependencies. A resolvable `.venv`/`.conda` is only reused when it actually contains
the resolved isolated environment. A new subdirectory can reuse an isolated parent-project
selection; `resourcePath` chooses the target, not a requirement to create a fresh
environment.
Register an independent project when it needs a separate selection.
Reads and writes for the same effective target share a cancellable
queue; waiting behind an operation does not use the discovery timeout. Different
targets remain independent. Discovery timeouts report `NOT_READY`; a configured
environment manager that never registers reports `UNSUPPORTED_MANAGER` naming the id;
subprocess
timeouts report `TIMEOUT`. Cancellation throws `CancellationError` after owned
process cleanup. Cancellation is cooperative, not a rollback: completed writes or
package changes are not undone. A completed action remains successful if a
cancellation request arrives on its return. If cleanup fails,
`PROCESS_TERMINATION_FAILED` takes precedence:
the process may still be modifying files, so consumers must not blindly retry.
Cleanup waits for process closure and owned POSIX group completion; an exited
Windows parent cannot turn a failed tree termination into successful cancellation.
If a Windows parent has already exited when cancellation starts, descendant
cleanup cannot be confirmed; the tool reports that uncertainty instead of
signalling a potentially reused PID.
Only internal `toolExecution` calls enable these subprocess policies. Public
progress tokens do not enable agent timeouts, input suppression, or process-tree
cleanup semantics. Public package calls retain their existing execution defaults.

Internal symbol capabilities opt built-in managers into prompt-free operations;
they are unrelated to the human UI's `quickCreateConfig`. Creation supports venv,
Conda, and enabled PEP 723 inline scripts (the latter retain their existing cache
ownership/metadata rules). System and Pyenv base interpreters route creation to
venv; Conda base routes to an isolated Conda prefix. Poetry and Pipenv environments
can be reused, but unsupported creation and contributed managers without this
capability fail explicitly. Private package operations use the existing headless pip/uv, Conda, and
Poetry helpers with the real token and strict, uncached package listing. Venv
dependency validation fails rather than asking to continue. No tool installs a
base Python automatically. Conda response descriptors clone `execInfo.activatedRun`
to a standalone `conda run --prefix ... --no-capture-output ...` command; shared
public descriptors are not changed.
Venv creation uses the selected Python 3 as its base, falling back to the latest
discovered Python 3 only when none is selected. Conda creation requests the selected
Python major/minor version. This does not add a project version-constraint resolver
for `pyproject.toml` or `.python-version`. To choose a particular base, select it
first and then configure without `pythonPath`; the path parameter itself is an
exact selection request, not a venv base-interpreter argument.
Bare Conda commands configured through `python.condaPath` are resolved through
PATH for private execution and returned command prefixes.
Conda base is isolated even when inherited through `CONDA_PREFIX`, and failed
Conda discovery does not authorize replacement creation. Public Conda refresh remains best-effort while
the private readiness check retains the discovery error. Poetry verifies the
requested project's actual environment prefix before package operations. Agent
inventory uses `poetry run pip list --format=json`, including when Poetry supplies
pip itself; the public lockfile-based `poetry show` path is unchanged.
Private Poetry installs also apply the lockfile with `install --no-root`, since
`add` alone skips already-declared dependencies missing from the environment.
Direct installs into shared PEP 723
caches return `IMMUTABLE_ENVIRONMENT`; edit script metadata and configure again.
With the inline-script feature enabled, configuring a Python file with PEP 723
metadata can create its cache on the first tool invocation, without first using a
CodeLens or registering a script project manually. Invalid metadata fails rather
than falling back to ordinary project creation. This opt-in configuration route
does not change human or read-only routing, which still requires a validated
association. Target the project directory or supply `pythonPath` for ordinary
project/exact-interpreter configuration instead.
An agent joining a human-owned inline cache build gets `ENVIRONMENT_BUSY` without
waiting for or cancelling the human operation.

Private discovery is separate from public initialization and its onboarding.
Agent reads never start or await installation or missing-manager questions, even
when a concurrent public initialization is waiting for input. Ordinary startup,
public API, and human workflows retain their prompts; independently triggered
startup UI can still appear while a tool runs. There is no global "suppress UI"
switch. Exact nested-project persistence is also opt-in to the private setter;
ordinary manager-setting updates retain their existing defaults.

Keep tests for both internal and human routes when changing these helpers. The
focused suites are in `src/test/internal`, with shared creation/package and
inline-script regressions under `src/test/managers`.

## Questions or Issues?

- **Questions**: Start a [discussion](https://github.com/microsoft/vscode-python/discussions/categories/q-a)
- **Bugs**: File an [issue](https://github.com/microsoft/vscode-python-environments/issues)
- **Feature Requests**: Start a [discussion](https://github.com/microsoft/vscode-python/discussions/categories/ideas)

## Additional Resources

- [Development Process](https://github.com/Microsoft/vscode-python/blob/main/CONTRIBUTING.md#development-process)
- [Release Process](./docs/releasing.md)
- [API Documentation](./src/api.ts)
- [Project Documentation](./docs/projects-api-reference.md)

Thank you for contributing! 🎉
