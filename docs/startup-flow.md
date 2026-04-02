
# Startup Flow for Python Environments Extension


user opens VS Code
python environments extension begins activation

SYNC (`activate` in extension.ts):
1. create core objects: ProjectManager, EnvironmentManagers, ManagerReady
2. `setPythonApi()` — API object created, deferred resolved (API is now available to consumers)
3. create views (EnvManagerView, ProjectView), status bar, terminal manager
4. register all commands
5. activate() returns — extension is "active" from VS Code's perspective

   📊 TELEMETRY: EXTENSION.ACTIVATION_DURATION { duration }

ASYNC (setImmediate callback, still in extension.ts):
1. spawn PET process (`createNativePythonFinder`)
   1. sets up a JSON-RPC connection to it over stdin/stdout
2. register all built-in managers in parallel (Promise.all):
   - system: create SysPythonManager + VenvManager + PipPackageManager, register immediately
     - ✅ NO PET call — managers are created and registered with no tool detection
     - sets up file watcher for venv activation scripts
   - conda: `getConda(nativeFinder)` checks settings → cache → persistent state → PATH
     - if found → register CondaEnvManager + CondaPackageManager
     - if not found → PET fallback as last resort (rarely hit, conda is usually on PATH)
     - if not found at all → skip, send MANAGER_REGISTRATION.SKIPPED telemetry
   - pyenv: create PyEnvManager, register immediately
     - ✅ NO PET call — always registers unconditionally (lazy discovery)
   - pipenv: create PipenvManager, register immediately
     - ✅ NO PET call — always registers unconditionally (lazy discovery)
   - poetry: create PoetryManager + PoetryPackageManager, register immediately
     - ✅ NO PET call — always registers unconditionally (lazy discovery)
   - shellStartupVars: initialize
   - all managers fire `onDidChangeEnvironmentManager` → ManagerReady resolves
3. all registrations complete (Promise.all resolves) — fast, typically milliseconds

--- gate point: `applyInitialEnvironmentSelection` ---
   📊 TELEMETRY: ENV_SELECTION.STARTED { duration (activation→here), registeredManagerCount, registeredManagerIds, workspaceFolderCount }

1. for each workspace folder + global scope (no workspace case), run `resolvePriorityChainCore` to find manager:
   - P1: pythonProjects[] setting → specific manager for this project
   - P2: user-configured defaultEnvManager setting
   - P3: user-configured python.defaultInterpreterPath → nativeFinder.resolve(path)
   - P4: auto-discovery → try venv manager (local .venv), fall back to system python
     - for workspace scope: ask venv manager if there's a local env (.venv/venv in the folder)
       - if found → use venv manager with that env
       - if not found → fall back to system python manager
     - for global scope: use system python manager directly

2. get the environment from the winning priority level:

   --- fork point: `result.environment ?? await result.manager.get(folder.uri)` ---
   left side truthy = envPreResolved | left side undefined = managerDiscovery

   envPreResolved — P3 won (interpreter → manager):
     `resolvePriorityChainCore` calls `tryResolveInterpreterPath()`:
       1. `nativeFinder.resolve(path)` — single PET call, resolves just this one binary
       2. find which manager owns the resolved env (by managerId)
       3. return { manager, environment } — BOTH are known
     → result.environment is set → the `??` short-circuits
     → no `manager.get()` called, no `initialize()`, no full discovery

   managerDiscovery — P1, P2, or P4 won (manager → interpreter):
     `resolvePriorityChainCore` returns { manager, environment: undefined }
       → result.environment is undefined → falls through to `await result.manager.get(scope)`
     `manager.get(scope)` (e.g. `CondaEnvManager.get()`, `PyEnvManager.get()`):
       4. `initialize()` — lazy, once-only per manager (guarded by deferred)
          a. `nativeFinder.refresh(hardRefresh=false)`:
             → `handleSoftRefresh()` checks in-memory cache (Map) for key 'all'
               - on reload: cache is empty (Map was destroyed) → cache miss
               - falls through to `handleHardRefresh()`
             → `handleHardRefresh()`:
               - adds request to WorkerPool queue (concurrency 1, so serialized)
               - when its turn comes, calls `doRefresh()`:
                 1. `configure()` — JSON-RPC to PET with search paths, conda/poetry/pipenv paths, cache dir
                 2. `refresh` — JSON-RPC to PET, PET scans filesystem
                    - PET has had time to warm up since spawn (registration was fast)
                    - PET may use its own on-disk cache (cacheDirectory) to speed this up
                    - PET streams back results as 'environment' and 'manager' notifications
                    - envs missing version/prefix get an inline resolve() call
                 3. returns NativeInfo[] (all envs of all types)
               - result stored in in-memory cache under key 'all'
             → subsequent managers calling nativeFinder.refresh(false) get cache hit → instant
          b. filter results to this manager's env type (e.g. conda filters to kind=conda, pyenv to kind=pyenv)
          c. for pipenv/poetry/pyenv: if tool CLI was not found via PATH during registration,
             extract tool executable from PET's manager info in the refresh results
          d. convert NativeEnvInfo → PythonEnvironment objects → populate collection
          e. `loadEnvMap()` — reads persisted env path from workspace state
             → matches path against freshly discovered collection via `findEnvironmentByPath()`
             → populates `fsPathToEnv` map
       5. look up scope in `fsPathToEnv` → return the matched env

   📊 TELEMETRY: ENV_SELECTION.RESULT (per scope) { duration (priority chain + manager.get), scope, prioritySource, managerId, path, hasPersistedSelection }

3. env is cached in memory (no settings.json write)
4. Python extension / status bar can now get the selected env via `api.getEnvironment(scope)`

   📊 TELEMETRY: EXTENSION.MANAGER_REGISTRATION_DURATION { duration (activation→here), result, failureStage?, errorType? }

SIDEBAR ACCESS (on-demand, if user opens Python environments panel):
- view iterates `providers.managers` → all registered managers appear (including pyenv/pipenv/poetry)
- user expands a manager node → `getChildren()` → `manager.getEnvironments('all')`
  → `initialize()` (lazy, once-only) → `nativeFinder.refresh(false)`:
    - if cache populated from earlier env selection → instant cache hit
    - if first access → warm PET call (no concurrent pressure, single caller)
  → environments appear under the manager node
  → if no environments found → "No environments" placeholder shown

POST-INIT:
1. register terminal package watcher
2. register settings change listener (`registerInterpreterSettingsChangeListener`) — re-runs priority chain if settings change
3.  initialize terminal manager
4.  send telemetry (manager selection, project structure, discovery summary)
