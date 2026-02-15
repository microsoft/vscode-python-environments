---
name: settings-precedence
description: VS Code settings precedence rules and common pitfalls. Essential for any code that reads or writes settings. Covers getConfiguration scope, inspect() vs get(), and multi-workspace handling.
argument-hint: Review settings handling in [file or component]
user-invocable: false
---

# VS Code Settings Precedence

Settings precedence bugs corrupt user configurations. This skill documents the correct patterns.

## Precedence Order (Highest to Lowest)

1. **Workspace folder value** - Per-folder in multi-root workspace
2. **Workspace value** - `.vscode/settings.json` or `.code-workspace`
3. **User/global value** - User `settings.json`
4. **Default value** - From extension's `package.json` (⚠️ may come from other extensions!)

## Core Rules

### Rule 1: Always Pass Scope to getConfiguration()

```typescript
// ❌ WRONG: Missing scope
const config = vscode.workspace.getConfiguration('python-envs');
const value = config.get('pythonProjects');
// workspaceFolderValue will be UNDEFINED because VS Code doesn't know which folder!

// ✅ RIGHT: Pass scope (workspace folder or document URI)
const config = vscode.workspace.getConfiguration('python-envs', workspaceFolder);
const value = config.get('pythonProjects');
```

**When to pass scope:**

- Reading per-resource settings (`scope: "resource"` in package.json)
- Any multi-workspace scenario
- When you need `workspaceFolderValue` from inspect()

### Rule 2: Use inspect() to Check Explicit Values

```typescript
// ❌ WRONG: get() returns defaultValue even from other extensions!
const config = vscode.workspace.getConfiguration('python');
if (config.get('useEnvironmentsExtension')) {
    // May return true from another extension's package.json default!
}

// ✅ RIGHT: Use inspect() and check explicit values only
const config = vscode.workspace.getConfiguration('python', scope);
const inspected = config.inspect('useEnvironmentsExtension');

const hasExplicitValue =
    inspected?.globalValue !== undefined ||
    inspected?.workspaceValue !== undefined ||
    inspected?.workspaceFolderValue !== undefined;

if (hasExplicitValue) {
    // User explicitly set this value
    const effectiveValue = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
}
```

### Rule 3: Don't Overwrite User's Explicit Values

```typescript
// ❌ WRONG: Unconditionally writing to settings
await config.update('pythonPath', detectedPath, ConfigurationTarget.Workspace);
// Overwrites user's explicit choice!

// ✅ RIGHT: Check for existing explicit values first
const inspected = config.inspect('pythonPath');
const hasUserValue = inspected?.workspaceValue !== undefined;

if (!hasUserValue) {
    // Only set if user hasn't explicitly chosen
    await config.update('pythonPath', detectedPath, ConfigurationTarget.Workspace);
}
```

### Rule 4: Update at the Correct Scope

```typescript
// Configuration targets (least to most specific)
ConfigurationTarget.Global; // User settings.json
ConfigurationTarget.Workspace; // .vscode/settings.json or .code-workspace
ConfigurationTarget.WorkspaceFolder; // Per-folder in multi-root

// To remove a setting, update with undefined
await config.update('pythonPath', undefined, ConfigurationTarget.Workspace);
```

## Multi-Root Workspace Handling

### The `workspace` Property

For multi-root workspaces, `pythonProjects` settings need a `workspace` property:

```json
{
    "python-envs.pythonProjects": [
        {
            "path": ".",
            "workspace": "/path/to/workspace-folder",
            "envManager": "ms-python.python:venv"
        }
    ]
}
```

Without the `workspace` property, settings get mixed up between folders.

### Getting the Right Workspace Folder

```typescript
// ❌ WRONG: Always using first workspace folder
const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

// ✅ RIGHT: Get folder for specific document/file
const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri) ?? vscode.workspace.workspaceFolders?.[0];

// When you have a path but not a URI
const uri = vscode.Uri.file(filePath);
const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
```

## Common Issues

### Issue: workspaceFolderValue is undefined

