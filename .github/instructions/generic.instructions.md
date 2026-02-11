---
applyTo: '**'
---

Provide project context and coding guidelines that AI should follow when generating code, answering questions, or reviewing changes.# Coding Instructions for vscode-python-environments

## Localization

- Localize all user-facing messages using VS Code’s `l10n` API.
- Internal log messages do not require localization.

## Logging

- Use the extension’s logging utilities (`traceLog`, `traceVerbose`) for internal logs.
- Do not use `console.log` or `console.warn` for logging.

## Settings Precedence

- Always consider VS Code settings precedence:
    1. Workspace folder
    2. Workspace
    3. User/global
- Remove or update settings from the highest precedence scope first.

## Error Handling & User Notifications

- Avoid showing the same error message multiple times in a session; track state with a module-level variable.
- Use clear, actionable error messages and offer relevant buttons (e.g., "Open settings", "Close").

## Documentation

- Add clear docstrings to public functions, describing their purpose, parameters, and behavior.

## Cross-Platform Path Handling

**CRITICAL**: This extension runs on Windows, macOS, and Linux. NEVER hardcode POSIX-style paths.

- Use `path.join()` or `path.resolve()` instead of string concatenation with `/`
- Use `Uri.file(path).fsPath` when comparing paths (Windows uses `\`, POSIX uses `/`)
- When asserting path equality, compare `fsPath` to `fsPath`, not raw strings

## Learnings

- When using `getConfiguration().inspect()`, always pass a scope/Uri to `getConfiguration(section, scope)` — otherwise `workspaceFolderValue` will be `undefined` because VS Code doesn't know which folder to inspect (1)
- **path.normalize() vs path.resolve()**: On Windows, `path.normalize('\test')` keeps it as `\test`, but `path.resolve('\test')` adds the current drive → `C:\test`. When comparing paths, use `path.resolve()` on BOTH sides or they won't match (2)
- **Path comparisons vs user display**: Use `normalizePath()` from `pathUtils.ts` when comparing paths or using them as map keys, but preserve original paths for user-facing output like settings, logs, and UI (1)
- **CI test jobs need webpack build**: Smoke/E2E/integration tests run in a real VS Code instance against `dist/extension.js` (built by webpack). CI jobs must run `npm run compile` (webpack), not just `npm run compile-tests` (tsc). Without webpack, the extension code isn't built and tests run against stale/missing code (1)
- **Use inspect() for setting checks with defaults from other extensions**: When checking `python.useEnvironmentsExtension`, use `config.inspect()` and only check explicit user values (`globalValue`, `workspaceValue`, `workspaceFolderValue`). Ignore `defaultValue` as it may come from other extensions' package.json even when not installed (1)
- **API is flat, not nested**: Use `api.getEnvironments()`, NOT `api.environments.getEnvironments()`. The extension exports a flat API object (1)
- **PythonEnvironment has `envId`, not `id`**: The environment identifier is `env.envId` (a `PythonEnvironmentId` object with `id` and `managerId`), not a direct `id` property (1)
