---
name: run-pre-commit-checks
description: Run the mandatory pre-commit checks before committing code. Includes lint, type checking, and unit tests. MUST be run before every commit.
argument-hint: '--fix to auto-fix lint issues'
---

# Run Pre-Commit Checks

This skill defines the mandatory checks that must pass before any commit.

## When to Use

- **ALWAYS** before committing code changes
- After fixing reviewer or Copilot review comments
- Before pushing changes
- When the maintainer agent requests pre-commit validation

## Required Checks

All three checks must pass before committing:

### 1. Lint Check (Required)

```powershell
npm run lint
```

**What it checks:**

- ESLint rules defined in `eslint.config.mjs`
- TypeScript-specific linting rules
- Import ordering and unused imports
- Code style consistency

**To auto-fix issues:**

```powershell
npm run lint -- --fix
```

### 2. Type Check (Required)

```powershell
npm run compile-tests
```

**What it checks:**

- TypeScript type errors
- Missing imports
- Type mismatches
- Strict null checks

**Output location:** `out/` directory (not used for production)

### 3. Unit Tests (Required)

```powershell
npm run unittest
```

**What it checks:**

- All unit tests in `src/test/` pass
- Tests run with Mocha framework
- Uses configuration from `build/.mocha.unittests.json`

## Full Pre-Commit Workflow

```powershell
# Run all checks in sequence
npm run lint
npm run compile-tests
npm run unittest

# If all pass, commit
git add -A
git commit -m "feat: your change description (Fixes #N)"
```

## Common Failures and Fixes

### ESLint Errors

| Error                                | Fix                                                    |
| ------------------------------------ | ------------------------------------------------------ |
| `@typescript-eslint/no-unused-vars`  | Remove unused variable or prefix with `_`              |
| `import/order`                       | Run `npm run lint -- --fix`                            |
| `@typescript-eslint/no-explicit-any` | Add proper type annotation                             |
| `no-console`                         | Use `traceLog`/`traceVerbose` instead of `console.log` |

### Type Errors

| Error                                  | Fix                                     |
| -------------------------------------- | --------------------------------------- |
| `TS2339: Property does not exist`      | Check property name or add type guard   |
| `TS2345: Argument type not assignable` | Check function parameter types          |
| `TS2322: Type not assignable`          | Add type assertion or fix type mismatch |
| `TS18048: possibly undefined`          | Add null check or use optional chaining |

### Test Failures

1. Read the test failure message carefully
2. Check if you changed behavior that tests depend on
3. Update tests if behavior change is intentional
4. Fix code if behavior change is unintentional

## Integration with Review Process

The maintainer agent workflow requires:

```
Code Change → Reviewer Agent → Pre-Commit Checks → Commit
                    ↓
              Fix Issues → Re-run Reviewer → Pre-Commit Checks
```

**Never skip pre-commit checks.** They catch:

- Type errors that would break the extension
- Style inconsistencies
- Regressions in existing functionality

## Automation Note

These checks should also be run:

- By CI on every PR (automated)
- After addressing review comments (manual trigger)
- Before merging (automated by CI)

The hooks system can automate running lint after file edits (see `.github/hooks/`).
