
# Startup Flow for Python Environments Extension


user opens VS Code
python environments extension begins activation

**SYNC (`activate` in extension.ts):**
1. create StatusBar, ProjectManager, EnvVarManager, EnvironmentManagers, ManagerReady
2. create TerminalActivation, shell providers, TerminalManager
3. create ProjectCreators
4. `setPythonApi()` — API object created, deferred resolved (API is now available to consumers)
5. create views (EnvManagerView, ProjectView)
6. register all commands
7. activate() returns — extension is "active" from VS Code's perspective

   📊 TELEMETRY: EXTENSION.ACTIVATION_DURATION { duration }

**ASYNC (setImmediate callback, still in extension.ts):**
1. spawn PET process (`createNativePythonFinder`)
   1. sets up a JSON-RPC connection to it over stdin/stdout
2. register all built-in managers + shell env init in parallel (Promise.all):
   - `shellStartupVarsMgr.initialize()`
   - for each manager (system, conda, pyenv, pipenv, poetry):
     1. check if tool exists (e.g. `getConda(nativeFinder)` asks PET for the conda binary)
     2. if tool not found → log, return early (manager not registered)
     3. if tool found → create manager, call `api.registerEnvironmentManager(manager)`
        - this adds it to the `EnvironmentManagers` map
        - fires `onDidChangeEnvironmentManager` → `ManagerReady` deferred resolves for this manager
3. all registrations complete (Promise.all resolves)

**--- gate point: `applyInitialEnvironmentSelection` ---**

   📊 TELEMETRY: ENV_SELECTION.STARTED { duration (activation→here), registeredManagerCount, registeredManagerIds, workspaceFolderCount }

1. for each workspace folder + global scope (no workspace case), run `resolvePriorityChainCore` to find manager:
   - P1: pythonProjects[] setting → specific manager for this project
   - P2: user-configured defaultEnvManager setting
   - P3: user-configured python.defaultInterpreterPath → nativeFinder.resolve(path)
   - P4: auto-discovery → try venv manager, fall back to system python
     - for workspace scope: call `venvManager.get(scope)`
       - if venv found (local .venv/venv) → use venv manager with that env
       - if no local venv → venv manager may still return its `globalEnv` (system Python)
       - if venvManager.get returns undefined → fall back to system python manager
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
       → falls through to `await result.manager.get(scope)`

       **--- inner fork: fast path vs slow path (tryFastPathGet in fastPath.ts) ---**
       three conditions checked:
         a. `_initialized` deferred is undefined (never created) OR has not yet completed
         b. scope is a `Uri` (not global/undefined)
         c. a persisted env path exists in workspace state for this scope (folder Uri)

       FAST PATH (run if above three conditions are true):
         1. read persisted path 
         2. `resolve(persistedPath)` 
            1. failure → see SLOW PATH
            2. successful → return env immediately AND
         3. if `_initialized` deferred doesn't exist yet:
            - create one, kick off `startBackgroundInit()` as fire-and-forget

       SLOW PATH — fast path conditions not met, or fast path failed:
         4. `initialize()` — lazy, once-only per manager (guarded by deferred)
            a. `nativeFinder.refresh(hardRefresh=false)`:
               → internally calls `handleSoftRefresh()` → computes cache key from options
                 - on reload: cache is empty (Map was destroyed) → cache miss
                 - falls through to `handleHardRefresh()`
               → `handleHardRefresh()` adds request to WorkerPool queue (concurrency 1):
                   1. run `configure()` to setup PET search paths
                   2. run `refresh` — PET scans filesystem
                      - PET may use its own on-disk cache
                   3. returns NativeInfo[] (all envs of all types)
                      - result stored in in-memory cache so subsequent managers get instant cache hit
            b. filter results to this manager's env type (e.g. conda filters to kind=conda)
            c. convert NativeEnvInfo → PythonEnvironment objects → populate collection
            d. `loadEnvMap()` — reads persisted env path from workspace state
               → matches path against PET discovery results
               → populates `fsPathToEnv` map
         5. look up scope in `fsPathToEnv` → return the matched env

   📊 TELEMETRY: ENV_SELECTION.RESULT (per scope) { duration (priority chain + manager.get), scope, prioritySource, managerId, path, hasPersistedSelection }

3. env is cached in memory (no settings.json write)
4. Python extension / status bar can now get the selected env via `api.getEnvironment(scope)`

   📊 TELEMETRY: EXTENSION.MANAGER_REGISTRATION_DURATION { duration (activation→here), result, failureStage?, errorType? }

**POST-INIT:**
1. register terminal package watcher
2. register settings change listener (`registerInterpreterSettingsChangeListener`) — re-runs priority chain if settings change
3.  initialize terminal manager
4.  send telemetry (manager selection, project structure, discovery summary)