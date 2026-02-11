# E2E Tests Guide

End-to-end (E2E) tests verify complete user workflows in a real VS Code environment.

## E2E vs Smoke Tests

| Aspect | Smoke Tests | E2E Tests |
|--------|-------------|-----------|
| **Purpose** | Quick sanity check | Full workflow validation |
| **Scope** | Extension loads, commands exist | Complete user scenarios |
| **Duration** | 10-30 seconds | 1-3 minutes |
| **When to run** | Every commit | Before releases, after major changes |
| **Examples** | "Extension activates" | "Create venv, install package, run code" |

## Quick Reference

| Action | Command |
|--------|---------|
| Run all E2E tests | `npm run compile-tests && npm run e2e-test` |
| Run specific test | `npm run e2e-test -- --grep "discovers"` |
| Debug in VS Code | Debug panel → "E2E Tests" → F5 |

## How E2E Tests Work

1. `npm run e2e-test` uses `@vscode/test-cli`
2. Launches a real VS Code instance with your extension
3. Tests interact with the **real extension API** (not mocks)
4. Workflows execute just like a user would experience them

### What E2E Tests Actually Are

**E2E tests are API-level integration tests**, not UI tests. They call your extension's exported API and VS Code commands, but they don't click buttons or interact with tree views directly.

```
┌─────────────────────────────────────────────────────────┐
│                    VS Code Instance                      │
│  ┌──────────────┐         ┌──────────────────────────┐  │
│  │  Your Test   │ ──API──▶│   Your Extension         │  │
│  │  (Mocha)     │         │   - activate() returns   │  │
│  │              │ ◀─data──│     the API object       │  │
│  └──────────────┘         │   - getEnvironments()    │  │
│         │                 │   - createEnvironment()  │  │
│         │ executeCommand  └──────────────────────────┘  │
│         ▼                                                │
│  ┌──────────────────────────────────────────────────┐   │
│  │  VS Code Commands (python-envs.create, etc.)     │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │  UI (Tree Views, Status Bar, Pickers)            │   │
│  │  ❌ Tests do NOT interact with this directly     │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### What You Can Test

| Approach | What It Tests | Example |
|----------|---------------|----------|
| **Extension API** | Core logic works | `api.getEnvironments('all')` |
| **executeCommand** | Commands run without error | `vscode.commands.executeCommand('python-envs.refreshAllManagers')` |
| **File system** | Side effects occurred | Check `.venv` folder was created |
| **Settings** | State persisted | Read `workspace.getConfiguration()` |

### What You Cannot Test (Without Extra Tools)

- Clicking buttons in the UI
- Selecting items in tree views  
- Tooltip content appearing
- Quick pick visual behavior

For true UI testing, you'd need tools like Playwright - but that's significantly more complex.

## Writing E2E Tests

### File Naming

Place E2E tests in `src/test/e2e/` with the pattern `*.e2e.test.ts`:

```
src/test/e2e/
├── index.ts                           # Test runner
├── environmentDiscovery.e2e.test.ts   # Discovery workflow
├── createEnvironment.e2e.test.ts      # Creation workflow
└── selectInterpreter.e2e.test.ts      # Selection workflow
```

### Test Structure

```typescript
import * as assert from 'assert';
import * as vscode from 'vscode';
import { waitForCondition } from '../testUtils';
import { ENVS_EXTENSION_ID } from '../constants';

suite('E2E: [Workflow Name]', function () {
    this.timeout(120_000); // 2 minutes

    let api: ExtensionApi;

    suiteSetup(async function () {
        // Get and activate extension
        const extension = vscode.extensions.getExtension(ENVS_EXTENSION_ID);
        assert.ok(extension, 'Extension not found');

        if (!extension.isActive) {
            await extension.activate();
        }

        api = extension.exports;
    });

    test('[Step in workflow]', async function () {
        // Arrange - set up preconditions
        
        // Act - perform the user action
        
        // Assert - verify the outcome
    });
});
```

### Key Differences from Smoke Tests

1. **Longer timeouts** - Workflows take time (use 2-3 minutes)
2. **State dependencies** - Tests may build on each other
3. **Real side effects** - May create files, modify settings
4. **Cleanup required** - Use `suiteTeardown` to clean up

### Using the Extension API

E2E tests use the real extension API. **The API is flat** (methods directly on the api object):

```typescript
// Get environments - note: flat API, not api.environments.getEnvironments()
const envs = await api.getEnvironments('all');

// Trigger refresh
await api.refreshEnvironments(undefined);

// Set environment for a folder  
await api.setEnvironment(workspaceFolder, selectedEnv);
```

### Using executeCommand

You can also test via VS Code commands:

```typescript
test('Refresh command completes without error', async function () {
    // Execute the real command handler
    await vscode.commands.executeCommand('python-envs.refreshAllManagers');
    // If we get here without throwing, it worked
});

