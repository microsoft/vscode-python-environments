# Search Paths and Glob Patterns

This guide explains how to configure where the Python Environments extension searches for Python environments using search paths and glob patterns. By the end, you'll understand how to effectively customize environment discovery to match your development workflow.

## Overview

By default, the Python Environments extension automatically discovers environments in well-known locations like the workspace folders, common virtual environment directories, and system Python installations. However, you can customize where the extension searches using two settings:

- **`python-envs.globalSearchPaths`**: Global search paths applied to all workspaces
- **`python-envs.workspaceSearchPaths`**: Search paths specific to the current workspace

Both settings support **glob patterns**, which allow you to specify flexible search patterns that match multiple directories.

## When to Use Custom Search Paths

Consider configuring custom search paths when:

| Scenario                        | Example                                                        |
| ------------------------------- | -------------------------------------------------------------- |
| Centralized environment storage | All environments stored in `~/python-envs/`                    |
| Mono-repo structure             | Multiple projects with nested `.venv` folders                  |
| Non-standard locations          | Environments in `/opt/`, network drives, or custom directories |
| Team conventions                | Standardized environment naming patterns                       |
| Testing scenarios               | Temporary environments in test directories                     |

## Configuring Search Paths

### Global search paths

Global search paths apply across all your VS Code workspaces. Use these for environment locations that are consistent across projects.

1. Open Settings (`Cmd+,` on macOS, `Ctrl+,` on Windows/Linux).
2. Search for `python-envs.globalSearchPaths`.
3. Click **Add Item** to add a new path.
4. Enter an absolute path or glob pattern.

Example configuration:

```json
{
    "python-envs.globalSearchPaths": [
        "/Users/username/python-envs",
        "/Users/username/projects/*/venv",
        "/opt/python-environments/**"
    ]
}
```

### Workspace search paths

Workspace search paths apply only to the current workspace. Use these for project-specific environment locations.

1. Open Settings (`Cmd+,` on macOS, `Ctrl+,` on Windows/Linux).
2. Switch to **Workspace** scope (not User).
3. Search for `python-envs.workspaceSearchPaths`.
4. Click **Add Item** to add a new path.
5. Enter a relative path (from workspace root) or absolute path.

Example configuration:

```json
{
    "python-envs.workspaceSearchPaths": [".venv", "tests/**/.venv", "services/*/env"]
}
```

> **Note**: Relative paths in `workspaceSearchPaths` are resolved from the workspace root directory.

## Glob Pattern Syntax

Glob patterns provide a flexible way to match multiple directories using wildcards. The extension supports standard glob syntax:

### Basic wildcards

| Pattern | Matches                                                   | Example                                                            |
| ------- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| `*`     | Any sequence of characters within a single path component | `envs/*` matches `envs/project1` but not `envs/nested/project2`    |
| `**`    | Any sequence of path components (recursive)               | `projects/**/.venv` matches `.venv` at any depth under `projects/` |
| `?`     | Any single character                                      | `project?` matches `project1`, `projectA`                          |
| `[...]` | Any character inside the brackets                         | `project[0-9]` matches `project0` through `project9`               |

### Pattern examples

```json
{
    "python-envs.globalSearchPaths": [
        // Specific directory (no wildcard needed)
        "/Users/username/main-env",

        // All direct subdirectories of envs/
        "/Users/username/envs/*",

        // All .venv directories at any depth
        "/Users/username/projects/**/.venv",

        // All venv directories at any depth
        "/Users/username/projects/**/venv",

        // Numbered project directories
        "/Users/username/project[0-9]",

        // Multiple levels with wildcards
        "/Users/username/clients/*/projects/*/env"
    ]
}
```

## How Glob Expansion Works

When you specify a glob pattern, the extension:

