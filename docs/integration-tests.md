# Integration Tests Guide

Integration tests verify that multiple extension components work together correctly in a real VS Code environment.

## When to Use Integration Tests

**Ask yourself:** "Do these components communicate and synchronize correctly?"

| Good for | Not good for |
|----------|--------------|
| API reflects internal state | Testing isolated logic |
| Events fire and propagate | Quick sanity checks |
| Components stay in sync | Full user workflows |
| State changes trigger updates | UI behavior |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                 npm run integration-test                             │
│                           │                                          │
│                           ▼                                          │
│              ┌────────────────────────┐                             │
│              │   @vscode/test-cli     │ ◄── Configured by           │
│              │   (test launcher)      │     .vscode-test.mjs        │
│              └───────────┬────────────┘     (label: integrationTests)│
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
│              │  │ Mocha Test       │  │ ◄── src/test/integration/   │
│              │  │ Runner           │  │     index.ts                │
│              │  └────────┬─────────┘  │                             │
│              │           │            │                             │
│              │           ▼            │                             │
│              │  ┌──────────────────┐  │                             │
│              │  │ Test verifies:   │  │                             │
│              │  │ ┌──────────────┐ │  │                             │
│              │  │ │ Component A  │◄┼──┼── API call                  │
│              │  │ └──────┬───────┘ │  │                             │
│              │  │        │ event   │  │                             │
│              │  │        ▼         │  │                             │
│              │  │ ┌──────────────┐ │  │                             │
│              │  │ │ Component B  │─┼──┼──▶ State change verified    │
│              │  │ └──────────────┘ │  │                             │
│              │  └──────────────────┘  │                             │
│              └────────────────────────┘                             │
└─────────────────────────────────────────────────────────────────────┘
```

## What's Real vs Mocked

| Component | Real or Mocked | Notes |
|-----------|----------------|-------|
| VS Code APIs | **Real** | Full API access |
| Extension components | **Real** | Managers, API, state |
| Events | **Real** | Can subscribe and verify |
| File system | **Real** | For side-effect verification |
| Python environments | **Real** | Requires Python installed |

## How to Run

### 1. Copilot Skill (Recommended for agents)
Ask Copilot: "run integration tests" — uses the `run-integration-tests` skill at `.github/skills/run-integration-tests/`

### 2. Test Explorer
❌ **Integration tests cannot run in Test Explorer** — they require a separate VS Code instance.

### 3. VS Code Debug (Recommended for debugging)
1. Open Debug panel (Cmd+Shift+D)
2. Select **"Integration Tests"** from dropdown
3. Press **F5**
4. Set breakpoints in test or extension code

### 4. Command Line (Recommended for CI)
```bash
npm run compile-tests && npm run integration-test
```

### 5. Run Specific Test
```bash
npm run integration-test -- --grep "events"
```

## File Structure

```
src/test/integration/
├── index.ts                              # Test runner entry point
│                                         # - Sets VSC_PYTHON_INTEGRATION_TEST=1
│                                         # - Configures Mocha (2min timeout)
│                                         # - Finds *.integration.test.js
│
└── envManagerApi.integration.test.ts     # Test file
                                          # - Suite: "Integration: Manager + API"
                                          # - Tests: state sync, events, scopes
```

### Naming Convention
- Files: `*.integration.test.ts`
- Suites: `suite('Integration: [Component A] + [Component B]', ...)`
- Tests: What interaction is being verified

## Test Template

```typescript
import * as assert from 'assert';
import * as vscode from 'vscode';
import { ENVS_EXTENSION_ID } from '../constants';
import { waitForCondition } from '../testUtils';

suite('Integration: [Component A] + [Component B]', function () {
    this.timeout(60_000);

    let api: {
        getEnvironments(scope: 'all' | 'global'): Promise<unknown[]>;
        refreshEnvironments(scope: undefined): Promise<void>;
        onDidChangeEnvironments?: vscode.Event<unknown>;
    };

    suiteSetup(async function () {
        const extension = vscode.extensions.getExtension(ENVS_EXTENSION_ID);
        assert.ok(extension, 'Extension not found');

        if (!extension.isActive) {
            await extension.activate();
        }

        api = extension.exports;
    });

    test('API reflects state after action', async function () {
        // Trigger action
        await api.refreshEnvironments(undefined);

        // Verify API returns updated state
        const envs = await api.getEnvironments('all');
        assert.ok(envs.length > 0, 'Should have environments after refresh');
    });

    test('Event fires when state changes', async function () {
        if (!api.onDidChangeEnvironments) {
            this.skip();
            return;
        }

        let eventFired = false;
        const disposable = api.onDidChangeEnvironments(() => {
            eventFired = true;
        });

        try {
            await api.refreshEnvironments(undefined);
            await waitForCondition(
                () => eventFired,
                10_000,
                'Event did not fire'
            );
        } finally {
            disposable.dispose();
        }
    });
});
```

## Testing Events Pattern

Use a helper to capture events:

```typescript
class EventCapture<T> {
    private events: T[] = [];
    private disposable: vscode.Disposable;

    constructor(event: vscode.Event<T>) {
        this.disposable = event(e => this.events.push(e));
    }

    get fired(): boolean { return this.events.length > 0; }
    get count(): number { return this.events.length; }
    get all(): T[] { return [...this.events]; }
    
    dispose() { this.disposable.dispose(); }
}

// Usage
test('Events fire correctly', async function () {
    const capture = new EventCapture(api.onDidChangeEnvironments);
    
    await api.refreshEnvironments(undefined);
    await waitForCondition(() => capture.fired, 10_000, 'No event');
    
    assert.ok(capture.count >= 1);
    capture.dispose();
});
```

## Debugging Failures

| Error | Likely Cause | Fix |
|-------|--------------|-----|
| `Event not fired` | Event wiring broken, or wrong event | Check event registration; verify correct event |
| `State mismatch` | Components out of sync | Add logging; check update propagation path |
| `Timeout` | Async stuck or condition never met | Verify `waitForCondition` checks correct state |
| `API undefined` | Extension didn't activate | Check settings.json; debug activation |

## Learnings

- **API is flat**: Use `api.getEnvironments()`, NOT `api.environments.getEnvironments()` (1)
- **Test settings required**: Need `.vscode-test/user-data/User/settings.json` with `"python.useEnvironmentsExtension": true` (1)
- Events may fire multiple times — use `waitForCondition` not exact count assertions (1)
- Dispose event listeners in `finally` blocks to prevent leaks (1)

## Tips from vscode-python

Patterns borrowed from the Python extension:

1. **`TestEventHandler<T>`** — Wraps event subscription with assertion helpers:
   ```typescript
   handler.assertFired(waitPeriod)
   handler.assertFiredExactly(count, waitPeriod)
   handler.assertFiredAtLeast(count, waitPeriod)
   ```

2. **`Deferred<T>`** — Manual promise control for coordinating async:
   ```typescript
   const deferred = createDeferred<void>();
   api.onDidChange(() => deferred.resolve());
   await deferred.promise;
   ```

3. **Retry patterns** — For inherently flaky operations:
   ```typescript
   await retryIfFail(async () => {
       const envs = await api.getEnvironments('all');
       assert.ok(envs.length > 0);
   }, 30_000);
   ```
