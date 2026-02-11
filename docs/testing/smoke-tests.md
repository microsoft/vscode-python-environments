# Smoke Tests Guide

Smoke tests verify the extension loads and basic features work in a real VS Code environment.

## When to Use Smoke Tests

**Ask yourself:** "Does the extension load and have its basic features accessible?"

| Good for | Not good for |
|----------|--------------|
| Extension activates | Testing business logic |
| Commands are registered | Full user workflows |
| API is exported | Component interactions |
| Quick sanity checks | Edge cases |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    npm run smoke-test                                │
│                           │                                          │
│                           ▼                                          │
│              ┌────────────────────────┐                             │
│              │   @vscode/test-cli     │ ◄── Configured by           │
│              │   (test launcher)      │     .vscode-test.mjs        │
│              └───────────┬────────────┘     (label: smokeTests)     │
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
│              │  │ Mocha Test       │  │ ◄── src/test/smoke/index.ts │
│              │  │ Runner           │  │     finds *.smoke.test.js   │
│              │  └────────┬─────────┘  │                             │
│              │           │            │                             │
│              │           ▼            │                             │
│              │  ┌──────────────────┐  │                             │
│              │  │ Your Tests       │  │ ◄── *.smoke.test.ts         │
│              │  │ (real APIs!)     │  │                             │
│              │  └──────────────────┘  │                             │
│              └────────────────────────┘                             │
│                          │                                           │
│                          ▼                                           │
│                   Results to terminal                                │
└─────────────────────────────────────────────────────────────────────┘
```

## What's Real vs Mocked

| Component | Real or Mocked |
|-----------|----------------|
| VS Code APIs | **Real** |
| Extension activation | **Real** |
| File system | **Real** |
| Python environments | **Real** (requires Python installed) |
| Commands | **Real** |
| User interaction | **Cannot test** (no UI automation) |

## How to Run

### 1. Copilot Skill (Recommended for agents)
Ask Copilot: "run smoke tests" — uses the `run-smoke-tests` skill at `.github/skills/run-smoke-tests/`

### 2. Test Explorer (Unit tests only)
❌ **Smoke tests cannot run in Test Explorer** — they require a separate VS Code instance.

### 3. VS Code Debug (Recommended for debugging)
1. Open Debug panel (Cmd+Shift+D)
2. Select **"Smoke Tests"** from dropdown
3. Press **F5**
4. Set breakpoints in test or extension code

### 4. Command Line (Recommended for CI)
```bash
npm run compile-tests && npm run smoke-test
```

### 5. Run Specific Test
```bash
npm run smoke-test -- --grep "Extension activates"
```

Or add `.only` in code:
```typescript
test.only('Extension activates', async function () { ... });
```

## File Structure

```
src/test/smoke/
├── index.ts                      # Test runner entry point
│                                 # - Sets VSC_PYTHON_SMOKE_TEST=1
│                                 # - Configures Mocha (timeout, retries)
│                                 # - Finds *.smoke.test.js files
│
└── activation.smoke.test.ts      # Test file
                                  # - Suite: "Smoke: Extension Activation"
                                  # - Tests: installed, activates, exports, commands
```

### Naming Convention
- Files: `*.smoke.test.ts`
- Suites: `suite('Smoke: [Feature Name]', ...)`
- Tests: Descriptive of what's being verified

## Test Template

```typescript
import * as assert from 'assert';
import * as vscode from 'vscode';
import { ENVS_EXTENSION_ID } from '../constants';
import { waitForCondition } from '../testUtils';

suite('Smoke: [Feature Name]', function () {
    this.timeout(60_000);  // Generous timeout for CI

    test('[What is being verified]', async function () {
        // Arrange - Get extension
        const extension = vscode.extensions.getExtension(ENVS_EXTENSION_ID);
        assert.ok(extension, 'Extension not found');

        // Ensure active
        if (!extension.isActive) {
            await extension.activate();
            await waitForCondition(() => extension.isActive, 30_000, 'Did not activate');
        }

        // Act - Do something minimal
        const api = extension.exports;

        // Assert - Verify it worked
        assert.ok(api, 'API should be exported');
    });
});
```

## Debugging Failures

| Error | Likely Cause | Fix |
|-------|--------------|-----|
| `Extension not installed` | Build failed or ID mismatch | Run `npm run compile`, check extension ID |
| `Extension did not activate` | Error in `activate()` | Debug with F5, check Debug Console |
| `Command not registered` | Missing from package.json | Add to `contributes.commands` |
| `Timeout exceeded` | Async not awaited, or waiting for wrong condition | Check all Promises are awaited |
| `API undefined` | Settings not configured | Call `initializeTestSettings()` in `suiteSetup()` |

## Learnings

- **Test settings must be set PROGRAMMATICALLY**: Use `initializeTestSettings()` from `src/test/initialize.ts` in `suiteSetup()` BEFORE activating the extension. Static settings.json files are unreliable because ms-python.python may override defaults (1)
- **API is flat**: Use `api.getEnvironments()`, NOT `api.environments.getEnvironments()` (1)
- Use `waitForCondition()` instead of `sleep()` to reduce flakiness (1)
- Commands that show UI will hang — test command existence, not execution (1)
