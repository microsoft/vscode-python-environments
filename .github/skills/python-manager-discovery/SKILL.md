---
name: python-manager-discovery
description: Environment manager-specific discovery patterns and known issues. Use when working on or reviewing environment discovery code for conda, poetry, pipenv, pyenv, or venv.
argument-hint: 'manager name (e.g., poetry, conda, pyenv)'
user-invocable: false
---

# Environment Manager Discovery Patterns

This skill documents manager-specific discovery patterns, environment variable precedence, and known issues.

## Manager Quick Reference

| Manager | Config Files                                   | Cache Location           | Key Env Vars                                        |
| ------- | ---------------------------------------------- | ------------------------ | --------------------------------------------------- |
| Poetry  | `poetry.toml`, `pyproject.toml`, `config.toml` | Platform-specific        | `POETRY_VIRTUALENVS_IN_PROJECT`, `POETRY_CACHE_DIR` |
| Pipenv  | `Pipfile`, `Pipfile.lock`                      | XDG or WORKON_HOME       | `WORKON_HOME`, `XDG_DATA_HOME`                      |
| Pyenv   | `.python-version`, `versions/`                 | `~/.pyenv/` or pyenv-win | `PYENV_ROOT`, `PYENV_VERSION`                       |
| Conda   | `environment.yml`, `conda-meta/`               | Registries + paths       | `CONDA_PREFIX`, `CONDA_DEFAULT_ENV`                 |
| venv    | `pyvenv.cfg`                                   | In-project               | None                                                |

---

## Poetry

### Discovery Locations

**Virtualenvs cache (default):**

- Windows: `%LOCALAPPDATA%\pypoetry\Cache\virtualenvs`
- macOS: `~/Library/Caches/pypoetry/virtualenvs`
- Linux: `~/.cache/pypoetry/virtualenvs`

**In-project (when enabled):**

- `.venv/` in project root

### Config Precedence (highest to lowest)

1. Local config: `poetry.toml` in project root
2. Environment variables: `POETRY_VIRTUALENVS_*`
3. Global config: `~/.config/pypoetry/config.toml`

### Known Issues

| Issue                     | Description                                     | Fix                              |
| ------------------------- | ----------------------------------------------- | -------------------------------- |
| `{cache-dir}` placeholder | Not resolved in paths from config               | Resolve placeholder before use   |
| Wrong default path        | Windows/macOS differ from Linux                 | Use platform-specific defaults   |
| In-project detection      | `POETRY_VIRTUALENVS_IN_PROJECT` must be checked | Check env var first, then config |

### Code Pattern

```typescript
async function getPoetryVirtualenvsPath(): Promise<string> {
    // 1. Check environment variable first
    const envVar = process.env.POETRY_VIRTUALENVS_PATH;
    if (envVar) return envVar;

    // 2. Check local poetry.toml
    const localConfig = await readPoetryToml(projectRoot);
    if (localConfig?.virtualenvs?.path) {
        return resolvePoetryPath(localConfig.virtualenvs.path);
    }

    // 3. Use platform-specific default
    return getDefaultPoetryCache();
}

function resolvePoetryPath(configPath: string): string {
    // Handle {cache-dir} placeholder
    if (configPath.includes('{cache-dir}')) {
        const cacheDir = getDefaultPoetryCache();
        return configPath.replace('{cache-dir}', cacheDir);
    }
    return configPath;
}
```

---

## Pipenv

### Discovery Locations

**Default:**

- Linux: `~/.local/share/virtualenvs/` (XDG_DATA_HOME)
- macOS: `~/.local/share/virtualenvs/`
- Windows: `~\.virtualenvs\`

**When WORKON_HOME is set:**

- Use `$WORKON_HOME/` directly

### Environment Variables

| Var                      | Purpose                      |
| ------------------------ | ---------------------------- |
| `WORKON_HOME`            | Override virtualenv location |
| `XDG_DATA_HOME`          | Base for Linux default       |
| `PIPENV_VENV_IN_PROJECT` | Create `.venv/` in project   |

### Known Issues

| Issue                         | Description         | Fix                          |
| ----------------------------- | ------------------- | ---------------------------- |
| Missing WORKON_HOME support   | Env var not checked | Read env var before defaults |
| Missing XDG_DATA_HOME support | Not used on Linux   | Check XDG spec               |

### Code Pattern

```typescript
function getPipenvVirtualenvsPath(): string {
    // Check WORKON_HOME first
    if (process.env.WORKON_HOME) {
        return process.env.WORKON_HOME;
    }

    // Check XDG_DATA_HOME on Linux
    if (process.platform === 'linux') {
        const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
        return path.join(xdgData, 'virtualenvs');
    }

    // Windows/macOS defaults
    return path.join(os.homedir(), '.virtualenvs');
}
```

---

## PyEnv

### Discovery Locations

**Unix:**

- `~/.pyenv/versions/` (default)
- `$PYENV_ROOT/versions/` (if PYENV_ROOT set)

**Windows (pyenv-win):**

- `%USERPROFILE%\.pyenv\pyenv-win\versions\`
- Different directory structure than Unix!

### Key Differences: Unix vs Windows

| Aspect  | Unix              | Windows (pyenv-win)                     |
| ------- | ----------------- | --------------------------------------- |
| Command | `pyenv`           | `pyenv.bat`                             |
| Root    | `~/.pyenv/`       | `%USERPROFILE%\.pyenv\pyenv-win\`       |
| Shims   | `~/.pyenv/shims/` | `%USERPROFILE%\.pyenv\pyenv-win\shims\` |

### Known Issues

| Issue                              | Description                                | Fix                                |
| ---------------------------------- | ------------------------------------------ | ---------------------------------- |
| path.normalize() vs path.resolve() | Windows drive letter missing               | Use `path.resolve()` on both sides |
| Wrong command on Windows           | Looking for `pyenv` instead of `pyenv.bat` | Check for `.bat` extension         |

### Code Pattern

```typescript
function getPyenvRoot(): string {
    if (process.env.PYENV_ROOT) {
        return process.env.PYENV_ROOT;
    }

    if (process.platform === 'win32') {
        // pyenv-win uses different structure
        return path.join(os.homedir(), '.pyenv', 'pyenv-win');
    }

    return path.join(os.homedir(), '.pyenv');
}

