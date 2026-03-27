
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
   - for each manager (system, conda, pyenv, pipenv, poetry):
     1. check if tool exists (e.g. `getConda(nativeFinder)` asks PET for the conda binary)
     2. if tool not found → log, return early (manager not registered)
     3. if tool found → create manager, call `api.registerEnvironmentManager(manager)`
        - this adds it to the `EnvironmentManagers` map
        - fires `onDidChangeEnvironmentManager` → `ManagerReady` deferred resolves for this manager
3. all registrations complete (Promise.all resolves)

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

   P1
   `resolvePriorityChainCore` calls  `envManagers.getEnvironmentManager(projectManagerId);`
   1. manager is known 
   2. manager.get(scope)


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
     `manager.get(scope)` (e.g. `CondaEnvManager.get()`):
       4. `initialize()` — lazy, once-only per manager (guarded by deferred)
          a. `nativeFinder.refresh(hardRefresh=false)`:
             → `handleSoftRefresh()` checks in-memory cache (Map) for key 'all' (bc one big scan, shared cache, all managers benefit)
               - on reload: cache is empty (Map was destroyed) → cache miss
               - falls through to `handleHardRefresh()`
             → `handleHardRefresh()`:
               - adds request to WorkerPool queue (concurrency 1, so serialized)
               - when its turn comes, calls `doRefresh()`:
                 1. `configure()` — JSON-RPC to PET with search paths, conda/poetry/pipenv paths, cache dir
                 2. `refresh` — JSON-RPC to PET, PET scans filesystem
                    - PET may use its own on-disk cache (cacheDirectory) to speed this up
                    - PET streams back results as 'environment' and 'manager' notifications
                    - envs missing version/prefix get an inline resolve() call
                 3. returns NativeInfo[] (all envs of all types)
               - result stored in in-memory cache under key 'all'
             → subsequent managers calling nativeFinder.refresh(false) get cache hit → instant
          b. filter results to this manager's env type (e.g. conda filters to kind=conda)
          c. convert NativeEnvInfo → PythonEnvironment objects → populate collection
          d. `loadEnvMap()` — reads persisted env path from workspace state
             → matches path against freshly discovered collection via `findEnvironmentByPath()`
             → populates `fsPathToEnv` map
       5. look up scope in `fsPathToEnv` → return the matched env

   📊 TELEMETRY: ENV_SELECTION.RESULT (per scope) { duration (priority chain + manager.get), scope, prioritySource, managerId, path, hasPersistedSelection }

3. env is cached in memory (no settings.json write)
4. Python extension / status bar can now get the selected env via `api.getEnvironment(scope)`

   📊 TELEMETRY: EXTENSION.MANAGER_REGISTRATION_DURATION { duration (activation→here), result, failureStage?, errorType? }

POST-INIT:
1. register terminal package watcher
2. register settings change listener (`registerInterpreterSettingsChangeListener`) — re-runs priority chain if settings change
3.  initialize terminal manager
4.  send telemetry (manager selection, project structure, discovery summary)


## `manager.get(scope)` — proposed fast path

