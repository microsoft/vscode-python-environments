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

Essentially nothing extra to design — Pylance already routes through
our extension's API.

**Verified from source.** Pylance's
[`PythonEnvironmentExtensionApi.getActivePythonEnvironment(scope)`](Z:\Repos\pyrx\packages\vscode-pylance\src\common\pythonEnvironmentApi.ts)
calls our public API directly when our extension is present:

```typescript
const environment = await this._pythonEnvsApi.getEnvironment(scope);
return environment?.execInfo.run.executable;
```

The `scope` is the document URI, so per-file association works
out of the box. Whatever we register for `demo.py` is what Pylance
sees for `demo.py`.

**What we need to do:**

- After the env is materialized (created or reused), call
  `envManagers.setEnvironment(scriptUri, env, /*persist*/ true)`.
  Persistence is true so the association survives Code restart
  (`.vscode/settings.json` `python-envs.pythonProjects[]`, see Q6).
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

Same path as Pylance — and again, essentially solved by `setEnvironment`.

**Verified from source.** The Python extension's debug-config resolver
([`base.ts` lines 104-129](Z:\Repos\vscode-python\src\client\debugger\extension\configuration\resolvers\base.ts)):

```typescript
const interpreterPath =
    (await this.interpreterService.getActiveInterpreter(workspaceFolder))?.path ??
    this.configurationService.getSettings(workspaceFolder).pythonPath;
debugConfiguration.pythonPath = interpreterPath;
```

As long as we've registered the inline-metadata script as a
project, `getPythonProject(demo.py)` returns the script project, and the script's env is what Run/F5 launch with.

**What we need to do:**

- Same `setEnvironment(scriptUri, env, true)` call as in Q9. One
  registration covers Pylance, Run/F5, and the green Run button.
- Register each cached env at activation as a discoverable
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

---
### PR Phases at a glance

### Phase 1 — Foundation (parallelizable, no behavior change)

| # | Title | Scope | Depends on |
|---|---|---|---|
| **1** | Cache key hash utility | Pure functions: dep-list normalization (sort, lowercase, strip whitespace), SHA-256 truncation. Unit tests only. | — |
| **2** | Cache layout + `meta.json` sidecar helpers | Resolve `<globalStorage>/script-envs-v1/<hash>`; typed `MetaJson` interface; atomic read/write; pure TTL-eviction helper (given a list of entries → list of paths to delete). | — |
| **3** | `requires-python` → interpreter selection | Filter `api.getEnvironments('global')` via `matchesPythonVersion`; extract lower-bound version (`">=3.13"` → `"3.13"`) for the uv-install fallback. | — |

> All three can be developed in parallel.

### Phase 2 — Manager (internal only)

| # | Title | Scope | Depends on |
|---|---|---|---|
| **4** | `InlineScriptEnvManager` skeleton | Class implementing `EnvironmentManager`; `displayName = "Inline script environments"`; registered in `extension.ts`. `getEnvironments` returns `[]`. No `create`/`set` yet. Smoke check: appears as an empty section in the picker. | — |
| **5** | `create()` happy path | Given `(scriptUri, metadata)`: pick compatible installed Python (PR 3), compute hash (PR 1), build via existing `createWithProgress`, install deps, write `meta.json` (PR 2). No persistence. No uv-install fallback. | 1, 2, 3, 4 |
| **6** | `create()` uv-install fallback | Extend `promptInstallPythonViaUv` trigger union with `'inlineScript'`; thread the `requires-python` lower bound to `installPythonWithUv(version)`; wire into `create()` for the no-compatible-interpreter case. | 3, 5 |
| **7** | Persistence: `get` / `set` + Memento | New `INLINE_SCRIPT_ENVS_KEY`; per-URI `fsPathToEnv` map; cache-hit re-verify of `requires-python` (Q4 step 3). Mirrors `VenvManager` pattern. | 4 |
| **8** | Activation-time discovery | Walk cache dir, load sidecars, resolve via `nativeFinder.resolve()`, register items into the manager. Deferred via `setImmediate` so it doesn't block activation. | 2, 4, 7 |

