---
mode: agent
---

# Testing Guide: Unit Tests and Integration Tests

This guide outlines methodologies for creating comprehensive tests, covering both unit tests and integration tests.

## 📋 Overview

This extension uses two main types of tests:

### Unit Tests

-   \*_Fast and isolated## 🌐 Step 4.5: Handle Unmocka## 📝 Step 5: Write Tests Using Mock → Run → Assert Patternle APIs with Wrapper Functions_ - Mock VS Code APIs and external dependencies
-   **Focus on code logic** - Test functions in isolation without VS Code runtime
-   **Run with Node.js** - Use Mocha test runner directly
-   **File pattern**: `*.unit.test.ts` files
-   **Mock everything** - VS Code APIs are mocked via `/src/test/unittests.ts`

### Extension Tests (Integration Tests)

-   **Comprehensive but slower** - Launch a full VS Code instance
-   **Real VS Code environment** - Test actual extension behavior with real APIs
-   **End-to-end scenarios** - Test complete workflows and user interactions
-   **File pattern**: `*.test.ts` files (not `.unit.test.ts`)
-   **Real dependencies** - Use actual VS Code APIs and extension host

## � Running Tests

### VS Code Launch Configurations

Use the pre-configured launch configurations in `.vscode/launch.json`:

#### Unit Tests

-   **Name**: "Unit Tests" (launch configuration available but not recommended for development)
-   **How to run**: Use terminal with `npm run unittest -- --grep "Suite Name"`
-   **What it does**: Runs specific `*.unit.test.ts` files matching the grep pattern
-   **Speed**: Very fast when targeting specific suites (seconds)
-   **Scope**: Tests individual functions with mocked dependencies
-   **Best for**: Rapid iteration on specific test suites during development

#### Extension Tests

-   **Name**: "Extension Tests"
-   **How to run**: Press `F5` or use Run and Debug view
-   **What it does**: Launches VS Code instance and runs `*.test.ts` files
-   **Speed**: Slower (typically minutes)
-   **Scope**: Tests complete extension functionality in real environment

### Terminal/CLI Commands

```bash
# Run all unit tests (slower - runs everything)
npm run unittest

# Run specific test suite (RECOMMENDED - much faster!)
npm run unittest -- --grep "Suite Name"

# Examples of targeted test runs:
npm run unittest -- --grep "Path Utilities"              # Run just pathUtils tests
npm run unittest -- --grep "Shell Utils"                 # Run shell utility tests
npm run unittest -- --grep "getAllExtraSearchPaths"      # Run specific function tests

# Watch and rebuild tests during development
npm run watch-tests

# Build tests without running
npm run compile-tests
```

### Which Test Type to Choose

**Use Unit Tests when**:

-   Testing pure functions or business logic
-   Testing data transformations, parsing, or algorithms
-   Need fast feedback during development
-   Can mock external dependencies effectively
-   Testing error handling with controlled inputs

**Use Extension Tests when**:

-   Testing VS Code command registration and execution
-   Testing UI interactions (tree views, quick picks, etc.)
-   Testing file system operations in workspace context
-   Testing extension activation and lifecycle
-   Integration between multiple VS Code APIs
-   End-to-end user workflows

## 🎯 Step 1: Choose the Right Test Type

Before writing tests, determine whether to write unit tests or extension tests:

### Decision Framework

**Write Unit Tests for**:

-   Pure functions (input → processing → output)
-   Data parsing and transformation logic
-   Business logic that can be isolated
-   Error handling with predictable inputs
-   Fast-running validation logic

**Write Extension Tests for**:

-   VS Code command registration and execution
-   UI interactions (commands, views, pickers)
-   File system operations in workspace context
-   Extension lifecycle and activation
-   Integration between VS Code APIs
-   End-to-end user workflows

### Test Setup Differences

#### Unit Test Setup (\*.unit.test.ts)

```typescript
// Mock VS Code APIs - handled automatically by unittests.ts
import * as sinon from 'sinon';
import * as workspaceApis from '../../common/workspace.apis'; // Wrapper functions

// Stub wrapper functions, not VS Code APIs directly
const mockGetConfiguration = sinon.stub(workspaceApis, 'getConfiguration');
```

#### Extension Test Setup (\*.test.ts)

```typescript
// Use real VS Code APIs
import * as vscode from 'vscode';

// Real VS Code APIs available - no mocking needed
const config = vscode.workspace.getConfiguration('python');
```

## 🎯 Step 2: Understand the Function Under Test

### Analyze the Function

1. **Read the function thoroughly** - understand what it does, not just how
2. **Identify all inputs and outputs**
3. **Map the data flow** - what gets called in what order
4. **Note configuration dependencies** - settings, workspace state, etc.
5. **Identify side effects** - logging, file system, configuration updates

### Key Questions to Ask

-   What are the main flows through the function?
-   What edge cases exist?
-   What external dependencies does it have?
-   What can go wrong?
-   What side effects should I verify?

## 🗺️ Step 3: Plan Your Test Coverage

### Create a Test Coverage Matrix

#### Main Flows