1. **Expands the pattern** to find all matching directories
2. **Filters to directories only** (files are ignored unless they're Python executables)
3. **Searches each directory** recursively for Python environments

### Example expansion

Given the pattern `/Users/username/projects/**/.venv`:

```
projects/
├── backend/
│   └── .venv/          ← Matches
├── frontend/
│   └── scripts/
│       └── .venv/      ← Matches
└── ml-pipeline/
    ├── training/
    │   └── .venv/      ← Matches
    └── inference/
        └── .venv/      ← Matches
```

All four `.venv` directories are added to the search paths.

## Performance Considerations

⚠️ **Important**: Glob patterns can significantly impact discovery performance if used incorrectly.

### What to avoid

| Pattern              | Problem                        | Impact                     |
| -------------------- | ------------------------------ | -------------------------- |
| `/**`                | Searches the entire filesystem | Very slow, may time out    |
| `/Users/username/**` | Searches all user files        | Extremely slow             |
| `path/to/project/**` | Lists every subdirectory       | Redundant, slows discovery |

### Best practices

✅ **DO**: Use specific patterns

```json
{
    "python-envs.workspaceSearchPaths": [
        ".venv", // Root-level .venv
        "tests/**/.venv", // .venv directories under tests/
        "services/*/env" // env directories one level under services/
    ]
}
```

❌ **DON'T**: Use overly broad patterns

```json
{
    "python-envs.workspaceSearchPaths": [
        "**", // Every directory! Very slow
        "/Users/username/**" // Entire home directory! Extremely slow
    ]
}
```

### Understanding `**` vs. no pattern

| Configuration           | Behavior                                                                       |
| ----------------------- | ------------------------------------------------------------------------------ |
| `"/path/to/project"`    | ✅ Extension searches this directory recursively for environments              |
| `"/path/to/project/**"` | ⚠️ Extension treats EVERY subdirectory as a separate search path (inefficient) |

> **Tip**: In most cases, you don't need `**` alone. Just specify the root directory and let the extension search recursively.

## Common Use Cases

### Find all .venv directories in a mono-repo

```json
{
    "python-envs.workspaceSearchPaths": ["**/.venv"]
}
```

This finds `.venv` directories at any depth without treating every subdirectory as a search path.

### Centralized environment storage

```json
{
    "python-envs.globalSearchPaths": ["/Users/username/python-environments/*"]
}
```

This searches all direct subdirectories of your centralized environment folder.

### Team convention: environments named "env" or "venv"

```json
{
    "python-envs.workspaceSearchPaths": ["**/env", "**/venv"]
}
```

### Multiple project structures

```json
{
    "python-envs.workspaceSearchPaths": [
        ".venv", // Root workspace environment
        "backend/.venv", // Backend service environment
        "services/*/venv", // Service-specific environments
        "tests/**/test-env" // Test environments at any depth
    ]
}
```

### Development and testing environments

```json
{
    "python-envs.globalSearchPaths": ["/opt/python/dev/*", "/opt/python/test/*", "/Users/username/temp/envs/*"]
}
```

## Integration with Legacy Settings

The extension merges custom search paths with legacy Python extension settings for backward compatibility.

### Settings that are merged

| Legacy Setting       | Equivalent Modern Setting                   |
| -------------------- | ------------------------------------------- |
| `python.venvPath`    | Merged into `python-envs.globalSearchPaths` |
| `python.venvFolders` | Merged into `python-envs.globalSearchPaths` |

If you have both configured, the extension combines all paths into one search list.

### Migration example

**Before** (legacy Python extension):

```json
{
    "python.venvPath": "/Users/username/envs",
    "python.venvFolders": ["venv", ".venv"]
}
```

**After** (modern Python Environments):

```json
{
    "python-envs.globalSearchPaths": ["/Users/username/envs/*", "**/venv", "**/.venv"]
}
```

> **Note**: You can continue using legacy settings, but migrating to `python-envs.globalSearchPaths` provides more flexibility with glob patterns.

## Troubleshooting

### Environments not appearing

If your environments aren't discovered:

1. **Verify paths are absolute** (for global search paths) or relative to workspace root (for workspace search paths)
2. **Check path separators**: Use `/` even on Windows
3. **Test without glob patterns first**: Start with a simple directory path, then add patterns
4. **Check extension logs**: Open **Output** panel and select **Python Environments** to see discovery logs
5. **Verify directory exists**: Glob patterns that match nothing are silently ignored

### Slow environment discovery

If discovery is taking too long:

1. **Review glob patterns**: Look for overly broad patterns like `**` or `/Users/**`
2. **Be more specific**: Replace `projects/**` with `projects/**/.venv` to target specific directories
3. **Reduce search paths**: Remove paths that don't contain environments
4. **Use root directories**: Instead of `path/**`, use `path` and let the extension search recursively

### Duplicate environments

If environments appear multiple times:

1. **Check for overlapping paths**: Ensure patterns don't match the same directories
2. **Remove redundant patterns**: If you specify both `projects/` and `projects/**/.venv`, the latter is sufficient
3. **Review workspace vs. global settings**: Ensure you're not duplicating paths across scopes

## Quick Reference: Settings

| Setting                            | Scope             | Description                                                                |
| ---------------------------------- | ----------------- | -------------------------------------------------------------------------- |
| `python-envs.globalSearchPaths`    | User or Workspace | Array of absolute paths or glob patterns searched across all workspaces    |
| `python-envs.workspaceSearchPaths` | Workspace         | Array of relative or absolute paths searched in the current workspace only |
| `python.venvPath`                  | User or Workspace | Legacy setting merged into global search paths                             |
| `python.venvFolders`               | User or Workspace | Legacy setting merged into global search paths                             |

## Pattern Reference

### Quick pattern guide

```json
{
    "python-envs.globalSearchPaths": [
        "/absolute/path", // Specific directory
        "/parent/*", // Direct children only
        "/parent/**/target", // Target directories at any depth
        "/parent/child[0-9]", // Numbered children
        "/parent/child?", // Single character wildcard
        "/parent/{option1,option2}/env" // Alternative branches (if supported)
    ]
}
```

### Platform-specific examples

**macOS/Linux**:

```json
{
    "python-envs.globalSearchPaths": [
        "/opt/python-envs/*",
        "~/.local/share/virtualenvs/*",
        "/usr/local/python-environments/*"
    ]
}
```

**Windows**:

```json
{
    "python-envs.globalSearchPaths": [
        "C:/Python/Environments/*",
        "C:/Users/username/python-envs/*",
        "D:/Development/*/venv"
    ]
}
```

> **Note**: Use forward slashes `/` even on Windows.

## Related Resources

- [Managing Python Projects](managing-python-projects.md): Learn how to organize projects with their own environments
- [Environment Management](../README.md#environment-management): Learn about creating and managing Python environments
- [Settings Reference](../README.md#settings-reference): Complete list of extension settings
