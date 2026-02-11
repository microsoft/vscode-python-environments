# Test Types Comparison

This guide helps you choose the right test type for your situation.

## Quick Decision Matrix

| Question | Unit | Smoke | E2E | Integration |
|----------|------|-------|-----|-------------|
| **"Does my logic work?"** | ✅ Best | ❌ | ❌ | ❌ |
| **"Does the extension load?"** | ❌ | ✅ Best | ✅ | ✅ |
| **"Does the full workflow work?"** | ❌ | ❌ | ✅ Best | ❌ |
| **"Do components sync correctly?"** | ❌ | ❌ | ❌ | ✅ Best |
| **Needs real VS Code?** | ❌ No | ✅ Yes | ✅ Yes | ✅ Yes |
| **Needs Python installed?** | ❌ No | ✅ Yes | ✅ Yes | ✅ Yes |

## Comparison Table

| Aspect | Unit Tests | Smoke Tests | E2E Tests | Integration Tests |
|--------|------------|-------------|-----------|-------------------|
| **Purpose** | Test isolated logic | Verify extension loads | Test complete workflows | Test component interactions |
| **VS Code** | Mocked | Real | Real | Real |
| **APIs** | Mocked | Real | Real | Real |
| **Speed** | Fast (ms) | Medium (10-30s) | Slow (1-3min) | Medium (30s-2min) |
| **Test Explorer** | ✅ Yes | ❌ No | ❌ No | ❌ No |
| **Debugging** | Easy | Moderate | Hard | Moderate |
| **Flakiness** | Low | Medium | High | Medium |
| **CI Time** | Seconds | ~1 min | ~3 min | ~2 min |
| **Copilot Skill** | N/A | `run-smoke-tests` | `run-e2e-tests` | `run-integration-tests` |

## Running Tests

| Test Type | Copilot Skill | Command Line |
|-----------|---------------|--------------|
| Unit | N/A | `npm run unittest` |
| Smoke | "run smoke tests" | `npm run smoke-test` |
| E2E | "run e2e tests" | `npm run e2e-test` |
| Integration | "run integration tests" | `npm run integration-test` |

Skills are located in `.github/skills/` and provide guided instructions for agents.

## When to Use Each

### Unit Tests
**Use when testing:**
- Pure functions (string manipulation, data transformation)
- Class logic in isolation
- Error handling paths
- Edge cases

**Example scenarios:**
- Path normalization logic
- Configuration parsing
- Manager selection algorithms

### Smoke Tests  
**Use when testing:**
- Extension activates without errors
- Commands are registered
- API is exported
- Basic features are accessible

**Example scenarios:**
- After changing `extension.ts`
- After modifying `package.json` commands
- Before submitting any PR (quick sanity check)

### E2E Tests
**Use when testing:**
- Complete user workflows
- Multi-step operations
- Features that depend on real Python

**Example scenarios:**
- Create environment → install packages → run code
- Discover environments → select interpreter → verify terminal activation
- Multi-root workspace with different environments per folder

### Integration Tests
**Use when testing:**
- Multiple components working together
- Event propagation between components
- State synchronization
- API reflects internal state

**Example scenarios:**
- Manager refreshes → API returns updated environments
- Setting changes → UI updates
- Event fires → all listeners respond correctly

## Test Runner Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Test Execution                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  UNIT TESTS                    SMOKE/E2E/INTEGRATION TESTS           │
│  ───────────                   ─────────────────────────             │
│                                                                      │
│  ┌─────────────┐               ┌──────────────────────────┐         │
│  │   Mocha     │               │   @vscode/test-cli       │         │
│  │  (direct)   │               │   (launches VS Code)     │         │
│  └──────┬──────┘               └───────────┬──────────────┘         │
│         │                                  │                         │
│         ▼                                  ▼                         │
│  ┌─────────────┐               ┌──────────────────────────┐         │
│  │   Mocked    │               │   Real VS Code Instance   │         │
│  │   VS Code   │               │   with Extension Loaded  │         │
│  │   APIs      │               └───────────┬──────────────┘         │
│  └──────┬──────┘                           │                         │
│         │                                  ▼                         │
│         ▼                      ┌──────────────────────────┐         │
│  ┌─────────────┐               │   Mocha runs inside       │         │
│  │  Your Code  │               │   VS Code Extension Host  │         │
│  │  (tested)   │               └──────────────────────────┘         │
│  └─────────────┘                                                    │
│                                                                      │
│  ✅ Test Explorer               ❌ Test Explorer                     │
│  ✅ Fast                        ✅ Real behavior                     │
│  ❌ Not real behavior           ❌ Slower                            │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## File Organization

```
src/test/
├── unittests.ts              # Mock VS Code setup for unit tests
├── testUtils.ts              # Shared utilities (waitForCondition, etc.)
├── constants.ts              # Test constants and type detection
├── common/                   # Unit tests
│   └── *.test.ts
├── features/                 # Unit tests  
│   └── *.test.ts
├── managers/                 # Unit tests
│   └── *.test.ts
├── smoke/                    # Smoke tests (real VS Code)
│   ├── index.ts              # Runner entry point
│   └── *.smoke.test.ts
├── e2e/                      # E2E tests (real VS Code)
│   ├── index.ts              # Runner entry point
│   └── *.e2e.test.ts
└── integration/              # Integration tests (real VS Code)
    ├── index.ts              # Runner entry point
    └── *.integration.test.ts
```

## See Also

- [Unit Tests Guide](./unit-tests.md)
- [Smoke Tests Guide](./smoke-tests.md)
- [E2E Tests Guide](./e2e-tests.md)
- [Integration Tests Guide](./integration-tests.md)
