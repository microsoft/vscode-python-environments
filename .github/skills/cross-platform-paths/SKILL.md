---
name: cross-platform-paths
description: Critical patterns for cross-platform path handling in this VS Code extension. Windows vs POSIX path bugs are the #1 source of issues. Use this skill when reviewing or writing path-related code.
argument-hint: Review path handling in [file or component]
---

# Cross-Platform Path Handling

**CRITICAL**: This extension runs on Windows, macOS, and Linux. Path bugs are the #1 source of issues.

## Core Rules

### Rule 1: Never Concatenate Paths with `/`

```typescript
// ❌ WRONG: POSIX-style path concatenation
const envPath = homeDir + '/.venv/bin/python';

// ✅ RIGHT: Use path.join()
const envPath = path.join(homeDir, '.venv', 'bin', 'python');
```

### Rule 2: Use path.resolve() for Comparisons, Not path.normalize()

```typescript
// ❌ WRONG: path.normalize keeps relative paths relative on Windows
const normalized = path.normalize(fsPath);
// path.normalize('\test') → '\test' (still relative!)

// ✅ RIGHT: path.resolve adds drive letter on Windows
const normalized = path.resolve(fsPath);
// path.resolve('\test') → 'C:\test' (absolute!)

// When comparing paths, use resolve() on BOTH sides:
const pathA = path.resolve(fsPath);
const pathB = path.resolve(e.environmentPath.fsPath);
return pathA === pathB;
```

### Rule 3: Use Uri.file().fsPath for VS Code Paths

```typescript
// ❌ WRONG: Raw string comparison
if (filePath === otherPath) {
}

// ✅ RIGHT: Compare fsPath to fsPath
import { Uri } from 'vscode';
const fsPathA = Uri.file(pathA).fsPath;
const fsPathB = Uri.file(pathB).fsPath;
if (fsPathA === fsPathB) {
}
```

## Platform-Specific Gotchas

### Windows

| Issue              | Details                                      |
| ------------------ | -------------------------------------------- |
| Drive letters      | Paths start with `C:\`, `D:\`, etc.          |
| Backslashes        | Separator is `\`, not `/`                    |
| Case insensitivity | `C:\Test` equals `c:\test`                   |
| Long paths         | Paths >260 chars may fail                    |
| Mapped drives      | `Z:\` may not be accessible                  |
| pyenv-win          | Uses `pyenv.bat`, not `pyenv` or `pyenv.exe` |
| Poetry cache       | `%LOCALAPPDATA%\pypoetry\Cache\virtualenvs`  |
| UNC paths          | `\\server\share\` format                     |

### macOS

| Issue             | Details                                     |
| ----------------- | ------------------------------------------- |
| Case sensitivity  | Depends on filesystem (usually insensitive) |
| Homebrew symlinks | Complex symlink chains in `/opt/homebrew/`  |
| Poetry cache      | `~/Library/Caches/pypoetry/virtualenvs`     |
| XCode Python      | Different from Command Line Tools Python    |

### Linux

| Issue            | Details                                 |
| ---------------- | --------------------------------------- |
| Case sensitivity | Paths ARE case-sensitive                |
| /bin symlinks    | `/bin` may be symlink to `/usr/bin`     |
| XDG directories  | `~/.local/share/virtualenvs` for pipenv |
| Poetry cache     | `~/.cache/pypoetry/virtualenvs`         |
| Hidden files     | Dot-prefixed files are hidden           |

## Common Patterns

### Getting Platform-Specific Paths

```typescript
import * as os from 'os';
import * as path from 'path';

// Home directory
const home = os.homedir(); // Works cross-platform

// Construct paths correctly
const venvPath = path.join(home, '.venv', 'bin', 'python');
// Windows: C:\Users\name\.venv\bin\python
// macOS:   /Users/name/.venv/bin/python
// Linux:   /home/name/.venv/bin/python
```

### Environment-Specific Executable Names

```typescript
const isWindows = process.platform === 'win32';

// Python executable
const pythonExe = isWindows ? 'python.exe' : 'python';

// Activate script
const activateScript = isWindows
    ? path.join(venvPath, 'Scripts', 'activate.bat')
    : path.join(venvPath, 'bin', 'activate');

// pyenv command
const pyenvCmd = isWindows ? 'pyenv.bat' : 'pyenv';
```

### Normalizing Paths for Comparison

```typescript
import { normalizePath } from './common/utils/pathUtils';

// Use normalizePath() for map keys and comparisons
const key = normalizePath(filePath);
cache.set(key, value);

// But preserve original for user display
traceLog(`Discovered: ${filePath}`); // Keep original
```

### Handling Uri | string Union Types

```typescript
// ❌ WRONG: Assuming Uri
function process(locator: Uri | string) {
    const fsPath = locator.fsPath; // Crashes if string!
}

// ✅ RIGHT: Handle both types
function process(locator: Uri | string) {
    const fsPath = locator instanceof Uri ? locator.fsPath : locator;

    // Now normalize for comparisons
    const normalized = path.resolve(fsPath);
}
```

## File Existence Checks

```typescript
import * as fs from 'fs';
import * as path from 'path';

// Check file exists (cross-platform)
const configPath = path.join(projectRoot, 'pyproject.toml');
if (fs.existsSync(configPath)) {
    // File exists
}

// Use async version when possible
import { promises as fsPromises } from 'fs';
try {
    await fsPromises.access(configPath);
    // File exists
} catch {
    // File does not exist
}
```

## Shell Path Escaping

```typescript
// ❌ WRONG: Unescaped paths in shell commands
terminal.sendText(`python ${filePath}`);
// D:\path\file.py becomes "D:pathfile.py" in some shells!

// ✅ RIGHT: Quote paths
terminal.sendText(`python "${filePath}"`);

// For Git Bash on Windows, escape backslashes
const shellPath = isGitBash ? filePath.replace(/\\/g, '/') : filePath;
```

## Testing Cross-Platform Code

When testing path-related code:

1. Test on Windows (cmd, PowerShell, Git Bash)
2. Test on macOS (zsh, bash)
3. Test on Linux (bash, fish)

Pay special attention to:

- Paths with spaces: `C:\Program Files\Python`
- Paths with Unicode: `~/проекты/`
- Very long paths (>260 chars on Windows)
- Paths with special characters: `$`, `&`, `(`, `)`
