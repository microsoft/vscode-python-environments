# Pipenv Environment Manager — Implementation Plan

Summary
- This doc lists the tasks required to get pipenv integrated as an EnvironmentManager 

Files & methods to implement
1. Registration/activation (src/managers/pipenv/main.ts)
   - Implement `registerPipenvFeatures(nativeFinder: NativePythonFinder, disposables: Disposable[])`.
   - Use the same registration pattern as `pyenv` and `poetry` (get Python API, detect pipenv, instantiate manager, `api.registerEnvironmentManager(mgr)`, push disposables).

2. Utilities (src/managers/pipenv/pipenvUtils.ts)
   - `getPipenv(native?: NativePythonFinder)` — locate the `pipenv` binary (persisted override, env vars, which, or `nativeFinder` fallback).
   - `refreshPipenv(hardRefresh, nativeFinder, api, manager)` — discover pipenv environments (workspace Pipfiles, native finder info, or scanning `WORKON_HOME`).
   - `resolvePipenvPath(fsPath, nativeFinder, api, manager)` — resolve a path or Uri to a PythonEnvironment.
   - `nativeToPythonEnv(nativeInfo, api, manager, pipenvPath)` — convert native discovery info into a `PythonEnvironment`:
     - set `execInfo.run.executable` (use `pipenv --py` when possible) and `execInfo.shellActivation` (see activation strategy below), `sysPrefix`, display metadata.

3. Manager implementation (src/managers/pipenv/pipenvManager.ts)
   - Implement class like `PoetryManager`/`PyEnvManager`:
     - fields: `collection: PythonEnvironment[]`, `fsPathToEnv: Map<string, PythonEnvironment>`, `globalEnv`.
     - event emitters: `_onDidChangeEnvironments`, `_onDidChangeEnvironment` and public events.
     - constructor(nativeFinder, api) and metadata properties (`name`, `displayName`, `preferredPackageManagerId`, `tooltip`).
     - lifecycle methods: `initialize()`, `getEnvironments()`, `refresh()`, `get()`, `set()`, `resolve()`, `clearCache()`.
     - helpers: `loadEnvMap()`, `fromEnvMap(uri)`, `findEnvironmentByPath(fsPath)`.
   - Use `api.createPythonEnvironmentItem()` to create `PythonEnvironment` items.

4. Exec info & activation behavior
   - Resolve a Python executable using `pipenv --py` when possible and set `execInfo.run.executable`.
   - Activation options:
     - Provide `shellActivation` mapping with `'unknown'` fallback. For example `{ executable: 'pipenv', args: ['shell'] }` for activation.
     - Provide `activatedRun` or `run` that uses resolved python (`/path/to/venv/bin/python`) or fallback to `pipenv run python` (e.g., run.executable = 'pipenv', args = ['run', 'python']).
     - Set `shellDeactivation` to `exit`/`deactivate` where appropriate.

5. Workspace mapping & persistence
   - Implement per-workspace persistent selection (get/set persisted environment for workspace & global), similar to `pyenv` and `poetry` utils.
   - Implement logic in `loadEnvMap()` to pick project-specific envs (Pipfile location), global fallback, and mapping to projects via `api.getPythonProjects()`.

6. Package-manager (required)
   - Implement a dedicated Pipenv `PackageManager` and register it via `api.registerPackageManager(...)`.
   - Use package manager id: `ms-python.python:pipenv`.
   - Implement install/uninstall by invoking `pipenv install`/`pipenv uninstall` and firing package-change events.

7. Tests
   - Add unit tests (mocking `NativePythonFinder` and `getPythonApi`) for detection, discovery, `resolve()` and mapping.
   - Add integration tests that run `pipenv --py`/`pipenv --venv` behavior using a test fixture if desired.

8. Localization & assets
   - Add localized strings (e.g., `PipenvStrings`) for messages and progress titles.
   - Add icon(s) if required and reference via `iconPath`.

9. Documentation
   - Update README/docs to include Pipenv support and configuration/setting notes.

10. CI & linting
   - Run tests and fix TypeScript compile/lint issues (unused args, correct imports). Ensure `main.ts` registration uses `api.registerEnvironmentManager` like other managers.

Minimal viable implementation (priority)
1. Fix `main.ts` to implement `registerPipenvFeatures(...)` and register the manager (so the manager is known to the extension).
2. Implement `getPipenv()` (detect pipenv binary) and `nativeToPythonEnv()` (at minimum obtain python path using `pipenv --py` and return a valid `PythonEnvironment` via `api.createPythonEnvironmentItem`).
3. Implement manager skeleton (constructor, event emitters, `initialize()`, `getEnvironments()` and `resolve()` that uses utils above) and wire registration.
4. Add a simple integration test and run the extension in dev to validate detection.

Questions / decisions (resolved)
- preferredPackageManagerId: create a distinct `pipenv` package manager id: `ms-python.python:pipenv`.

- Activation approach: use `pipenv shell` for terminal activation (interactive terminals) and `pipenv run` as the fallback for non-interactive runs / `activatedRun`.

- Scope of discovery: discover both global pipenv virtualenvs and workspace-local pipenv environments (projects with Pipfile).

- Create/quickCreate: implement `create()` using `pipenv install` to create environments and install requested packages as part of quick-create.

- Windows/PowerShell specifics: keep `shellActivation` mapping with `'unknown'` fallback for now; revisit if issues surface.

- Tests: (deferred).