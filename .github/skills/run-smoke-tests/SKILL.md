---
name: run-smoke-tests
description: Run smoke tests to verify extension functionality in a real VS Code environment. Use this when checking if basic features work after changes.
---

Run smoke tests to verify the extension loads and basic functionality works in a real VS Code environment.

## When to Use This Skill

- After making changes to extension activation code
- After modifying commands or API exports
- Before submitting a PR to verify nothing is broken
- When the user asks to "run smoke tests" or "verify the extension works"

## Quick Reference

| Action              | Command                                              |
| ------------------- | ---------------------------------------------------- |
| Run all smoke tests | `npm run compile-tests && npm run smoke-test`        |
| Run specific test   | `npm run smoke-test -- --grep "Extension activates"` |
| Debug in VS Code    | Debug panel → "Smoke Tests" → F5                     |

## How Smoke Tests Work

Unlike unit tests (which mock VS Code), smoke tests run inside a **real VS Code instance**:

1. `npm run smoke-test` uses `@vscode/test-cli`
2. The CLI downloads a standalone VS Code binary (cached in `.vscode-test/`)
3. It launches that VS Code with your extension installed
4. Mocha runs test files inside that VS Code process
5. Results are reported back to your terminal

This is why smoke tests are slower (~10-60s) but catch real integration issues.

## Workflow

### Step 1: Compile and Run

```bash
npm run compile-tests && npm run smoke-test
```

### Step 2: Interpret Results

**Pass:** `4 passing (2s)` → Extension works, proceed.

**Fail:** See error message and check Debugging section.

### Running Individual Tests

To run a specific test instead of the whole suite:

```bash
# By test name (grep pattern)
npm run smoke-test -- --grep "Extension activates"

# Or temporarily add .only in code:
test.only('Extension activates without errors', ...)
```

## Debugging Failures

| Error                             | Cause                         | Fix                                         |
| --------------------------------- | ----------------------------- | ------------------------------------------- |
| `Extension not installed`         | Build failed or ID mismatch   | Run `npm run compile`, check extension ID   |
| `Extension did not become active` | Error in activate()           | Debug with F5, check Debug Console          |
| `Command not registered`          | Missing from package.json     | Add to contributes.commands                 |
| `Timeout exceeded`                | Slow startup or infinite loop | Increase timeout or check for blocking code |

For detailed debugging, use VS Code: Debug panel → "Smoke Tests" → F5

## Adding New Smoke Tests

Create a new file in `src/test/smoke/` with the naming convention `*.smoke.test.ts`:

```typescript
import * as assert from 'assert';
import * as vscode from 'vscode';
import { waitForCondition } from '../testUtils';
import { ENVS_EXTENSION_ID } from '../constants';

suite('Smoke: [Feature Name]', function () {
    this.timeout(60_000);

    test('[Test description]', async function () {
        // Arrange
        const extension = vscode.extensions.getExtension(ENVS_EXTENSION_ID);
        assert.ok(extension, 'Extension not found');

        // Ensure extension is active
        if (!extension.isActive) {
            await extension.activate();
        }

        // Act
        const result = await someOperation();

        // Assert
        assert.strictEqual(result, expected, 'Description of what went wrong');
    });
});
```

**Key patterns:**

- Use `waitForCondition()` instead of `sleep()` for async assertions
- Set generous timeouts (`this.timeout(60_000)`)
- Include clear error messages in assertions

## Test Files

| File                                      | Purpose                            |
| ----------------------------------------- | ---------------------------------- |
| `src/test/smoke/activation.smoke.test.ts` | Extension activation tests         |
| `src/test/smoke/index.ts`                 | Test runner entry point            |
| `src/test/testUtils.ts`                   | Utilities (waitForCondition, etc.) |

## Prerequisites

- **Test settings file**: `.vscode-test/user-data/User/settings.json` must exist with `"python.useEnvironmentsExtension": true` (without this, the extension returns `undefined` from `activate()`)
- **Extension builds**: Run `npm run compile` before tests

## Notes

- First run downloads VS Code (~100MB, cached in `.vscode-test/`)
- Tests auto-retry once on failure
- See [docs/smoke-tests.md](../../../docs/smoke-tests.md) for detailed documentation
- See [docs/test-types-comparison.md](../../../docs/test-types-comparison.md) for when to use which test type