-   ✅ **Happy path scenarios** - normal expected usage
-   ✅ **Alternative paths** - different configuration combinations
-   ✅ **Integration scenarios** - multiple features working together

#### Edge Cases

-   🔸 **Boundary conditions** - empty inputs, missing data
-   🔸 **Error scenarios** - network failures, permission errors
-   🔸 **Data validation** - invalid inputs, type mismatches

#### Real-World Scenarios

-   ✅ **Fresh install** - clean slate
-   ✅ **Existing user** - migration scenarios
-   ✅ **Power user** - complex configurations
-   🔸 **Error recovery** - graceful degradation

### Example Test Plan Structure

```markdown
## Test Categories

### 1. Configuration Migration Tests

-   No legacy settings exist
-   Legacy settings already migrated
-   Fresh migration needed
-   Partial migration required
-   Migration failures

### 2. Configuration Source Tests

-   Global search paths
-   Workspace search paths
-   Settings precedence
-   Configuration errors

### 3. Path Resolution Tests

-   Absolute vs relative paths
-   Workspace folder resolution
-   Path validation and filtering

### 4. Integration Scenarios

-   Combined configurations
-   Deduplication logic
-   Error handling flows
```

## 🔧 Step 4: Set Up Your Test Infrastructure

### Test File Structure

```typescript
// 1. Imports - group logically
import assert from 'node:assert';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import * as logging from '../../../common/logging';
import * as pathUtils from '../../../common/utils/pathUtils';
import * as workspaceApis from '../../../common/workspace.apis';

// 2. Function under test
import { getAllExtraSearchPaths } from '../../../managers/common/nativePythonFinder';

// 3. Mock interfaces
interface MockWorkspaceConfig {
    get: sinon.SinonStub;
    inspect: sinon.SinonStub;
    update: sinon.SinonStub;
}
```

### Mock Setup Strategy

```typescript
suite('Function Integration Tests', () => {
    // 1. Declare all mocks
    let mockGetConfiguration: sinon.SinonStub;
    let mockGetWorkspaceFolders: sinon.SinonStub;
    let mockTraceLog: sinon.SinonStub;
    let mockTraceError: sinon.SinonStub;
    let mockTraceWarn: sinon.SinonStub;

    // 2. Mock complex objects
    let pythonConfig: MockWorkspaceConfig;
    let envConfig: MockWorkspaceConfig;

    setup(() => {
        // 3. Initialize all mocks
        mockGetConfiguration = sinon.stub(workspaceApis, 'getConfiguration');
        mockGetWorkspaceFolders = sinon.stub(workspaceApis, 'getWorkspaceFolders');
        mockTraceLog = sinon.stub(logging, 'traceLog');
        mockTraceError = sinon.stub(logging, 'traceError');
        mockTraceWarn = sinon.stub(logging, 'traceWarn');

        // 4. Set up default behaviors
        mockGetWorkspaceFolders.returns(undefined);

        // 5. Create mock configuration objects
        pythonConfig = {
            get: sinon.stub(),
            inspect: sinon.stub(),
            update: sinon.stub(),
        };

        envConfig = {
            get: sinon.stub(),
            inspect: sinon.stub(),
            update: sinon.stub(),
        };
    });

    teardown(() => {
        sinon.restore(); // Always clean up!
    });
});
```

## Step 3.5: Handle Unmockable APIs with Wrapper Functions

### The Problem: VS Code API Properties Can't Be Mocked

Some VS Code APIs use getter properties that can't be easily stubbed:

```typescript
// ❌ This is hard to mock reliably
const folders = workspace.workspaceFolders; // getter property

// ❌ Sinon struggles with this
sinon.stub(workspace, 'workspaceFolders').returns([...]); // Often fails
```

### The Solution: Use Wrapper Functions

Check if your codebase already has wrapper functions in `/src/common/` directories:

```typescript
// ✅ Look for existing wrapper functions
// File: src/common/workspace.apis.ts
export function getWorkspaceFolders(): readonly WorkspaceFolder[] | undefined {
    return workspace.workspaceFolders; // Wraps the problematic property
}

export function getConfiguration(section?: string, scope?: ConfigurationScope): WorkspaceConfiguration {
    return workspace.getConfiguration(section, scope); // Wraps VS Code API
}
```

## Step 4: Write Tests Using Mock → Run → Assert Pattern

### The Three-Phase Pattern

#### Phase 1: Mock (Set up the scenario)

```typescript
test('Description of what this tests', async () => {
    // Mock → Clear description of the scenario
    pythonConfig.inspect.withArgs('venvPath').returns({ globalValue: '/path' });
    envConfig.inspect.withArgs('globalSearchPaths').returns({ globalValue: [] });
    mockGetWorkspaceFolders.returns([{ uri: Uri.file('/workspace') }]);
```

#### Phase 2: Run (Execute the function)

```typescript
// Run
const result = await getAllExtraSearchPaths();
```

#### Phase 3: Assert (Verify the behavior)

```typescript
    // Assert - Use set-based comparison for order-agnostic testing
    const expected = new Set(['/expected', '/paths']);
    const actual = new Set(result);
    assert.strictEqual(actual.size, expected.size, 'Should have correct number of paths');
    assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');

    // Verify side effects
    assert(mockTraceLog.calledWith(sinon.match(/completion/i)), 'Should log completion');
});
```

