# E2E Tests Guide

E2E (end-to-end) tests verify complete user workflows in a real VS Code environment.

## When to Use E2E Tests

**Ask yourself:** "Does this complete user workflow work from start to finish?"

| Good for | Not good for |
|----------|--------------|
| Multi-step workflows | Testing isolated logic |
| Create → use → verify flows | Quick sanity checks |
| Features requiring real Python | Fast iteration |
| Pre-release validation | Component interaction details |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    npm run e2e-test                                  │
│                           │                                          │
│                           ▼                                          │
│              ┌────────────────────────┐                             │
│              │   @vscode/test-cli     │ ◄── Configured by           │
│              │   (test launcher)      │     .vscode-test.mjs        │
│              └───────────┬────────────┘     (label: e2eTests)       │
│                          │                                           │
│         Downloads VS Code (first run, cached after)                  │
│                          │                                           │
│                          ▼                                           │
│              ┌────────────────────────┐                             │
│              │  VS Code Instance      │                             │
│              │  (standalone, hidden)  │                             │
│              ├────────────────────────┤                             │
│              │  • Your extension      │ ◄── Compiled from out/      │
│              │  • ms-python.python    │ ◄── installExtensions       │
│              └───────────┬────────────┘                             │
│                          │                                           │
│                          ▼                                           │
│              ┌────────────────────────┐                             │
│              │  Extension Host        │                             │
│              │  ┌──────────────────┐  │                             │
│              │  │ Mocha Test       │  │ ◄── src/test/e2e/index.ts   │
│              │  │ Runner           │  │     finds *.e2e.test.js     │
│              │  └────────┬─────────┘  │                             │
│              │           │            │                             │
│              │           ▼            │                             │
│              │  ┌──────────────────┐  │                             │
│              │  │ Test calls API   │──┼──▶ Extension API            │
│              │  │                  │  │    (getEnvironments, etc.)  │
│              │  │                  │──┼──▶ VS Code Commands         │
│              │  │                  │  │    (executeCommand)         │
│              │  │                  │──┼──▶ File System              │
│              │  │                  │  │    (verify .venv created)   │
│              │  └──────────────────┘  │                             │
│              └────────────────────────┘                             │
│                          │                                           │
│              ❌ UI is NOT directly testable                          │
│                 (no clicking buttons, selecting items)               │
└─────────────────────────────────────────────────────────────────────┘
```

## What's Real vs Mocked

| Component | Real or Mocked | Notes |
|-----------|----------------|-------|
| VS Code APIs | **Real** | Full API access |
| Extension API | **Real** | `extension.exports` |
| File system | **Real** | Can create/delete files |
| Python environments | **Real** | Requires Python installed |
| Commands | **Real** | Via `executeCommand` |
| Quick picks / UI | **Cannot test** | Commands with UI will block |
| Tree views | **Cannot test** | No UI automation |

### Important: E2E Tests Are API Tests, Not UI Tests

Despite the name "end-to-end", these tests:
- ✅ Call your extension's exported API
- ✅ Execute VS Code commands
- ✅ Verify file system changes
- ❌ Do NOT click buttons or interact with UI elements

For true UI testing, you'd need Playwright or similar tools.

## How to Run

### 1. Copilot Skill (Recommended for agents)
Ask Copilot: "run e2e tests" — uses the `run-e2e-tests` skill at `.github/skills/run-e2e-tests/`

### 2. Test Explorer
❌ **E2E tests cannot run in Test Explorer** — they require a separate VS Code instance.

### 3. VS Code Debug (Recommended for debugging)
1. Open Debug panel (Cmd+Shift+D)
2. Select **"E2E Tests"** from dropdown
3. Press **F5**
4. Set breakpoints in test or extension code

### 4. Command Line (Recommended for CI)
```bash
npm run compile-tests && npm run e2e-test
```

### 5. Run Specific Test
```bash
npm run e2e-test -- --grep "discovers"
```

## File Structure

```
src/test/e2e/
├── index.ts                           # Test runner entry point
│                                      # - Sets VSC_PYTHON_E2E_TEST=1
│                                      # - Configures Mocha (3min timeout)
│                                      # - Finds *.e2e.test.js files
│
└── environmentDiscovery.e2e.test.ts   # Test file
                                       # - Suite: "E2E: Environment Discovery"
                                       # - Tests: refresh, discover, properties
