# Smoke Tests Guide

This document explains everything you need to know about smoke tests in this extension.

## Table of Contents

1. [What Are Smoke Tests?](#what-are-smoke-tests)
2. [How to Run Smoke Tests](#how-to-run-smoke-tests)
3. [How to Debug Smoke Tests](#how-to-debug-smoke-tests)
4. [Writing Effective Assertions](#writing-effective-assertions)
5. [Preventing Flakiness](#preventing-flakiness)
6. [Smoke Test Architecture](#smoke-test-architecture)

---

## What Are Smoke Tests?

### The Basic Concept

Smoke tests are **quick sanity checks** that verify critical functionality works. The name comes from hardware testing - when you first power on a circuit, you check if smoke comes out. If it does, you have a serious problem. If not, you can proceed with detailed testing.

### How They Differ from Unit Tests

| Aspect | Unit Tests | Smoke Tests |
|--------|-----------|-------------|
| **Environment** | Mocked VS Code APIs | REAL VS Code instance |
| **Speed** | Fast (milliseconds) | Slower (seconds) |
| **Scope** | Single function/class | End-to-end feature |
| **Dependencies** | None/mocked | Real file system, real APIs |
| **Purpose** | Verify logic correctness | Verify system works together |

### What Smoke Tests Answer

- "Does the extension load without crashing?"
- "Are the commands registered?"
- "Can users access basic features?"
- "Did we break something obvious?"

### What Smoke Tests DON'T Answer

- "Is every edge case handled?"
- "Is the algorithm correct?"
- "Are all error messages right?"

---

## How to Run Smoke Tests

### Option 1: VS Code Debug (Recommended for Development)

1. Open VS Code in this project
2. Go to **Run and Debug** panel (Ctrl+Shift+D / Cmd+Shift+D)
3. Select **"Smoke Tests"** from the dropdown
4. Press **F5** or click the green play button

This opens a new VS Code window (the Extension Host) with:
- Your extension loaded
- The test framework running
- Output visible in the Debug Console

### Option 2: Command Line

```bash
# Build the tests first
npm run compile-tests

# Run smoke tests
npm run smoke-test
```

This downloads VS Code (if needed) and runs tests headlessly.

### Option 3: VS Code Test Explorer

1. Install the **Test Explorer** extension
2. Open the Testing sidebar
3. Find the smoke tests under your project
4. Click the play button next to any test

---

## How to Debug Smoke Tests

### Setting Breakpoints

You can set breakpoints in:
- **Test files** (`src/test/smoke/*.smoke.test.ts`)
- **Extension code** (`src/*.ts`)
- **Test utilities** (`src/test/testUtils.ts`)

### Debug Workflow

1. Set a breakpoint by clicking left of a line number
2. Select "Smoke Tests" launch configuration
3. Press F5
4. The Extension Host window opens
5. Tests start running
6. Execution pauses at your breakpoint
7. Use the Debug toolbar to step through code:
   - **F10**: Step Over (next line)
   - **F11**: Step Into (enter function)
   - **Shift+F11**: Step Out (exit function)
   - **F5**: Continue (to next breakpoint)

### Viewing Variables

While paused at a breakpoint:
- **Variables panel**: Shows local/global variables
- **Watch panel**: Add expressions to monitor
- **Debug Console**: Evaluate expressions (type `extension.isActive` and press Enter)

### Debug Console Commands

While debugging, you can run JavaScript in the Debug Console:

```javascript
// Check extension state
vscode.extensions.getExtension('ms-python.vscode-python-envs')

// List all commands
vscode.commands.getCommands().then(cmds => console.log(cmds.filter(c => c.includes('python'))))

// Check workspace
vscode.workspace.workspaceFolders
```

### Common Debugging Scenarios

#### Test Times Out

1. Check if the test is waiting for a condition that's never met
2. Add logging to see what state the extension is in:
   ```typescript
   console.log('Extension active?', extension.isActive);
   ```
3. Verify the timeout is long enough for your machine

#### Extension Not Found

1. Verify the extension ID matches `package.json`
2. Check the build completed without errors
3. Ensure `preLaunchTask` ran successfully

---

## Writing Effective Assertions

### Principle: Be Specific

❌ **Bad**: Vague assertion
```typescript
assert.ok(result);  // What should result be?
```

✅ **Good**: Specific assertion with context
```typescript
assert.ok(
    extension !== undefined,
    `Extension ${ENVS_EXTENSION_ID} is not installed. ` +
    'Check that the extension ID matches package.json.'
);
```

### Assertion Patterns

#### 1. Existence Checks

```typescript
// Check something exists
assert.ok(
    extension !== undefined,
    'Extension should be installed'
);

// Check something is truthy
assert.ok(
    api.getEnvironments,
    'API should have getEnvironments method'
);
```

#### 2. Equality Checks

```typescript
// Strict equality (type + value)
assert.strictEqual(
    extension.isActive,
    true,
    'Extension should be active'
);

// Deep equality (for objects/arrays)
assert.deepStrictEqual(
    result.errors,
    [],
    'Should have no errors'
);
```

#### 3. Array Membership

```typescript
const commands = await vscode.commands.getCommands();
assert.ok(
    commands.includes('python-envs.create'),
    'create command should be registered'
);
```

#### 4. Failure Cases

```typescript
try {
    await riskyOperation();
    assert.fail('Should have thrown an error');
} catch (error) {
    assert.ok(
        error.message.includes('expected'),
        `Error message should be descriptive: ${error.message}`
    );
}
```

### Error Message Guidelines

1. **State what was expected**: "Extension should be active"
2. **State what happened**: "but isActive is false"
3. **Suggest a fix**: "Check that activation completed"

```typescript
assert.strictEqual(
    extension.isActive,
    true,
    `Extension should be active after calling activate(), ` +
    `but isActive is ${extension.isActive}. ` +
    `Ensure the extension's activate() function resolves successfully.`
);
```

---

## Preventing Flakiness

Flaky tests pass sometimes and fail sometimes. They're the #1 cause of distrust in test suites.

### The Golden Rule: Never Use Sleep for Assertions

❌ **Wrong**: Arbitrary delays
```typescript
await sleep(5000);  // Hope 5 seconds is enough?
assert.ok(extension.isActive);
```

✅ **Right**: Wait for actual condition
```typescript
await waitForCondition(
    () => extension.isActive,
    30_000,
    'Extension did not activate within 30 seconds'
);
```

### Use `waitForCondition()` for Everything Async

```typescript
// Wait for file to exist
await waitForCondition(
    async () => {
        try {
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch {
            return false;
        }
    },
    10_000,
    'File was not created'
);

// Wait for environments to be discovered
await waitForCondition(
    async () => {
        const envs = await api.getEnvironments();
        return envs.length > 0;
    },
    60_000,
    'No environments discovered'
);
```

### Flakiness Sources and Fixes

| Source | Problem | Fix |
|--------|---------|-----|
| **Timing** | Test assumes operation completes instantly | Use `waitForCondition()` |
| **Order** | Tests depend on each other | Make tests independent |
| **State** | Previous test left state | Clean up in `teardown()` |
| **Resources** | File locked by other process | Use unique temp files |
| **Network** | API call sometimes slow | Increase timeout, add retry |

### Timeout Guidelines

- **Simple operations**: 10 seconds
- **Extension activation**: 30-60 seconds
- **Environment discovery**: 60-120 seconds
- **CI environments**: 2x local timeouts

### Built-in Retry

The smoke test runner retries failed tests once:

```javascript
// In src/test/smoke/index.ts
mocha.setup({
    retries: 1,  // Retry failed tests once
});
```

This handles transient failures but shouldn't be relied upon for consistently flaky tests.

---

## Smoke Test Architecture

### File Structure

```
src/test/
├── smoke/
│   ├── index.ts                    # Test runner entry point
│   ├── activation.smoke.test.ts    # Activation tests
│   └── [feature].smoke.test.ts     # Add more test files here
├── testUtils.ts                    # Shared utilities (waitForCondition, etc.)
└── constants.ts                    # Test constants and flags
```

### How It Works

1. **VS Code starts**: A new VS Code window (Extension Host) launches
2. **Extension loads**: Your extension activates in that window
3. **Tests run**: Mocha executes test files matching `*.smoke.test.ts`
4. **Results reported**: Pass/fail status shown in console

### Environment Detection

```typescript
import { IS_SMOKE_TEST } from './constants';

if (IS_SMOKE_TEST) {
    // Running as smoke test - use real APIs
} else {
    // Not a smoke test - might be unit test with mocks
}
```

### Adding a New Smoke Test

1. Create file: `src/test/smoke/[feature].smoke.test.ts`
2. Follow the naming convention: `*.smoke.test.ts`
3. Use the `suite()` and `test()` pattern:

```typescript
import * as assert from 'assert';
import * as vscode from 'vscode';
import { waitForCondition } from '../testUtils';

suite('Smoke: [Feature Name]', function () {
    this.timeout(60_000);  // 60 second timeout for the suite

    test('[Specific test]', async function () {
        // Arrange
        const extension = vscode.extensions.getExtension('ms-python.vscode-python-envs');
        
        // Act
        const result = await doSomething();
        
        // Assert
        assert.strictEqual(result, expected, 'Description of what went wrong');
    });
});
```

---

## Quick Reference

### Running Tests

| Method | Command |
|--------|---------|
| VS Code Debug | F5 with "Smoke Tests" selected |
| Command Line | `npm run smoke-test` |
| Single Test | Add `.only` to test: `test.only('...')` |

### Key Utilities

| Function | Purpose |
|----------|---------|
| `waitForCondition()` | Wait for async condition |
| `sleep()` | Delay (use sparingly) |
| `TestEventHandler` | Capture and assert events |

### Common Assertions

| Assert | Use For |
|--------|---------|
| `assert.ok(value, msg)` | Truthy check |
| `assert.strictEqual(a, b, msg)` | Exact equality |
| `assert.deepStrictEqual(a, b, msg)` | Object/array equality |
| `assert.fail(msg)` | Force failure |
| `assert.throws(() => fn)` | Exception expected |

### Timeouts

| Operation | Timeout |
|-----------|---------|
| Simple API call | 10s |
| Extension activation | 30s |
| Environment discovery | 60s |
| Full suite | 120s |

## CI Configuration

Smoke tests run automatically on every PR via GitHub Actions (`.github/workflows/pr-check.yml`).

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
    run: npm run smoke-test
```

**Test matrix:** Runs on `ubuntu-latest`, `windows-latest`, and `macos-latest` to catch platform-specific issues.

**Requirements:**
- `.vscode-test/user-data/User/settings.json` with `"python.useEnvironmentsExtension": true`
- First run downloads VS Code (~100MB, cached)
- Tests auto-retry once on failure (configured in `.vscode-test.mjs`)