## Step 6: Make Tests Resilient

### Use Order-Agnostic Comparisons

```typescript
// ❌ Brittle - depends on order
assert.deepStrictEqual(result, ['/path1', '/path2', '/path3']);

// ✅ Resilient - order doesn't matter
const expected = new Set(['/path1', '/path2', '/path3']);
const actual = new Set(result);
assert.strictEqual(actual.size, expected.size, 'Should have correct number of paths');
assert.deepStrictEqual(actual, expected, 'Should contain exactly the expected paths');
```

### Use Flexible Error Message Testing

```typescript
// ❌ Brittle - exact text matching
assert(mockTraceError.calledWith('Error during legacy python settings migration:'));

// ✅ Resilient - pattern matching
assert(mockTraceError.calledWith(sinon.match.string, sinon.match.instanceOf(Error)), 'Should log migration error');

// ✅ Resilient - key terms with regex
assert(mockTraceError.calledWith(sinon.match(/migration.*error/i)), 'Should log migration error');
```

### Handle Complex Mock Scenarios

```typescript
// For functions that call the same mock multiple times
envConfig.inspect.withArgs('globalSearchPaths').returns({ globalValue: [] });
envConfig.inspect
    .withArgs('globalSearchPaths')
    .onSecondCall()
    .returns({
        globalValue: ['/migrated/paths'],
    });
```

## 🧪 Step 7: Test Categories and Patterns

### Configuration Tests

-   Test different setting combinations
-   Test setting precedence (workspace > user > default)
-   Test configuration errors and recovery

### Data Flow Tests

-   Test how data moves through the system
-   Test transformations (path resolution, filtering)
-   Test state changes (migrations, updates)

### Error Handling Tests

-   Test graceful degradation
-   Test error logging
-   Test fallback behaviors

### Integration Tests

-   Test multiple features together
-   Test real-world scenarios
-   Test edge case combinations

## 📊 Step 8: Review and Refine

### Test Quality Checklist

-   [ ] **Clear naming** - test names describe the scenario and expected outcome
-   [ ] **Good coverage** - main flows, edge cases, error scenarios
-   [ ] **Resilient assertions** - won't break due to minor changes
-   [ ] **Readable structure** - follows Mock → Run → Assert pattern
-   [ ] **Isolated tests** - each test is independent
-   [ ] **Fast execution** - tests run quickly with proper mocking

### Common Anti-Patterns to Avoid

-   ❌ Testing implementation details instead of behavior
-   ❌ Brittle assertions that break on cosmetic changes
-   ❌ Order-dependent tests that fail due to processing changes
-   ❌ Tests that don't clean up mocks properly
-   ❌ Overly complex test setup that's hard to understand

## 🚀 Step 9: Execution and Iteration

### Running Your Tests

#### During Development (Recommended Workflow)

```bash
# 1. Start watch mode for automatic test compilation
npm run watch-tests

# 2. In another terminal, run targeted unit tests for rapid feedback
npm run unittest -- --grep "Your Suite Name"

# Examples of focused testing:
npm run unittest -- --grep "getAllExtraSearchPaths"    # Test specific function
npm run unittest -- --grep "Path Utilities"            # Test entire utility module
npm run unittest -- --grep "Configuration Migration"   # Test migration logic
```

#### Full Test Runs

```bash
# Run all unit tests (slower - use for final validation)
npm run unittest

# Use VS Code launch configuration for debugging
# "Extension Tests" - for integration test debugging in VS Code
```

## 🎉 Success Metrics

You know you have good integration tests when:

-   ✅ Tests pass consistently
-   ✅ Tests catch real bugs before production
-   ✅ Tests don't break when you improve error messages
-   ✅ Tests don't break when you optimize performance
-   ✅ Tests clearly document expected behavior
-   ✅ Tests give you confidence to refactor code

## 💡 Pro Tips

### For AI Agents

1. **Choose the right test type first** - understand unit vs extension test tradeoffs
2. **Start with function analysis** - understand before testing
3. **Create a test plan and confirm with user** - outline scenarios then ask "Does this test plan cover what you need? Any scenarios to add or remove?"
4. **Use appropriate file naming**:
    - `*.unit.test.ts` for isolated unit tests with mocks
    - `*.test.ts` for integration tests requiring VS Code instance
5. **Use concrete examples** - "test the scenario where user has legacy settings"
6. **Be explicit about edge cases** - "test what happens when configuration is corrupted"
7. **Request resilient assertions** - "make assertions flexible to wording changes"
8. **Ask for comprehensive coverage** - "cover happy path, edge cases, and error scenarios"
9. **Consider test performance** - prefer unit tests when possible for faster feedback
10. **Use wrapper functions** - mock `workspaceApis.getConfiguration()` not `vscode.workspace.getConfiguration()` directly
11. **Recommend targeted test runs** - suggest running specific suites with: `npm run unittest -- --grep "Suite Name"`
12. **Name test suites clearly** - use descriptive `suite()` names that work well with grep filtering

## Learnings