```
get(scope):
  1. if _initialized deferred exists → await it, look up fsPathToEnv map, return
     (current behavior — instant on 2nd+ call, waits on background init if in progress)

  2. first call (no _initialized deferred yet):
     a. create _initialized deferred (claims the slot so no other call re-enters step 2)

     b. read persisted env path from workspace state (cheap, ~microseconds)
        each manager reads its own key:
          venv   → getVenvForWorkspace(scope.fsPath)
          conda  → getCondaForWorkspace(scope.fsPath)
          system → getSystemEnvForWorkspace(scope.fsPath)
          pyenv  → getPyenvForWorkspace(scope.fsPath)
          pipenv → getPipenvForWorkspace(scope.fsPath)

     c. if persisted path exists:
        i.   nativeFinder.resolve(path) — single PET call, resolves just this binary
        ii.  build PythonEnvironment from resolve result (version, prefix, executable)
        iii. kick off full init in background (not awaited here):
               this.internalRefresh().then(
                   () => this._initialized.resolve(),
                   (err) => { traceError(err); this._initialized.resolve(); }
               );
             - errors logged, deferred always resolves so nothing hangs
             - subsequent callers (getEnvironments, picker, set) await _initialized
               and get the full collection once background init finishes
        iv.  return the resolved env immediately ← FAST PATH (~milliseconds)

     d. if no persisted path OR nativeFinder.resolve() fails:
        i.   await this.internalRefresh() — full PET discovery (current slow behavior)
        ii.  this._initialized.resolve()
        iii. look up fsPathToEnv map, return result

  race condition safety:
    - _initialized deferred is created at the top of step 2, before any async work
    - any concurrent call to get(), getEnvironments(), set(), refresh() sees the
      deferred exists → goes to step 1 → awaits the promise
    - the deferred always resolves (never rejects) so callers never hang
    - if background init fails, errors are logged but the fast-path env is already
      returned and cached — the user sees a working env, just the picker list may
      be incomplete until a manual refresh
```

**What waits on background init (and when):**
| Caller | Trigger | Impact |
|--------|---------|--------|
| `getEnvironments()` | User opens env picker | Picker shows spinner briefly, then populates |
| `set()` | User selects a different env | Picker already triggered init, so usually instant |
| `get()` (2nd call) | Re-query selected env | Awaits deferred — but caller already has the fast result cached |
| `refresh()` | User clicks refresh | Awaits init, then runs another refresh |

**What does NOT wait (gets the fast result immediately):**
- Status bar display
- Terminal activation
- Python extension querying `api.getEnvironment(scope)`

**Net effect:** On reload with a previously-selected env, `get()` returns in ~one
PET resolve call (~ms) instead of waiting for full discovery (~seconds). Full
discovery still completes in the background so the env list is populated for
the picker / `getEnvironments()`.

**Note:** If `get()` is called a second time before background init finishes,
the `_initialized` deferred exists → step 1 → awaits it. It does NOT re-attempt
the fast persisted-path route (correct, because the first call already returned
the fast result and the caller cached it via `setEnvironment`).

---

## Startup resolution flows

Each flow describes a concrete scenario: which priority wins, what the manager is,
whether persisted state exists, and what code path executes.

### Flow A — P1 wins, venv manager, persisted env exists (most common reload)

```
resolvePriorityChainCore(folderUri)
  → P1: pythonProjects[] has envManager = "ms-python.python:venv"
  → returns { manager: venvManager, environment: undefined, source: 'pythonProjects' }

applyInitialEnvironmentSelection:
  → result.environment is undefined
  → calls: await venvManager.get(folderUri)

venvManager.get(folderUri):                          ← FAST PATH
  → _initialized not completed? YES
  → scope is Uri? YES
  → getVenvForWorkspace(fsPath) → "/project/.venv"   (cheap workspace state read)
  → resolveVenvPythonEnvironmentPath(".venv")         (single PET resolve, ~ms)
  → resolved ✓
  → _initialized already in progress from earlier     → skip re-creating deferred
  → return resolved                                   ← DONE (~ms)
```
**Speed: ~milliseconds.** Status bar shows env immediately.

---

### Flow B — P4 auto-discovery wins, venv has local .venv, persisted env exists

```
resolvePriorityChainCore(folderUri)
  → P1: no pythonProjects[] match
  → P2: no defaultEnvManager set
  → P3: no defaultInterpreterPath set
  → P4: autoDiscoverEnvironment(folderUri)
    → calls: venvManager.get(folderUri)               ← FAST PATH

venvManager.get(folderUri):
  → _initialized? NO (first caller)
  → scope is Uri? YES
  → getVenvForWorkspace(fsPath) → "/project/.venv"
  → resolveVenvPythonEnvironmentPath → resolved ✓
  → creates _initialized deferred
  → kicks off internalRefresh() in background (.then)
  → return resolved                                   ← DONE (~ms)

autoDiscoverEnvironment:
  → localEnv is set
  → returns { manager: venvManager, environment: localEnv, source: 'autoDiscovery' }

applyInitialEnvironmentSelection:
  → result.environment IS set → ?? short-circuits
  → never calls manager.get() again
```
**Speed: ~milliseconds.** P4 path gets the same fast benefit.