```

### Naming Convention
- Files: `*.e2e.test.ts`
- Suites: `suite('E2E: [Workflow Name]', ...)`
- Tests: Steps in the workflow

## Test Template

```typescript
import * as assert from 'assert';
import * as vscode from 'vscode';
import { ENVS_EXTENSION_ID } from '../constants';
import { waitForCondition } from '../testUtils';

suite('E2E: [Workflow Name]', function () {
    this.timeout(120_000);  // 2 minutes for workflows

    // API is FLAT - methods directly on api object
    let api: {
        getEnvironments(scope: 'all' | 'global'): Promise<unknown[]>;
        refreshEnvironments(scope: undefined): Promise<void>;
    };

    suiteSetup(async function () {
        const extension = vscode.extensions.getExtension(ENVS_EXTENSION_ID);
        assert.ok(extension, 'Extension not found');

        if (!extension.isActive) {
            await extension.activate();
            await waitForCondition(() => extension.isActive, 30_000, 'Did not activate');
        }

        api = extension.exports;
        assert.ok(api, 'API not available');
    });

    test('Step 1: [Action]', async function () {
        // Perform action via API
        await api.refreshEnvironments(undefined);
    });

    test('Step 2: [Verification]', async function () {
        // Wait for result
        await waitForCondition(
            async () => (await api.getEnvironments('all')).length > 0,
            60_000,
            'No environments found'
        );
    });
});
```

## Using executeCommand

Commands can be tested if they accept programmatic arguments:

```typescript
// ✅ Works - command completes without UI
await vscode.commands.executeCommand('python-envs.refreshAllManagers');

// ✅ Works - passing arguments to skip picker UI
await vscode.commands.executeCommand('python-envs.set', someEnvironment);

// ❌ Hangs - command shows quick pick waiting for user
await vscode.commands.executeCommand('python-envs.create');
```

## Test Cleanup Pattern

E2E tests may create real files. Always clean up:

```typescript
suite('E2E: Create Environment', function () {
    const createdPaths: string[] = [];

    suiteTeardown(async function () {
        for (const p of createdPaths) {
            try {
                await fs.rm(p, { recursive: true });
            } catch { /* ignore */ }
        }
    });

    test('Creates venv', async function () {
        const envPath = await api.createEnvironment(/* ... */);
        createdPaths.push(envPath);  // Track for cleanup
        
        // Verify
        assert.ok(fs.existsSync(envPath));
    });
});
```

## Debugging Failures

| Error | Likely Cause | Fix |
|-------|--------------|-----|
| `Timeout exceeded` | Async not awaited, or `waitForCondition` checks wrong state | Verify all Promises awaited; check condition logic |
| `API not available` | Settings not configured | Call `initializeTestSettings()` in `suiteSetup()` |
| `No environments` | Python not installed | Install Python, verify on PATH |
| `Command hangs` | Command shows UI picker | Pass arguments to skip UI, or test differently |

## Learnings

- **API is flat**: Use `api.getEnvironments()`, NOT `api.environments.getEnvironments()` (1)
- **envId not id**: Environment objects have `envId` property (a `PythonEnvironmentId` with `id` and `managerId`), not a direct `id` (1)
- **Test settings must be set PROGRAMMATICALLY**: Call `initializeTestSettings()` in `suiteSetup()` BEFORE activating the extension. Static settings.json files are unreliable because ms-python.python may override defaults (1)
- **Commands with UI block**: Only test commands that accept programmatic arguments or have no UI (1)
- Use `waitForCondition()` for all async verifications — never use `sleep()` (1)

## Tips from vscode-python

Patterns borrowed from the Python extension:

1. **`Deferred<T>`** — Manual control over promise resolution for coordinating async tests
2. **`retryIfFail`** — Retry flaky operations with timeout
3. **`CleanupFixture`** — Track cleanup tasks and execute on teardown
4. **Platform-specific skips** — `if (process.platform === 'win32') return this.skip();`