test('Set command updates the active environment', async function () {
    const envs = await api.getEnvironments('all');
    const envToSet = envs[0];
    
    // Execute command with arguments
    await vscode.commands.executeCommand('python-envs.set', envToSet);
    
    // Verify it took effect
    const activeEnv = await api.getEnvironment(workspaceFolder);
    assert.strictEqual(activeEnv?.envId.id, envToSet.envId.id);
});
```

**Caveat:** Commands that show UI (quick picks, input boxes) will **block** waiting for user input unless:
1. The command accepts arguments that skip the UI
2. You're testing just that the command exists (smoke test level)

```typescript
// This might hang waiting for user input:
await vscode.commands.executeCommand('python-envs.create');

// This works if the command supports direct arguments:
await vscode.commands.executeCommand('python-envs.create', { 
    manager: someManager,  // Skip "which manager?" picker
});
```

### Waiting for Async Operations

Always use `waitForCondition()` instead of `sleep()`:

```typescript
// Wait for environments to be discovered
await waitForCondition(
    async () => {
        const envs = await api.getEnvironments('all');
        return envs.length > 0;
    },
    60_000,
    'No environments discovered'
);
```

## Debugging Failures

| Error | Likely Cause | Fix |
|-------|--------------|-----|
| Timeout exceeded | Async operation not awaited properly, or waiting for wrong condition | Check that all Promises are awaited; verify `waitForCondition` checks the right state |
| API not available | Extension didn't activate | Check extension errors in Debug Console |
| No environments | Python not installed or discovery failed | Verify Python is on PATH |
| State pollution | Previous test left bad state | Add cleanup in `suiteTeardown` |

### Debug with VS Code

1. Set breakpoints in test or extension code
2. Select "E2E Tests" from Debug dropdown
3. Press F5
4. Step through the workflow

## Test Isolation

E2E tests can affect system state. Follow these guidelines:

### Do

- Clean up created files/folders in `suiteTeardown`
- Use unique names for created resources (include timestamp)
- Reset modified settings

### Don't

- Assume a specific starting state
- Leave test artifacts behind
- Modify global settings without restoring

### Cleanup Pattern

```typescript
suite('E2E: Create Environment', function () {
    const createdEnvs: string[] = [];

    suiteTeardown(async function () {
        // Clean up any environments created during tests
        for (const envPath of createdEnvs) {
            try {
                await fs.rm(envPath, { recursive: true });
            } catch {
                // Ignore cleanup errors
            }
        }
    });

    test('Creates venv', async function () {
        const envPath = await api.createEnvironment(/* ... */);
        createdEnvs.push(envPath); // Track for cleanup
        
        // Verify via API
        const envs = await api.getEnvironments('all');
        assert.ok(envs.some(e => e.environmentPath.fsPath.includes(envPath)));
        
        // Or verify file system directly
        const venvExists = fs.existsSync(envPath);
        assert.ok(venvExists, '.venv folder should exist');
    });
});
```

## Suggested E2E Test Scenarios

Based on the [gap analysis](../ai-artifacts/testing-work/02-gap-analysis.md):

| Scenario | Tests |
|----------|-------|
| **Environment Discovery** | Finds Python, discovers envs, has required properties |
| **Create Environment** | Creates venv, appears in list, has correct Python version |
| **Install Packages** | Installs package, appears in package list, importable |
| **Select Interpreter** | Sets env for folder, persists after reload |
| **Multi-root Workspace** | Different envs per folder, switching works |

## Test Files

| File | Purpose |
|------|---------|
| `src/test/e2e/index.ts` | Test runner entry point |
| `src/test/e2e/environmentDiscovery.e2e.test.ts` | Discovery workflow tests |
| `src/test/testUtils.ts` | Shared utilities (`waitForCondition`, etc.) |
| `src/test/constants.ts` | Constants (`ENVS_EXTENSION_ID`, timeouts) |

## Notes

- E2E tests require Python to be installed on the test machine
- First run downloads VS Code (~100MB, cached)
- Tests auto-retry once on failure
- Run smoke tests first - if those fail, E2E will too
- Requires `.vscode-test/user-data/User/settings.json` with `"python.useEnvironmentsExtension": true`

## CI Configuration

E2E tests run automatically on every PR via GitHub Actions (`.github/workflows/pr-check.yml`).

**How CI sets up the environment:**

```yaml
# Python is installed via actions/setup-python
- uses: actions/setup-python@v5
  with:
    python-version: '3.11'

# Test settings are configured before running tests  
- run: |
    mkdir -p .vscode-test/user-data/User
    echo '{"python.useEnvironmentsExtension": true}' > .vscode-test/user-data/User/settings.json

# Linux requires xvfb for headless VS Code
- uses: GabrielBB/xvfb-action@v1
  with:
    run: npm run e2e-test
```

**Test matrix:** Runs on `ubuntu-latest`, `windows-latest`, and `macos-latest`.

**Job dependencies:** E2E tests run after smoke tests pass (`needs: [smoke-tests]`). If smoke tests fail, there's likely a fundamental issue that would cause E2E to fail too.
