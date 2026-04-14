
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
2. register all built-in managers in parallel (Promise.all):
   - system: create SysPythonManager + VenvManager + PipPackageManager, register immediately (✅ NO PET call, sets up file watcher)
   - conda: `getConda(nativeFinder)` checks settings → cache → persistent state → PATH
   - pyenv & pipenv & poetry: create PyEnvManager, register immediately
     - ✅ NO PET call — always registers unconditionally (lazy discovery)
   - shellStartupVars: initialize
   - all managers fire `onDidChangeEnvironmentManager` → ManagerReady resolves
3. all registrations complete (Promise.all resolves) — fast, typically milliseconds


**--- gate point: `applyInitialEnvironmentSelection` ---**

   📊 TELEMETRY: ENV_SELECTION.STARTED { duration, registeredManagerCount, registeredManagerIds, workspaceFolderCount }

**Step 1 — pick a manager** (`resolvePriorityChainCore`, per workspace folder + global):

| Priority | Source | Returns |
|----------|--------|---------|
| P1 | `pythonProjects[]` setting | manager only |
| P2 | `defaultEnvManager` setting | manager only |
| P3 | `python.defaultInterpreterPath` → `nativeFinder.resolve(path)` | manager **+ environment** |
| P4 | auto-discovery: venv → system python fallback | manager only |

**Step 2 — get the environment** (`result.environment ?? await result.manager.get(scope)`):

- **If P3 won:** environment is already resolved → done, no `get()` call needed.
- **Otherwise:** calls `manager.get(scope)`, which has two internal paths:

  **Fast path** (`tryFastPathGet` in `fastPath.ts`) — entered when `_initialized` hasn't completed and scope is a `Uri`:
  1. Synchronously create `_initialized` deferred + kick off `startBackgroundInit()` (fire-and-forget full PET discovery)
  2. Read persisted env path from workspace state
  3. If persisted path exists → `resolve(path)` → return immediately (background init continues in parallel)
  4. If no persisted path or resolve fails → fall through to slow path
  - *On background init failure:* clears `_initialized` so next `get()` retries

  **Slow path** — fast path skipped or failed:
  1. `initialize()` — lazy, once-only (guarded by `_initialized` deferred, concurrent callers await it)
     - `nativeFinder.refresh(false)` → PET scan (cached across managers after first call)
     - Filter results to this manager's type → populate `collection`
     - `loadEnvMap()` → match persisted paths against discovered envs
  2. Look up scope in `fsPathToEnv` → return matched env

   📊 TELEMETRY: ENV_SELECTION.RESULT (per scope) { duration, scope, prioritySource, managerId, path, hasPersistedSelection }

**Step 3 — done:**
- env cached in memory (no settings.json write)
- available via `api.getEnvironment(scope)`

   📊 TELEMETRY: EXTENSION.MANAGER_REGISTRATION_DURATION { duration, result, failureStage?, errorType? }

---

### Other entry points to `initialize()`

All three trigger `initialize()` lazily (once-only, guarded by `_initialized` deferred). After the first call completes, subsequent calls are no-ops.

**`manager.get(scope)`** — environment selection (Step 2 above):
- Called during `applyInitialEnvironmentSelection` or when settings change triggers re-selection
- Fast path may resolve immediately; slow path awaits `initialize()`

**`manager.getEnvironments(scope)`** — sidebar / listing:
- Called when user expands a manager node in the Python environments panel
- Also called by any API consumer requesting the full environment list
- If PET cache populated from earlier `get()` → instant hit; otherwise warm PET call

**`manager.resolve(context)`** — path resolution:
- Called when resolving a specific Python binary path to check if it belongs to this manager
- Used by `tryResolveInterpreterPath()` in the priority chain (P3) and by external API consumers
- Awaits `initialize()`, then delegates to manager-specific resolve (e.g., `resolvePipenvPath`)

---

POST-INIT:
1. register terminal package watcher
2. register settings change listener (`registerInterpreterSettingsChangeListener`) — re-runs priority chain if settings change
3.  initialize terminal manager
4.  send telemetry (manager selection, project structure, discovery summary)