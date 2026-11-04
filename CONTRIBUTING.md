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

#### Linux CI failure diagnostics

Failed Linux smoke, E2E, and integration test launches upload a diagnostic artifact
named for the suite, OS, Python version, and run attempt. Artifacts are retained for
seven days and contain:

- `launcher.log`: test-launcher output, including the downloaded VS Code version
  and verbose VS Code startup output.
- `xvfb.log`: X server stderr, kept separately from test failures.
- `vscode/`: VS Code main, renderer, and extension-host logs, when startup reaches
  those processes.
- `test-runner-started.json`: written when the extension-host test runner reaches
  its global setup, before loading test suites; includes the VS Code version and
  extension-host arguments. If absent, the failure occurred before this marker
  could be written, not necessarily inside a test.

The shared [Linux test action](.github/actions/run-linux-tests/action.yml) enables
these diagnostics via `VSCODE_TEST_DIAGNOSTICS_DIR`. Local runs remain unchanged
unless that variable is set to an existing directory. Diagnostics do not add
retries or suppress test failures.

## Contributor License Agreement (CLA)

This project requires contributors to sign a Contributor License Agreement (CLA). When you submit a pull request, a CLA bot will automatically check if you need to provide a CLA and guide you through the process. You only need to do this once across all Microsoft repositories.

## Code of Conduct

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information, see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with questions.

## Public API package (`@vscode/python-environments`)

The npm package under [`api/`](./api) is the public API facade other extensions consume.
Its generated `api/src` sources are **not committed** (see [`api/.gitignore`](./api/.gitignore)).

- Edit shared public sources in `src/api.ts`, `src/types.ts`, `src/publicErrors.ts`,
  `src/capabilities.ts`, and `src/legacyCapabilities.ts`. They are copied under the
  same filenames into `api/src`. The npm-only entry point is maintained in
  `api/runtime/main.ts` and copied to `api/src/main.ts`.
- `npm --prefix api run compile` regenerates these copies and a private
  `packageMetadata.ts` module from `api/package.json`, then builds declarations,
  ESM, and CommonJS. Never edit generated sources or maintain a second version
  constant. Install dependencies with `npm --prefix api ci` first.
- Run `npm --prefix api test` after compilation. This tests the release validator
  and packs/installs the package for modern/legacy TypeScript and ESM/CommonJS
  runtime checks. `npm --prefix api run check:release` checks the live baseline;
  add `-- --provenance` to verify original and staged sources against that release.
- Shared API sources are also checked by the extension's lint and TypeScript
  compile. The PR's **API package compatibility** job builds/tests npm release
  inputs and validates their minimum against the latest stable release.
  Documentation-only and unrelated PRs do not perform the external lookup.
  Configure that job as a required check in branch protection.

### API versioning and publication

The npm version in [`api/package.json`](./api/package.json) is independent of the
extension version in [`package.json`](./package.json). Each new npm release must
declare `minimumExtensionVersion` as an exact stable SemVer matching GitHub's
designated latest stable extension release tag (without its leading `v`). Ranges,
prerelease floors, and build metadata are rejected. The helper checks installed
extension versions before activation using normal SemVer precedence, including
already-active extensions. Published npm releases keep their original minimum.

Defer npm version bumps to release PRs by applying `skip api version` to API
implementation PRs. Any PR editing a shared public API source or
`api/runtime/**/*.ts` must still update [`api/CHANGELOG.md`](./api/CHANGELOG.md)
and [`docs/README.md`](./docs/README.md). The existing `skip api changelog` and
`skip api docs` labels apply to those file checks. None of these labels bypass
compatibility or publication validation.

Release in this order: merge API changes without an npm version bump, ship the
stable extension, then merge an npm release PR updating
`minimumExtensionVersion`, the npm version, and the changelog. The stable npm
version bump starts the publication pipeline automatically. Development can merge
before the extension ships: source provenance is checked at packaging, not on PRs.
The npm pipeline resolves the stable release tag to an immutable commit and
requires all five shared source files, including their staged copies, to match.
Only line-ending differences are ignored; even comment-only differences block
publication. This conservative provenance check is not a semantic API analyzer.
The npm-only wrapper can evolve without changing those shared extension sources.

The packed manifest and both compiled runtime floors must agree. The publish
stage checks the actual tarball against the latest stable release again. If a
new stable release appeared during review or between packaging and publishing,
explicitly update the minimum, rebuild, retest, and rerun the pipeline; do not
restamp the existing artifact. Both `latest` and `next` npm tags currently use
this stable baseline: preview-only API publishing needs a separate policy.
Public GitHub lookups use bounded retries and fail closed. Local runs can set
`GITHUB_TOKEN` to avoid anonymous rate limits; PRs use their read-only token.

- **Releasing:** merging a stable version change in `api/package.json` into `main` automatically starts the [npm pipeline](./build/azure-pipeline.npm.yml), including its existing build, package tests, and MicroBuild approval process. Other manifest edits build and validate the package without publishing. The version check compares the merged commit with its parent, relying on the repository's squash-only merge policy; direct pushes to `main` also trigger it. Preview releases remain manual: queue the pipeline with `quality: preview` and `publishPackage: true`. Manual runs otherwise remain build-only unless `publishPackage` is explicitly enabled.

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
Human venv initialization retries discovery and base preparation after a failure,
including failures after discovery has completed. A partial initialization is not
reused as a successful cache on the next public lookup; private discovery still
does not wait for human onboarding.

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