---

### Flow C — P2 wins, venv manager, persisted env exists

```
resolvePriorityChainCore(folderUri)
  → P2: defaultEnvManager = "ms-python.python:venv"
  → returns { manager: venvManager, environment: undefined, source: 'defaultEnvManager' }

applyInitialEnvironmentSelection:
  → result.environment is undefined
  → calls: await venvManager.get(folderUri)           ← FAST PATH
  → same as Flow A from here
```
**Speed: ~milliseconds.**

---

### Flow D — P1/P2 wins, venv manager, NO persisted env (first time / new workspace)

```
venvManager.get(folderUri):
  → _initialized not completed? YES
  → scope is Uri? YES
  → getVenvForWorkspace(fsPath) → undefined           (no persisted state)
  → fast path skipped (no persistedPath)
  → falls through to: await this.initialize()         ← SLOW
    → internalRefresh() → full PET discovery
    → loadEnvMap() → populates fsPathToEnv
  → looks up fsPathToEnv map → returns env or globalEnv
```
**Speed: ~seconds.** Same as current behavior. Expected on first use.

---

### Flow E — P1/P2 wins, venv manager, persisted env is stale (env deleted)

```
venvManager.get(folderUri):
  → _initialized not completed? YES
  → scope is Uri? YES
  → getVenvForWorkspace(fsPath) → "/project/.venv"
  → resolveVenvPythonEnvironmentPath(".venv") → FAILS (path doesn't exist)
  → catches error, logs warning
  → falls through to: await this.initialize()         ← SLOW (graceful degradation)
  → looks up fsPathToEnv map → returns whatever discovery finds
```
**Speed: ~seconds.** Graceful fallback. User sees a different or no env.

---

### Flow F — P3 wins (defaultInterpreterPath set)

```
resolvePriorityChainCore(folderUri)
  → P3: defaultInterpreterPath = "/usr/local/bin/python3"
  → calls tryResolveInterpreterPath()                 ← EXISTING fast path (unchanged)
    → nativeFinder.resolve(path) — single PET call
    → api.resolveEnvironment() → finds manager
    → builds wrapper PythonEnvironment
  → returns { manager, environment, source: 'defaultInterpreterPath' }

applyInitialEnvironmentSelection:
  → result.environment IS set → ?? short-circuits
  → never calls manager.get()                         (venv fast path not involved)
```
**Speed: ~milliseconds.** Already fast before this change.

---

### Flow G — P1/P2 wins, non-venv manager (conda/system/pyenv/pipenv)

```
resolvePriorityChainCore(folderUri)
  → returns { manager: condaManager, environment: undefined }

applyInitialEnvironmentSelection:
  → calls: await condaManager.get(folderUri)
  → condaManager has NO fast path yet                 ← SLOW (full PET discovery)
  → await initialize() → internalRefresh → loadEnvMap → return from map
```
**Speed: ~seconds.** Unchanged — only venv has the optimization so far.
Future work: apply the same pattern to conda, system, pyenv, pipenv.

---

### Flow H — Global scope (no workspace folder)

```
venvManager.get(undefined):
  → scope is NOT Uri → fast path condition fails
  → falls through to: await this.initialize()         ← SLOW
  → return this.globalEnv
```
**Speed: ~seconds.** The fast path only handles Uri scopes. Global scope
is secondary — it resolves after workspace folders.

---

### Flow I — Second call to get() while background init is in progress

```
venvManager.get(folderUri):
  → _initialized exists, not completed? YES
  → scope is Uri? YES
  → getVenvForWorkspace(fsPath) → "/project/.venv"
  → resolveVenvPythonEnvironmentPath → resolved ✓
  → _initialized already exists → skip background init kickoff
  → return resolved                                   ← FAST (same answer, no new work)
```
**Speed: ~milliseconds.** Safe re-entrant behavior.