> After Phase 2 the manager is fully functional but nothing automatically uses it.

### Phase 3 — Routing (the "go-live" PRs)

| # | Title | Scope | Depends on |
|---|---|---|---|
| **9** | Route PEP 723 scripts to the inline manager | `envManagers.getEnvironmentManager(uri)`: if `uri` is a known PEP 723 script **and** a cached env exists, return the inline manager; else fall through. Lazy parse with per-URI memoization (or extend `InlineScriptLazyDetector` with a public `isInlineScript(uri)` query). | 4, 7 |
| **10** | Per-script project registration | When the inline env is created/set, register the script as a `pythonProjects[]` entry so `addPythonProjectSetting` (called from `setEnvironment`) routes correctly. Cleanup on uninstall. | 9 |

### Phase 4 — UX (the user-facing entry points)

| # | Title | Scope | Depends on |
|---|---|---|---|
| **11** | Top-level "Set up env for this script" picker item | Extend `EnvironmentPickOptions` with `inlineScriptContext?: { uri, metadata }`; conditional row at the top of `pickEnvironment`. | 5, 9 |
| **12** | Bulk command: *Set Up Environments for Inline Script Files* | `workspace.findFiles('**/*.py', exclude)` → parse filter → multi-select quick-pick → loop `create`. Caps result count; excludes `.venv`, `node_modules`. | 5, 9 |

### Phase 5 — Lifecycle, telemetry & polish

| # | Title | Scope | Depends on |
|---|---|---|---|
| **13** | Command: *Clear Script Environment Cache* | Modal confirm; delete bucket; clear Memento; remove `pythonProjects[]` entries; fire `onDidChangeEnvironment`. Reuses `validateVenvRemovalPath` guards. | 2, 7 |
| **14** | Opportunistic TTL eviction | Debounced once-per-session walk on env-creation path; delete envs where `lastUsedAt > 14d`; reuses PR 13's cleanup helpers. | 2, 7, 13 |
| **15** | Remaining `inlineScript.*` telemetry | `envCreated`, `envReuseHit`, `envError` (with `category` enum incl. `'compatible-python-declined'`). Schema entries + call sites. | 5, 6, 7 |
| **16** | Status-bar treatment | Implementation of whichever Q8 option (A/B/C) is chosen. | 9 + design decision |

### Dependency / parallelism diagram

```
[1] [2] [3]          ← Phase 1: all parallel
   ╲ │ ╱
    [4]              ← skeleton
   ╱  │  ╲
 [5]  [7]  [8]       ← parallelizable after [4] (+ deps for 5/8)
  │
 [6]                 ← uv fallback, builds on [5]
  │
  └──► [9] ─► [10]   ← go-live
            ╲
        [11] [12]    ← UX in parallel
              │
        [13] ─► [14]  [15]   [16]
```

### Why these specific seams

| PR | Cohesion principle |
|---|---|
| 1 vs 2 | Hash is pure crypto; meta.json is fs + `globalStorageUri` integration. Different review eyes. |
| 5 vs 6 | Happy-path stays in the inline manager; fallback touches `uvPythonInstaller.ts` and changes a public type (the trigger union). |
| 7 separate from 5 | Persistence is the easiest place to introduce a regression; isolating it makes bisecting trivial. |
| 9 vs 10 | Routing is read-only; project registration writes to `settings.json`. Different reversal cost. |
| 11 vs 12 | Single-script is on the hot path (every picker open); bulk is one-shot. Different perf/UX concerns. |
| 13 vs 14 | Clear-cache is user-triggered & destructive; TTL is silent & opportunistic. Different telemetry & user-trust profiles. |

### Behavioral cut-over

PR 9 is the only one that changes implicit behavior for users who have
never invoked the feature. If extra caution is warranted, gate it
behind `python-envs.inlineScripts.enabled` (default `true`) for one
release cycle, then drop the flag in a follow-up PR. Every other PR is
opt-in by construction.