**Cause:** Missing scope parameter in `getConfiguration()`

```typescript
// This returns undefined for workspaceFolderValue!
const config = vscode.workspace.getConfiguration('python-envs');
const inspected = config.inspect('pythonProjects');
console.log(inspected?.workspaceFolderValue); // undefined!

// Fix: Pass scope
const config = vscode.workspace.getConfiguration('python-envs', workspaceFolder.uri);
const inspected = config.inspect('pythonProjects');
console.log(inspected?.workspaceFolderValue); // Now works!
```

### Issue: defaultValue from other extensions

**Cause:** Using `get()` instead of `inspect()` for boolean checks

The `defaultValue` in `inspect()` may come from ANY extension's `package.json`, not just yours:

```typescript
// Another extension might have in their package.json:
// "python.useEnvironmentsExtension": { "default": true }

// Your check will be wrong:
config.get('python.useEnvironmentsExtension') // true from other extension!

// Fix: Only check explicit values
const inspected = config.inspect('python.useEnvironmentsExtension');
if (inspected?.globalValue === true || ...) { }
```

### Issue: Settings overwritten on reload

**Cause:** Not checking for existing values before writing

```typescript
// During extension activation, this overwrites user's config!
await config.update('defaultEnvManager', 'venv', ConfigurationTarget.Global);

// Fix: Only write defaults if no value exists
const current = config.inspect('defaultEnvManager');
if (current?.globalValue === undefined && current?.workspaceValue === undefined) {
    await config.update('defaultEnvManager', 'venv', ConfigurationTarget.Global);
}
```

### Issue: Settings mixed up in multi-root

**Cause:** Not including workspace identifier in settings

```typescript
// Without workspace identifier, can't tell which folder this belongs to
{
    "python-envs.pythonProjects": [
        { "path": ".", "envManager": "venv" }  // Which workspace?
    ]
}

// Fix: Always include workspace when saving
const project = {
    path: projectPath,
    workspace: workspaceFolder.uri.fsPath,
    envManager: selectedManager
};
```

## Complete Example: Safe Settings Read/Write

```typescript
import * as vscode from 'vscode';

async function getProjectConfig(projectUri: vscode.Uri): Promise<ProjectConfig | undefined> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(projectUri);
    if (!workspaceFolder) {
        return undefined;
    }

    // Always pass scope!
    const config = vscode.workspace.getConfiguration('python-envs', workspaceFolder.uri);

    // Use inspect() to understand where values come from
    const inspected = config.inspect<ProjectConfig[]>('pythonProjects');

    // Prefer most specific value
    const projects = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue ?? []; // Don't use defaultValue!

    // Find project matching the URI
    return projects.find((p) => path.resolve(workspaceFolder.uri.fsPath, p.path) === projectUri.fsPath);
}

async function saveProjectConfig(projectUri: vscode.Uri, projectConfig: ProjectConfig): Promise<void> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(projectUri);
    if (!workspaceFolder) {
        return;
    }

    const config = vscode.workspace.getConfiguration('python-envs', workspaceFolder.uri);

    const inspected = config.inspect<ProjectConfig[]>('pythonProjects');

    // Get existing projects (not including defaults!)
    const existingProjects = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? [];

    // Ensure workspace property for multi-root
    const configToSave: ProjectConfig = {
        ...projectConfig,
        workspace: workspaceFolder.uri.fsPath,
    };

    // Update or add
    const projectIndex = existingProjects.findIndex(
        (p) => path.resolve(workspaceFolder.uri.fsPath, p.path) === projectUri.fsPath,
    );

    const updatedProjects = [...existingProjects];
    if (projectIndex >= 0) {
        updatedProjects[projectIndex] = configToSave;
    } else {
        updatedProjects.push(configToSave);
    }

    // Write to workspace folder scope in multi-root
    const target =
        vscode.workspace.workspaceFolders?.length > 1
            ? vscode.ConfigurationTarget.WorkspaceFolder
            : vscode.ConfigurationTarget.Workspace;

    await config.update('pythonProjects', updatedProjects, target);
}
```