---

## Summary

| Flow | Priority | Manager | Persisted? | Speed | Path taken |
|------|----------|---------|------------|-------|------------|
| **A** | P1 | venv | ✓ | **~ms** | fast path in `get()` |
| **B** | P4 | venv | ✓ | **~ms** | fast path in `get()` via autoDiscover |
| **C** | P2 | venv | ✓ | **~ms** | fast path in `get()` |
| **D** | P1/P2 | venv | ✗ | ~sec | slow: full init |
| **E** | P1/P2 | venv | stale | ~sec | fast fails → slow fallback |
| **F** | P3 | any | n/a | **~ms** | existing tryResolveInterpreterPath |
| **G** | P1/P2 | non-venv | any | ~sec | slow: no fast path yet |
| **H** | global | venv | any | ~sec | scope not Uri → slow |
| **I** | any | venv | ✓ | **~ms** | fast path (re-entrant) |

**Biggest wins:** Flows A, B, C — the common reload case where a user previously selected a venv is the most impactful.

---

## Telemetry: Measuring the Fast Path

### Available Signals

| Event | Duration | Key Properties | What It Tells Us |
|-------|----------|----------------|------------------|
| `ENV_SELECTION.RESULT` | ✅ per-scope | `resolutionPath`, `prioritySource`, `managerId`, `hasPersistedSelection` | How long each workspace folder took to resolve, and which path was used |
| `ENV_SELECTION.STARTED` | ✅ activation→ready | `registeredManagerCount`, `workspaceFolderCount` | Time from activation to start of env selection |
| `ENVIRONMENT_DISCOVERY` | ✅ per-manager | `managerId`, `result`, `envCount` | Full discovery cost per manager (slow path) |
| `PET.INIT_DURATION` | ✅ | `result` | Native finder startup cost |
| `EXTENSION.ACTIVATION_DURATION` | ✅ | — | Overall activation time |

### Telemetry Gap

Currently, `ENV_SELECTION.RESULT` sets `resolutionPath` to `'managerDiscovery'` for all cases where `manager.get()` is called (line 318 in interpreterSelection.ts). This includes both:
- **Fast path:** persisted env resolved in ~ms via `manager.get()` fast path
- **Slow path:** full init + discovery in ~seconds via `manager.get()` slow path

Both show as `resolutionPath: 'managerDiscovery'`. To distinguish them, consider adding a new value like `'managerFastPath'` or a boolean `usedFastPath` property. Until then, the **duration** on `managerDiscovery` events is the best proxy — fast path will be <100ms, slow path will be >500ms.

### Kusto Queries

#### 1. Duration distribution: fast path vs slow path (proxy via duration)

```kusto
// ENV_SELECTION.RESULT duration by resolution path
// Fast path should show as managerDiscovery with duration < 100ms
customEvents
| where name == "ENV_SELECTION.RESULT"
| extend duration = todouble(customMeasurements.duration)
| extend resolutionPath = tostring(customDimensions.resolutionPath)
| extend managerId = tostring(customDimensions.managerId)
| extend prioritySource = tostring(customDimensions.prioritySource)
| extend speedBucket = case(duration < 100, "fast (<100ms)",
                            duration < 500, "medium (100-500ms)",
                            duration < 2000, "slow (500ms-2s)",
                            "very slow (>2s)")
| summarize count(), avg(duration), percentile(duration, 50), percentile(duration, 95)
    by resolutionPath, speedBucket
| order by resolutionPath, speedBucket
```

#### 2. Venv-specific: duration before vs after fast path rollout

```kusto
// Compare venv manager.get() duration over time
// After rollout, managerDiscovery with venv should shift toward <100ms
customEvents
| where name == "ENV_SELECTION.RESULT"
| where tostring(customDimensions.resolutionPath) == "managerDiscovery"
| where tostring(customDimensions.managerId) contains "venv"
| extend duration = todouble(customMeasurements.duration)
| summarize p50 = percentile(duration, 50),
            p95 = percentile(duration, 95),
            avg_duration = avg(duration),
            total = count()
    by bin(timestamp, 1d)
| order by timestamp asc
| render timechart
```

