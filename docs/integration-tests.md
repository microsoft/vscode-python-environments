# Integration Tests Guide

Integration tests verify that multiple components work together correctly in a real VS Code environment.

## Integration vs Other Test Types

| Aspect | Unit Tests | Integration Tests | E2E Tests |
|--------|-----------|-------------------|-----------|
| **Environment** | Mocked VS Code | Real VS Code | Real VS Code |
| **Scope** | Single function | Component interactions | Full workflows |
| **Speed** | Fast (ms) | Medium (seconds) | Slow (minutes) |
| **Focus** | Logic correctness | Components work together | User scenarios work |

## Quick Reference

| Action | Command |
|--------|---------|
| Run all integration tests | `npm run compile-tests && npm run integration-test` |
| Run specific test | `npm run integration-test -- --grep "manager"` |
| Debug in VS Code | Debug panel → "Integration Tests" → F5 |

## What Integration Tests Cover

Based on the [gap analysis](../ai-artifacts/testing-work/02-gap-analysis.md):

| Component Interaction | What to Test |
|----------------------|--------------|
| Environment Manager + API | API reflects manager state, events fire |
| Project Manager + Settings | Settings changes update project state |
| Terminal + Environment | Terminal activates correct environment |
| Package Manager + Environment | Package operations update env state |

## Writing Integration Tests

### File Naming

Place tests in `src/test/integration/` with pattern `*.integration.test.ts`:

```
src/test/integration/
├── index.ts                              # Test runner
├── envManagerApi.integration.test.ts     # Manager + API integration
├── projectSettings.integration.test.ts   # Project + Settings
└── terminalEnv.integration.test.ts       # Terminal + Environment
```

### Test Structure

```typescript
import * as assert from 'assert';
import * as vscode from 'vscode';
import { waitForCondition, TestEventHandler } from '../testUtils';
import { ENVS_EXTENSION_ID } from '../constants';

suite('Integration: [Component A] + [Component B]', function () {
    this.timeout(120_000);

    let api: ExtensionApi;

    suiteSetup(async function () {
        const extension = vscode.extensions.getExtension(ENVS_EXTENSION_ID);
        assert.ok(extension, 'Extension not found');
        if (!extension.isActive) await extension.activate();
        api = extension.exports;
    });

    test('[Interaction being tested]', async function () {
        // Test that Component A and Component B work together
    });
});
```

### Testing Events Between Components

Use `TestEventHandler` to verify events propagate correctly:

```typescript
test('Changes in manager fire API events', async function () {
    const handler = new TestEventHandler(
        api.environments.onDidChangeEnvironments,
        'onDidChangeEnvironments'
    );

    try {
        // Trigger action that should fire events
        await api.environments.refresh(undefined);
        
        // Verify events fired
        if (handler.fired) {
            assert.ok(handler.first !== undefined);
        }
    } finally {
        handler.dispose();
    }
});
```

### Testing State Synchronization

```typescript
test('API reflects manager state after changes', async function () {
    // Get state before
    const before = await api.environments.getEnvironments('all');
    
    // Perform action
    await api.environments.refresh(undefined);
    
    // Get state after
    const after = await api.environments.getEnvironments('all');
    
    // Verify consistency
    assert.ok(Array.isArray(after), 'Should return array');
});
```

## Key Differences from E2E Tests

| Integration Tests | E2E Tests |
|------------------|-----------|
| Test component boundaries | Test user workflows |
| "Does A talk to B correctly?" | "Can user do X?" |
| Faster (30s-2min) | Slower (1-3min) |
| Focus on internal contracts | Focus on external behavior |

**Example:**
- Integration: "When environment manager refreshes, does the API return updated data?"
- E2E: "When user clicks refresh and selects an environment, does the terminal activate it?"

## Debugging Failures

| Error | Likely Cause | Fix |
|-------|--------------|-----|
| `API not available` | Extension activation failed | Check Debug Console for errors |
| `Event not fired` | Event wiring broken | Check event registration code |
| `State mismatch` | Components out of sync | Add logging, check update paths |
| `Timeout` | Async operation stuck | Increase timeout, check for deadlocks |

Debug with VS Code: Debug panel → "Integration Tests" → F5

## Test Files

| File | Purpose |
|------|---------|
| `src/test/integration/index.ts` | Test runner entry point |
| `src/test/integration/envManagerApi.integration.test.ts` | Manager + API tests |
| `src/test/testUtils.ts` | Shared utilities |
| `src/test/constants.ts` | Test constants |

## Notes

- Integration tests run in a real VS Code instance
- They're faster than E2E but slower than unit tests (expect 30s-2min)
- Use `waitForCondition()` for async operations
- First run downloads VS Code (~100MB, cached)
- Tests auto-retry once on failure
- Requires `.vscode-test/user-data/User/settings.json` with `"python.useEnvironmentsExtension": true`

## CI Configuration

Integration tests run automatically on every PR via GitHub Actions (`.github/workflows/pr-check.yml`).

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
    run: npm run integration-test
```

**Test matrix:** Runs on `ubuntu-latest`, `windows-latest`, and `macos-latest`.

**Job dependencies:** Integration tests run after smoke tests pass (`needs: [smoke-tests]`).
