# PEP 723 Design Questions

This is a checklist of design decisions to make **before** implementing
code for PEP 723 / inline-script-metadata support in the Python
Environments extension. 

## Table of contents

1. [Detection — when do we notice a PEP 723 script?](#1-detection)
2. [Where the env lives on disk](#2-disk-location)
3. [What's in the env folder](#3-env-folder-contents)
4. [How to map a script to its on-disk directory](#4-script-to-directory-mapping)
5. [When to reuse vs create a new env](#5-reuse-vs-create)
6. [Persistence model for the script-to-env association](#6-association-persistence)
7. [Cleanup model — when and how do envs get removed?](#7-cleanup)
8. [UX — bulk vs single env creation](#8-ux-flows)
9. [How does Pylance pick up the env?](#9-pylance)
10. [How does Run / F5 / debug pick up the env?](#10-run-debug)
11. [Telemetry — what events do we emit?](#11-telemetry)

---

## 1. Detection

**Question:** When do we decide a `.py` file is a "PEP 723 script"?

**Decision:**

- **Lazy on open + save** — parse only when the file enters an editor or
  is saved. 
- **Opt-in bulk command** — user runs `Python Envs: Set Up Environments for Inline Script Files` from the command palette to discover all of them, list every detected inline-script files in a multi-select quick-pick.

---

## 2. Disk location

**Question:** Where on disk does the env live?

**Decision:**

- **`<globalStorageUri>/script-envs-v1/<...>/`** — hidden per-extension,
  sandboxed by VS Code, never in workspace.

## 3. Env folder contents

**Question:** What's inside the env directory? What do we own, what does
pip own?

**Decision**

- **The venv itself** — standard `python -m venv` output. Includes
  `pyvenv.cfg`, `bin/` or `Scripts/`, `Lib/site-packages/`. We only
  own the env layer, let pip handle the package layer.

- **A `.meta.json` sidecar** at the root of each env directory. (See Q7 for why it's needed.)
  Records the bookkeeping the extension needs to manage the env's
  lifecycle. Minimum fields:

  ```jsonc
  {
    "schemaVersion": 1,
    "scriptFsPath": "c:\\projects\\demo.py",     // owning script
    "createdAt":  "2026-06-18T22:30:00.000Z",
    "lastUsedAt": "2026-06-18T22:45:12.000Z",    // bumped on every reuse; drives Q7's TTL
    "requiresPython": ">=3.11",
    "dependencies": ["rich", "requests"]
  }
  ```

  Plain JSON, no code execution.

## 4. Script-to-directory mapping

**Question:** Given a script (e.g. `c:\projects\demo.py`), how do we
compute the directory name for its env?

**Why it matters.** This is the *cache key*. The choice determines
whether the same script always gets the same env, whether different
scripts can share envs, and whether changing metadata invalidates the
mapping.

  - uv's choice: Script absolute path → same script always → same env.
  - pipx's choice: Dependency list → same deps always → same env.

**Decision:**

**Approach: pipx-style, deps-keyed cache, adapted to honor `requires-python`.**

### Reasons

1. **No sync operation needed.** Install/uninstall in place is unnecessary because the cache key changes whenever deps change. This is the structural win of pipx-style over uv-style.
2. Current pipx approach may let the temp envs grow fast but it's mitigated by Q7's TTL cleanup. We can always revisit if real-world growth is a problem.

### Hash inputs

- **Sorted, whitespace-normalized dependency list.** Sort
  alphabetically and strip internal whitespace so `["rich",
  "requests"]` and `["requests", "rich"]` and `"requests <3"` vs
  `"requests<3"` all produce the same hash. Without this the cache
  fragments on trivial differences.
- **Absolute path to the chosen Python interpreter**
  (e.g. `c:\Python313\python.exe`). Including this means changing
  the interpreter (system reinstall, switching between two
  installed Pythons) automatically produces a new cache entry —
  free invalidation, no special-case logic.

### Hash function and directory shape

- **SHA-256, truncated to 15-16 hex chars.** Node `crypto` stdlib;
  no new dependencies.
- **Directory name:** bare hex (e.g. `eabe3fccc4258ef`). The hash
  is never shown in the UI; users find it via "Reveal in Explorer"
  if they ever need to.

### Honoring `requires-python` (where we differ from pipx)

Pipx ignores `requires-python` entirely. We don't, because the IDE
experience (Pylance completions, Run, F5) depends on the interpreter
matching the script's declaration. Three pieces:

1. **At build time, pick a compatible interpreter.** Enumerate
   installed Pythons via `nativeFinder`, filter by
   `matchesPythonVersion(requiresPython, version)`,
   pick the newest match. If no installed Python satisfies the
   specifier, fall back to the existing `promptInstallPythonViaUv`
   flow (in [`src/managers/builtin/uvPythonInstaller.ts`](src/managers/builtin/uvPythonInstaller.ts))
   to ask the user to install a compatible Python via uv. If the
   user declines, surface a clear error and abort the build.

2. **Hash the chosen interpreter path into the cache key.** Catches
   "user reinstalled Python under the same path, version
   changed" and "metadata change switched us to a different
   installed Python".

3. **On cache hit, re-verify `requires-python` is still satisfied.**
   Before returning a cached env, check
   `matchesPythonVersion(metadata.requiresPython, env.version)`.
   If it now fails (e.g. metadata tightened from `>=3.11` to
   `==3.11.7` while the interpreter is 3.11.9), treat as a cache
   miss and rebuild. Catches the edge where deps and interpreter
   path are unchanged but the version specifier became stricter.

### Display name in status bar

Match the existing venv convention: `Python 3.13.7 (inline)`

## 5. Reuse vs create

**Question:** When do we reuse an existing env, when do we throw it
away and rebuild?

**Decision.**

There are only two outcomes — **reuse** or **build fresh**. There is
no "sync" or "delta install" path. The table below confirms each
case lands in the right bucket.

> **Note:** "Build fresh" describes *what happens when the user
> invokes env creation* (via the picker entry in Q8 or the bulk
> command in Q8).

| Change | Outcome |
|---|---|
| Nothing changed; user re-opens the script | **Reuse** — cache key unchanged, directory exists |
| User adds, removes, or repins a dep | **Build fresh** — cache key changes |
| User changes `requires-python` (compatible interpreter still selectable) | **Reuse** if the same interpreter is picked; **build fresh** if a different interpreter is now picked. Q4 step 3 catches the rare "specifier tightened past the cached interpreter" case and forces a rebuild. |
| User changes `requires-python` (no compatible interpreter installed) | Q4 step 1's `promptInstallPythonViaUv` fallback fires; build proceeds after install or aborts on user decline. |
| User moves / renames the script | **Reuse** — cache is deps-keyed, not path-keyed. Cross-script reuse is the intended behavior. |
| Someone `pip uninstall`s a package externally | **Reuse the (now-broken) env.** Script fails at runtime with `ModuleNotFoundError`. User can recover via `Python Envs: Clear Script Environment Cache` (see Q7). |
| Someone `pip install`s an extra package externally | **Reuse.** Extra package survives until the env hits the TTL. |

**What triggers the cache lookup?**

Lazy / on-demand. The cache lookup is performed inside `getEnvironment(scriptUri)`. Every consumer that asks "what's the env for this URI?" naturally triggers it. The existing API surface does the work.


## 6. Association persistence

**Question:** After we create the env for `demo.py`, where do we
remember "`demo.py` uses env at `<cache>/script-envs-v1/demo-b5849...`"?
What happens if the user explicitly selects a different env later?

**Decision.**

Reuse the existing venv persistence mechanism.Do not invent a new
layer for inline-script envs.

### Storage: same two layers venv uses today

The extension already persists script-to-env associations via two
layers ([`venvManager.ts:407-447`](src/managers/builtin/venvManager.ts) calls into
[`venvUtils.ts setVenvForWorkspace`](src/managers/builtin/venvUtils.ts) line 93):

| Layer | Where | Lifetime |
|---|---|---|
| In-memory map | `VenvManager.fsPathToEnv` (`Map<fsPath, PythonEnvironment>`) | Per session |
| Persistent state | `getWorkspacePersistentState()` (VS Code `Memento` keyed by `VENV_WORKSPACE_KEY`) | Across restarts |

For an inline-script env, we just call the same
`setEnvironment(scriptUri, env, /*persist*/ true)` API (per Q9 and
Q10). That call routes through `VenvManager.set` and writes both
layers automatically. **No new persistence code needed.**

## 7. Cleanup

**Question:** When and how do envs get removed from the cache? Without
cleanup, the cache grows unbounded.

**Decision.**

- **Explicit user command** — `Python Envs: Clear Script Environment
  Cache` from the command palette. Modal confirmation, then deletes
  the entire bucket. Reuses the existing `validateVenvRemovalPath`
  safety guards (refuses drive roots, shallow paths, anything without
  a `pyvenv.cfg`).

- **Opportunistic TTL inside the env-creation/lookup path** — every
  time the inline-script env handler runs (any path that creates,
  reuses, or syncs an env for a PEP 723 script), it walks the cache
  directory once. For each cached env whose `.meta.json` sidecar
  shows a `lastUsedAt` (bumped on every successful reuse) older than
  the threshold (**14 days**, matching pipx), delete it.

---

## 8. UX flows

**Question:** How does the user create envs — for a single script, and
for many scripts at once?

**Decision**

- **Bulk creation** — user runs `Python Envs: Set Up Environments for Inline Script Files` from the command palette to discover all of them, list every detected inline-script files in a multi-select quick-pick.

- **Single-script creation entry points** — Add the inline-script creation to a **top-level item** in the existing `Select Interpreter` quick-pick. Only shown when the active file is a PEP 723 script with parsed metadata; ordinary `.py` files see no change.

Question for single-script creation entry points: Today the status bar shows the workspace's env (or
"Select Python Interpreter" on yellow) for any focused `.py` file. When
a PEP 723 file has metadata but no dedicated env yet, what does the status bar show?

(A) Don't change it. Status bar shows `Python 3.11 ('.venv')` like any other file. 

(B) Append a hint. E.g., `$(warning) Python 3.11 ('.venv')` with a tooltip "demo.py declares inline metadata not present in this env.". Same click.

(C) Override label. When metadata is present but the active env wasn't built from it, show `Set up env for demo.py`. 

## 9. Pylance

**Question:** How does Pylance pick up the env so `import rich` resolves
and hover/completions work?

**Decision:**

We register the script-to-env association on our side via
`envManagers.setEnvironment(scriptUri, env, /*persist*/ true)` (per
Q6). On its own that is **not sufficient** — Pylance currently does
not query per-file env for regular `.py` files, so the per-file
mapping we register is invisible to it. Closing the gap requires a
small, contained Pylance-side change. The good news is that the
necessary primitive already exists in Pylance for notebook cells;
we extend it to regular `.py` files.

### Required Pylance change (sketch)

In `pylance-internal` and `vscode-pylance`:

1. **`documentWorkspaceResolver.getWorkspaceForFile`** — for regular
   `.py` files with inline script, when `pythonPath` is undefined, query per-file
   pythonPath via the existing `workspace/configuration` request
   with the file URI as scope. Pass it to the workspace factory the
   same way the notebook path does. If the per-file pythonPath
   matches the workspace's, the equality check in
   `_getOrCreateBestWorkspaceFileSync` short-circuits and the file
   shares the workspace's analysis — no sub-workspace, no extra
   cost. If different, an immutable sub-workspace is created pinned
   to that interpreter.
2. **A new custom LSP notification** (`python/didChangeFilePythonPath`)
   so that when we fire `onDidChangeEnvironment(scriptUri)` after
   the user creates / removes an inline env, Pylance can re-route
   that one file via the existing `moveFiles` flow without
   restarting analysis.
3. **A small server-side handler** that mirrors
   `_changeNotebookKernel`: re-resolve per-file pythonPath, call
   `moveFiles([fileUri], oldWorkspace, newWorkspace)`,
   `invalidateAndForceReanalysis`, and `tryAutoDispose` the old
   workspace if it's now empty.

### Behavior in both branches

- **No inline env registered (fallback case)** —
  `getEnvironment(scriptUri)` walks parents and returns the
  workspace folder's env. The per-file pythonPath equals the
  workspace's, the equality check skips sub-workspace creation, and
  the file is analyzed in the workspace env exactly as today.
  **Zero behavior change.**
- **Inline env registered** — `getEnvironment(scriptUri)` returns
  the inline env. The pythonPath differs from the workspace's, an
  immutable sub-workspace is created pinned to the inline env's
  interpreter, and the file is analyzed against that env's
  `site-packages`. `import rich` resolves.

### What we need to do on the Python Envs side

- After the env is materialized (created or reused), call
  `envManagers.setEnvironment(scriptUri, env, /*persist*/ true)`.
  Persistence is true so the association survives Code restart
  (`.vscode/settings.json` `python-envs.pythonProjects[]`, see Q6).
- Register the script as a `PythonProject(uri = scriptUri)` (per
  Q6 and Phase 3 PR 10) so the `onDidChangeActiveEnvironment` event
  fires with `e.uri = scriptUri`, giving Pylance the per-file URI
  it needs to re-route.
- After a sync operation installs new packages, fire
  `_onDidChangeEnvironment` so Pylance reloads its import graph.
  The existing `EnvironmentManagers.setEnvironment` already does
  this when the env reference itself changes; for an in-place
  package change we may need an explicit fire. (Verify during
  implementation.)

## 10. Run / Debug

**Question:** How do the green Run button and F5 (Run-and-Debug)
discover our env?

**Decision:**

The story splits in two:

- **Run Python File (green triangle / `Commands.Exec_In_Terminal`)** —
  already routes per-file correctly. Works out of the box once we
  call `setEnvironment(scriptUri, env, true)`.
- **F5 / Debug-in-Terminal** — does not route per-file today. The
  debug-config resolver passes the workspace folder URI to
  `getActiveInterpreter`, so the per-file env we registered is
  invisible. Requires a small fix in `vscode-python` (~10 LOC)
  for the per-file env to flow through to the debug launch. This
  is a **pre-existing gap**, not a PEP 723 regression — any user
  who today assigns a per-file env via "Select Interpreter" has the
  same problem with F5.

### Required vscode-python change (sketch)

In `resolveAndUpdatePythonPath`, prefer the program URI for the
env lookup when present, and keep the workspace folder as the
fallback for the settings call (which is workspace-scoped by
contract):

```typescript
if (debugConfiguration.pythonPath === '${command:python.interpreterPath}' || !debugConfiguration.pythonPath) {
    const programUri = debugConfiguration.program ? Uri.file(debugConfiguration.program) : undefined;
    const lookupScope = programUri ?? workspaceFolder;
    const interpreterPath =
        (await this.interpreterService.getActiveInterpreter(lookupScope))?.path ??
        this.configurationService.getSettings(workspaceFolder).pythonPath;
    debugConfiguration.pythonPath = interpreterPath;
}
// Apply the same shape to the `debugConfiguration.python` branch immediately below.
```

### What we need to do on the Python Envs side

- Same `setEnvironment(scriptUri, env, true)` call as Q9 — covers
  both Run (today) and Debug (post-fix). One registration covers
  Pylance, Run, F5, and the green Run button.
- Register each cached inline env at activation as a discoverable
  interpreter via `api.createPythonEnvironmentItem(...)`, so the
  Select Interpreter quick-pick lists them under "Inline script
  environments". This is the user's recovery path if our automatic
  association is somehow wrong.

## 11. Telemetry

**Question:** What telemetry events do we emit so we can tell if the
feature is working?

**Decision.** 

| Event | Properties | When fired |
|---|---|---|
| `inlineScript.detected` | trigger (open / save / scan), hasRequiresPython, depCount | Once per (URI, session) on first detection |
| `inlineScript.envCreated` | trigger, durationMs, basePythonVersion, depCount, success | After every creation attempt |
| `inlineScript.envReuseHit` | n/a | When ensureEnv finds a usable existing env, no work needed |
| `inlineScript.envError` | category (no-compatible-python / install-failure / network / lock-timeout) | On creation/sync failure |

