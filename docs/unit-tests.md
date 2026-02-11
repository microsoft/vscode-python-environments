# Unit Tests Guide

Unit tests verify isolated logic using mocked VS Code APIs. They run fast and are discoverable in Test Explorer.

## When to Use Unit Tests

**Ask yourself:** "Does this isolated piece of logic work correctly?"

| Good for | Not good for |
|----------|--------------|
| Pure functions | Extension activation |
| Class methods in isolation | Real VS Code API behavior |
| Error handling paths | Multi-component workflows |
| Edge cases | File system operations |
| Fast iteration | Real Python environments |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    npm run unittest                                  │
│                           │                                          │
│                           ▼                                          │
│              ┌────────────────────────┐                             │
│              │   Mocha (direct)       │ ◄── Configured by           │
│              │   No VS Code needed    │     build/.mocha.unittests  │
│              └───────────┬────────────┘     .json                   │
│                          │                                           │
│           Loads unittests.ts first (via require)                     │
│                          │                                           │
│                          ▼                                           │
│              ┌────────────────────────┐                             │
│              │  unittests.ts          │                             │
│              │  ┌──────────────────┐  │                             │
│              │  │ Hijacks          │  │                             │
│              │  │ require('vscode')│  │                             │
│              │  │ to return mocks  │  │                             │
│              │  └──────────────────┘  │                             │
│              └───────────┬────────────┘                             │
│                          │                                           │
│                          ▼                                           │
│              ┌────────────────────────┐                             │
│              │  Your Test File        │                             │
│              │  ┌──────────────────┐  │                             │
│              │  │ import * as     │  │                             │
│              │  │ vscode from     │──┼──▶ Gets MOCKED vscode       │
│              │  │ 'vscode'        │  │                             │
│              │  └──────────────────┘  │                             │
│              │  ┌──────────────────┐  │                             │
│              │  │ import {myFunc} │  │                             │
│              │  │ from '../../src'│──┼──▶ Gets REAL code           │
│              │  └──────────────────┘  │                             │
│              └────────────────────────┘                             │
│                          │                                           │
│                          ▼                                           │
│              ✅ Test Explorer discovers tests                        │
│              ✅ Fast execution (milliseconds)                        │
│              ❌ Not testing real VS Code behavior                    │
└─────────────────────────────────────────────────────────────────────┘
```

## What's Real vs Mocked

| Component | Real or Mocked | Notes |
|-----------|----------------|-------|
| VS Code APIs | **Mocked** | Via `ts-mockito` in `unittests.ts` |
| Your extension code | **Real** | The code being tested |
| File system | **Real** | Node.js fs module |
| Python | **Not needed** | Tests don't spawn Python |
| Uri, Range, Position | **Mocked** | From `src/test/mocks/vsc/` |

### How Mocking Works

The `unittests.ts` file hijacks Node's `require()`:

```typescript
// When any code does: import * as vscode from 'vscode'
// It actually gets mockedVSCode object instead of real VS Code
Module._load = function (request: any, _parent: any) {
    if (request === 'vscode') {
        return mockedVSCode;  // Return mocks, not real vscode
    }
    return originalLoad.apply(this, arguments);
};
```

## How to Run

### 1. Test Explorer (Recommended)
✅ **Unit tests work in Test Explorer!**
1. Open Testing panel (beaker icon in sidebar)
2. Tests are auto-discovered
3. Click play button to run all or individual tests
4. Set breakpoints and debug directly

### 2. VS Code Debug
1. Open Debug panel (Cmd+Shift+D)
2. Select **"Unit Tests"** from dropdown
3. Press **F5**
4. Set breakpoints in test or source code

### 3. Command Line
```bash
npm run compile-tests && npm run unittest
```

### 4. Run Specific Test
```bash
npm run unittest -- --grep "normalizePath"
```

Or add `.only` in code:
```typescript
test.only('handles empty path', () => { ... });
```

## File Structure

```
src/test/
├── unittests.ts              # Mock VS Code setup (loaded first)
│                             # - Hijacks require('vscode')
│                             # - Sets up ts-mockito mocks
│
├── mocks/                    # Mock implementations
│   ├── vsc/                  # VS Code type mocks
│   │   └── extHostedTypes.ts # Uri, Range, Position, etc.
│   ├── mockChildProcess.ts   # For testing process execution
│   └── mockWorkspaceConfig.ts
│
├── common/                   # Unit tests for src/common/
│   └── *.unit.test.ts
├── features/                 # Unit tests for src/features/
│   └── *.unit.test.ts
└── managers/                 # Unit tests for src/managers/
    └── *.unit.test.ts
```

### Naming Convention
- Files: `*.unit.test.ts`
- Suites: `suite('[Module/Class Name]', ...)`
- Tests: Describe the behavior being verified

## Test Template

```typescript
import assert from 'node:assert';
import * as sinon from 'sinon';
import { Uri } from 'vscode';  // Gets MOCKED vscode
import { myFunction } from '../../src/myModule';  // Gets REAL code

suite('MyModule', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test('handles normal input', () => {
        const result = myFunction('input');
        assert.strictEqual(result, 'expected');
    });

    test('handles edge case', () => {
        const result = myFunction('');
        assert.strictEqual(result, undefined);
    });

    test('throws on invalid input', () => {
        assert.throws(() => myFunction(null), /error message/);
    });
});
```

## Mocking Patterns

### Stub a function with sinon
```typescript
const stub = sandbox.stub(myModule, 'myFunction').returns('mocked');
// ... test code ...
assert.ok(stub.calledOnce);
```

### Mock VS Code workspace config
```typescript
import { mockedVSCodeNamespaces } from '../unittests';
import { when } from 'ts-mockito';

when(mockedVSCodeNamespaces.workspace!.getConfiguration('python'))
    .thenReturn({ get: () => 'value' } as any);
```

### Platform-specific tests
```typescript
test('handles Windows paths', function () {
    if (process.platform !== 'win32') {
        this.skip();  // Skip on non-Windows
    }
    // Windows-specific test
});
```

## Debugging Failures

| Error | Likely Cause | Fix |
|-------|--------------|-----|
| `Cannot find module 'vscode'` | unittests.ts not loaded | Check mocha config `require` |
| `undefined is not a function` | Mock not set up | Add mock in unittests.ts or use sinon stub |
| `Timeout` | Test is actually async | Add `async` and `await` |
| Test passes but shouldn't | Mocked behavior differs from real | Consider smoke/integration test instead |

## Learnings

- **Mocks aren't reality**: Unit tests pass but real behavior may differ — use smoke/e2e tests for real VS Code behavior (1)
- **sinon sandbox**: Always use `sandbox.restore()` in teardown to prevent test pollution (1)
- **Platform skips**: Use `this.skip()` in test body, not `test.skip()`, to get runtime platform check (1)

**Speed:** Seconds (no VS Code download needed)