#### 3. Fast path hit rate (proxy: managerDiscovery + duration < 100ms + venv)

```kusto
// Estimate fast path hit rate for venv manager
customEvents
| where name == "ENV_SELECTION.RESULT"
| where tostring(customDimensions.managerId) contains "venv"
| where tostring(customDimensions.resolutionPath) == "managerDiscovery"
| extend duration = todouble(customMeasurements.duration)
| extend hitFastPath = duration < 100
| summarize fastCount = countif(hitFastPath),
            slowCount = countif(not(hitFastPath)),
            total = count()
    by bin(timestamp, 1d)
| extend hitRate = round(100.0 * fastCount / total, 1)
| order by timestamp asc
```

#### 4. Overall env selection duration (end-to-end per folder)

```kusto
// Overall env selection duration trend
customEvents
| where name == "ENV_SELECTION.RESULT"
| where tostring(customDimensions.scope) == "workspace"
| extend duration = todouble(customMeasurements.duration)
| summarize p50 = percentile(duration, 50),
            p95 = percentile(duration, 95),
            count()
    by bin(timestamp, 1d)
| order by timestamp asc
| render timechart
```

#### 5. Activation-to-ready duration trend

```kusto
// Time from extension activation to start of env selection
customEvents
| where name == "ENV_SELECTION.STARTED"
| extend duration = todouble(customMeasurements.duration)
| summarize p50 = percentile(duration, 50),
            p95 = percentile(duration, 95)
    by bin(timestamp, 1d)
| order by timestamp asc
| render timechart
```

#### 6. Error detection: fast path failures falling back to slow

```kusto
// Look for venv selections that are slow despite having persisted state
// This indicates fast path failed and fell back
customEvents
| where name == "ENV_SELECTION.RESULT"
| where tostring(customDimensions.managerId) contains "venv"
| where tostring(customDimensions.resolutionPath) == "managerDiscovery"
| where tostring(customDimensions.hasPersistedSelection) == "true"
| extend duration = todouble(customMeasurements.duration)
| where duration > 500
| project timestamp, duration,
         tostring(customDimensions.prioritySource),
         tostring(customDimensions.managerId)
| order by timestamp desc
```

#### 7. Full discovery still happening (background init cost)

```kusto
// ENVIRONMENT_DISCOVERY duration for venv — this still fires during background init
// but should no longer block the user
customEvents
| where name == "ENVIRONMENT_DISCOVERY"
| where tostring(customDimensions.managerId) contains "venv"
| extend duration = todouble(customMeasurements.duration)
| extend result = tostring(customDimensions.result)
| summarize p50 = percentile(duration, 50),
            p95 = percentile(duration, 95),
            errorRate = round(100.0 * countif(result != "success") / count(), 1)
    by bin(timestamp, 1d)
| order by timestamp asc
```

### What to Watch For

**Things going well:**
- Query 2: p50 duration for venv `managerDiscovery` drops from ~seconds to <100ms
- Query 3: fast path hit rate >80% for returning users
- Query 4: overall p50 env selection duration improves

**Things going wrong:**
- Query 6: many events with `hasPersistedSelection: true` but duration >500ms → fast path is failing/falling back
- Query 7: `ENVIRONMENT_DISCOVERY` error rate increases → background init has issues
- Query 3: hit rate stays near 0% → persisted state isn't being read, or condition is wrong

### Recommended Telemetry Improvement

Add a `resolutionPath: 'managerFastPath'` value (or a `usedFastPath: boolean` property) to `ENV_SELECTION.RESULT` so we can distinguish fast-path resolutions from slow-path resolutions without relying on the duration proxy. This would require the manager to signal back that it used the fast path — e.g., by tagging the returned `PythonEnvironment` or via a separate API
selected a venv environment. These go from ~seconds to ~milliseconds.