function getPyenvVersionsPath(): string {
    const root = getPyenvRoot();
    return path.join(root, 'versions');
}

// Use path.resolve() for comparisons!
function comparePyenvPaths(pathA: string, pathB: string): boolean {
    return path.resolve(pathA) === path.resolve(pathB);
}
```

---

## Conda

### Discovery Locations

**Environment locations:**

- Base install `envs/` directory
- `~/.conda/envs/`
- Paths in `~/.condarc` `envs_dirs`

**Windows Registry:**

- `HKCU\Software\Python\ContinuumAnalytics\`
- `HKLM\SOFTWARE\Python\ContinuumAnalytics\`

### Shell Activation

| Shell      | Activation Command                     |
| ---------- | -------------------------------------- |
| bash, zsh  | `source activate envname`              |
| fish       | `conda activate envname` (NOT source!) |
| PowerShell | `conda activate envname`               |
| cmd        | `activate.bat envname`                 |

### Known Issues

| Issue                 | Description             | Fix                        |
| --------------------- | ----------------------- | -------------------------- |
| Fish shell activation | Uses bash-style command | Use fish-compatible syntax |
| Registry paths        | May be stale/invalid    | Verify paths exist         |
| Base vs named envs    | Different activation    | Check if activating base   |

### Code Pattern

```typescript
function getCondaActivationCommand(shell: ShellType, envName: string): string {
    switch (shell) {
        case 'fish':
            // Fish uses different syntax!
            return `conda activate ${envName}`;
        case 'cmd':
            return `activate.bat ${envName}`;
        case 'powershell':
            return `conda activate ${envName}`;
        default:
            // bash, zsh
            return `source activate ${envName}`;
    }
}
```

---

## venv

### Discovery

**Identification:**

- Look for `pyvenv.cfg` file in directory
- Contains `home` and optionally `version` keys

### Version Extraction Priority

1. `version` field in `pyvenv.cfg`
2. Parse from `home` path (e.g., `Python311`)
3. Spawn Python executable (last resort)

### Code Pattern

```typescript
async function getVenvVersion(venvPath: string): Promise<string | undefined> {
    const cfgPath = path.join(venvPath, 'pyvenv.cfg');

    try {
        const content = await fs.readFile(cfgPath, 'utf-8');
        const lines = content.split('\n');

        for (const line of lines) {
            const [key, value] = line.split('=').map((s) => s.trim());
            if (key === 'version') {
                return value;
            }
        }

        // Fall back to parsing home path
        const homeLine = lines.find((l) => l.startsWith('home'));
        if (homeLine) {
            const home = homeLine.split('=')[1].trim();
            const match = home.match(/(\d+)\.(\d+)/);
            if (match) {
                return `${match[1]}.${match[2]}`;
            }
        }
    } catch {
        // Config file not found or unreadable
    }

    return undefined;
}
```

---

## PET Server (Native Finder)

### JSON-RPC Communication

The PET server is a Rust-based locator that communicates via JSON-RPC over stdio.

### Known Issues

| Issue               | Description                      | Fix                           |
| ------------------- | -------------------------------- | ----------------------------- |
| No timeout          | JSON-RPC can hang forever        | Add Promise.race with timeout |
| Silent spawn errors | Extension continues without envs | Surface spawn errors to user  |
| Resource leaks      | Worker pool not cleaned up       | Dispose on deactivation       |
| Type guard missing  | Response types not validated     | Add runtime type checks       |
| Cache key collision | Paths normalize to same key      | Use consistent normalization  |

### Code Pattern

```typescript
async function fetchFromPET<T>(method: string, params: unknown): Promise<T> {
    const timeout = 30000; // 30 seconds

    const result = await Promise.race([
        this.client.request(method, params),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('PET server timeout')), timeout)),
    ]);

    // Validate response type
    if (!isValidResponse<T>(result)) {
        throw new Error(`Invalid response from PET: ${JSON.stringify(result)}`);
    }

    return result;
}
```
