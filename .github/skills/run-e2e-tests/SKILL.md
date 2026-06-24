---
name: run-e2e-tests
description: Run E2E tests to verify complete user workflows like environment discovery, creation, and selection. Use this before releases or after major changes.
---

Run E2E (end-to-end) tests to verify complete user workflows work correctly.

## When to Use This Skill

- Before submitting a PR with significant changes
- After modifying environment discovery, creation, or selection logic
- Before a release to validate full workflows
- When user reports a workflow is broken

**Note:** Run smoke tests first. If smoke tests fail, E2E tests will also fail.

## Quick Reference

| Action            | Command                                                        |
| ----------------- | -------------------------------------------------------------- |
| Run all E2E tests | `npm run compile && npm run compile-tests && npm run e2e-test` |
| Run specific test | `npm run e2e-test -- --grep "discovers"`                       |
| Debug in VS Code  | Debug panel → "E2E Tests" → F5                                 |

## How E2E Tests Work

Unlike unit tests (mocked) and smoke tests (quick checks), E2E tests:

1. Launch a real VS Code instance with the extension
2. Exercise complete user workflows via the real API
3. Verify end-to-end behavior (discovery → selection → execution)

They take longer (1-3 minutes) but catch integration issues.

## Workflow

### Step 1: Compile and Run

```bash
npm run compile && npm run compile-tests && npm run e2e-test
```

### Step 2: Interpret Results

**Pass:**

```
  E2E: Environment Discovery
    ✓ Can trigger environment refresh
    ✓ Discovers at least one environment
    ✓ Environments have required properties
    ✓ Can get global environments

  4 passing (45s)
```

**Fail:** Check error message and see Debugging section.

## Debugging Failures

| Error                        | Cause                  | Fix                                         |
| ---------------------------- | ---------------------- | ------------------------------------------- |
| `No environments discovered` | Python not installed   | Install Python, verify it's on PATH         |
| `Extension not found`        | Build failed           | Run `npm run compile`                       |
| `API not available`          | Activation error       | Debug with F5, check Debug Console          |
| `Timeout exceeded`           | Slow operation or hang | Increase timeout or check for blocking code |

For detailed debugging: Debug panel → "E2E Tests" → F5

## Prerequisites

E2E tests have system requirements:

- **Python installed** - At least one Python interpreter must be discoverable
- **Extension builds** - Run `npm run compile` before tests
- **CI needs webpack build** - Run `npm run compile` (webpack) before tests, not just `npm run compile-tests` (tsc)

## Adding New E2E Tests

Create files in `src/test/e2e/` with pattern `*.e2e.test.ts`:

```typescript
import * as assert from 'assert';
import * as vscode from 'vscode';
import { waitForCondition } from '../testUtils';
import { ENVS_EXTENSION_ID } from '../constants';

suite('E2E: [Workflow Name]', function () {
    this.timeout(120_000); // 2 minutes

    let api: ExtensionApi;

    suiteSetup(async function () {
        const extension = vscode.extensions.getExtension(ENVS_EXTENSION_ID);
        assert.ok(extension, 'Extension not found');
        if (!extension.isActive) await extension.activate();
        api = extension.exports;
    });

    test('[Test description]', async function () {
        // Use real API (flat structure, not nested!)
        // api.getEnvironments(), not api.environments.getEnvironments()
        await waitForCondition(
            async () => (await api.getEnvironments('all')).length > 0,
            60_000,
            'No environments found',
        );
    });
});
```

## Test Files

| File                                            | Purpose                              |
| ----------------------------------------------- | ------------------------------------ |
| `src/test/e2e/environmentDiscovery.e2e.test.ts` | Discovery workflow tests             |
| `src/test/e2e/index.ts`                         | Test runner entry point              |
| `src/test/testUtils.ts`                         | Utilities (`waitForCondition`, etc.) |

## Notes

- E2E tests are slower than smoke tests (expect 1-3 minutes)
- They may create/modify files - cleanup happens in `suiteTeardown`
- First run downloads VS Code (~100MB, cached in `.vscode-test/`)
- For more details on E2E tests and how they compare to other test types, refer to the project's testing documentation.
