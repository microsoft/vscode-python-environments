# Class-Based Command Architecture with Three-Level Hierarchy

## Overview

Implemented package management commands using a three-level class hierarchy that separates concerns cleanly:

1. **Base class** (`PackageManagerCommand`) — minimal shared interface
2. **Template classes** (`InstallCommand`, `ListCommand`, etc.) — load command-specific settings
3. **Concrete classes** (`PipInstallCommand`, `CondaInstallCommand`, etc.) — implement package-manager-specific logic

This approach stores persisting arguments (like `indexUrl`) as instance properties while keeping ephemeral arguments (like packages) passed to `execute()`.

## Architecture Components

### 1. Base Class

**File**: `src/managers/builtin/commands/commandSettings.ts`

```typescript
interface CommandConstructorOptions {
    pythonExecutable: string;
    log?: LogOutputChannel;
    cancellationToken?: CancellationToken;
}

abstract class PackageManagerCommand {
    protected pythonExecutable: string;
    protected log?: LogOutputChannel;
    protected cancellationToken?: CancellationToken;

    constructor(options: CommandConstructorOptions) {
        this.pythonExecutable = options.pythonExecutable;
        this.log = options.log;
        this.cancellationToken = options.cancellationToken;
    }

    protected abstract buildCommand(ephemeralArgs: unknown): string[];
}
```

Minimal interface: only shared across all commands.

### 2. Template Classes

Each command type (install, uninstall, list, etc.) has a template class that:

- Loads its own command-specific settings from VS Code config
- Defines the execute() interface (signature varies per command)
- Is abstract (not instantiable directly)

#### InstallCommand Template

```typescript
abstract class InstallCommand extends PackageManagerCommand {
    protected settings: CommandSettings;

    constructor(options: CommandConstructorOptions) {
        super(options);
        const config = getConfiguration('python-envs.packageManager.installCommandArgs');
        this.settings = {
            executionTimeout: config.get<number>('executionTimeout', 300000),
            verboseOutput: config.get<boolean>('verboseOutput', false),
            retryOnFailure: config.get<boolean>('retryOnFailure', true),
            maxRetries: config.get<number>('maxRetries', 1),
        };
    }

    abstract execute(packages: { packageName: string; version?: string }[], upgrade?: boolean): Promise<void>;
}
```

### 3. Concrete Classes

Each concrete class implements `buildCommand()` and `execute()` with package-manager-specific logic.

#### PipInstallCommand (Concrete)

```typescript
export class PipInstallCommand extends InstallCommand {
    private indexUrl?: string; // Persisting argument

    constructor(options: CommandConstructorOptions) {
        super(options);
        const config = getConfiguration('python-envs.packageManager');
        this.indexUrl = config.get<string>('indexUrl'); // Load global config
    }

    // buildCommand uses persisting args (indexUrl) + ephemeral args (packages, upgrade)
    protected buildCommand(ephemeralArgs: InstallEphemeralArgs): string[] {
        let args = ['-m', 'pip', 'install'];

        if (this.indexUrl) {
            args.push('--index-url', this.indexUrl);
        }

        if (ephemeralArgs.upgrade) {
            args.push('--upgrade');
        }

        const processedArgs = processEditableInstallArgs(ephemeralArgs.packages.map((pkg) => pkg.packageName));
        args.push(...processedArgs);

        return args;
    }

    // execute() spawns subprocess directly with runPython
    async execute(packages: { packageName: string; version?: string }[], upgrade?: boolean): Promise<void> {
        const args = this.buildCommand({ packages, upgrade });

        await runPython(
            this.pythonExecutable,
            args,
            undefined,
            this.log,
            this.cancellationToken,
            this.settings.executionTimeout,
        );
    }
}
```

#### CondaInstallCommand (Concrete, Different Package Manager)

```typescript
export class CondaInstallCommand extends InstallCommand {
    protected buildCommand(ephemeralArgs: InstallEphemeralArgs): string[] {
        let args = ['install', '-y'];

        if (ephemeralArgs.upgrade) {
            args.push('--upgrade');
        }

        args.push(...ephemeralArgs.packages.map((p) => p.packageName));

        return args;
    }

    async execute(packages: { packageName: string; version?: string }[], upgrade?: boolean): Promise<void> {
        const args = this.buildCommand({ packages, upgrade });

        await runPython(
            this.pythonExecutable, // conda executable
            args,
            undefined,
            this.log,
            this.cancellationToken,
            this.settings.executionTimeout,
        );
    }
}
```

## Separation of Concerns

### Persisting Arguments (Constructor)

- Loaded once, reused across multiple executions
- Stored as instance properties
- Examples: `pythonExecutable`, `indexUrl`, `settings`, `log`

### Ephemeral Arguments (Execute)

- Change per invocation
- Passed to `execute()` method
- Examples: `packages`, `packageName`, `pythonVersion`, `upgrade`

```typescript
// Constructor: load persisting config
const install = new PipInstallCommand({
    pythonExecutable: '/usr/bin/python3',
    log: logger,
});

// execute(): pass ephemeral args
await install.execute([{ packageName: 'numpy' }], true);
await install.execute([{ packageName: 'pandas' }], false); // Same indexUrl reused
```

## Usage Flow

1. **Executor creates command instance** with persisting options:

    ```typescript
    const install = new PipInstallCommand({
        pythonExecutable,
        log: context.log,
        cancellationToken: context.cancellationToken,
    });
    ```

2. **Constructor**:
    - Calls `super(options)` to set pythonExecutable, log, cancellationToken
    - Loads indexUrl from global config (persisting)
    - Loads command-specific settings (timeout, retry, verbose)

3. **Caller invokes execute()** with ephemeral args:

    ```typescript
    await install.execute(packages, upgrade);
    ```

4. **execute()**:
    - Calls `buildCommand()` with ephemeral args
    - Calls `runPython()` directly (no intermediate executeCommand function)
    - Settings applied via `this.settings.executionTimeout`

## Command Files

| File                   | Template                   | Concrete(s)                                               |
| ---------------------- | -------------------------- | --------------------------------------------------------- |
| `commandSettings.ts`   | —                          | `PackageManagerCommand` base, `CommandSettings` interface |
| `install.ts`           | `InstallCommand`           | `PipInstallCommand`                                       |
| `uninstall.ts`         | `UninstallCommand`         | `PipUninstallCommand`                                     |
| `list.ts`              | `ListCommand`              | `PipListCommand`                                          |
| `version.ts`           | `VersionCommand`           | `PipVersionCommand`                                       |
| `availableVersions.ts` | `AvailableVersionsCommand` | `PipAvailableVersionsCommand`                             |
| `listDirectNames.ts`   | `ListDirectNamesCommand`   | `PipListDirectNamesCommand`                               |

## Future: Conda and Poetry

When extending to conda and poetry, simply add new concrete classes:

```typescript
// In conda/commands/install.ts
export class CondaInstallCommand extends InstallCommand {
    protected buildCommand(ephemeralArgs: InstallEphemeralArgs): string[] {
        // conda-specific argument building
    }
    async execute(packages, upgrade) {
        // conda-specific execution
    }
}

// In poetry/commands/install.ts
export class PoetryInstallCommand extends InstallCommand {
    protected buildCommand(ephemeralArgs: InstallEphemeralArgs): string[] {
        // poetry-specific argument building
    }
    async execute(packages, upgrade) {
        // poetry-specific execution
    }
}
```

Same template interface, different implementations per package manager.

## Key Design Decisions

✅ **Three-level hierarchy**: Base → Template → Concrete  
✅ **Persisting vs ephemeral**: Constructor for config, execute() for data  
✅ **Settings auto-load**: Each template loads its own command-specific settings  
✅ **Direct runPython**: No executeCommand intermediate function  
✅ **Command-specific indexUrl**: Only loaded by install commands, others ignore  
✅ **No stored results**: Commands return data directly, don't cache on instance  
✅ **Extensible**: Easy to add conda, poetry, uv variants by extending templates

## Executor Integration

**File**: `src/managers/builtin/commands/builtinCommandExecutor.ts`

```typescript
export class BuiltinCommandExecutor {
    async executeCommands(
        environment: PythonEnvironment,
        commands: BuiltinManageCommand[],
        context: BuiltinCommandExecutionContext,
    ): Promise<void> {
        const pythonExecutable = environment.execInfo?.run?.executable ?? 'python';

        for (const command of commands) {
            await this.executeCommand(pythonExecutable, command, context);
        }
    }

    private async executeCommand(
        pythonExecutable: string,
        command: BuiltinManageCommand,
        context: BuiltinCommandExecutionContext,
    ): Promise<void> {
        if (command.kind === 'install') {
            // Create concrete class with persisting options
            const install = new PipInstallCommand({
                pythonExecutable,
                log: context.log,
                cancellationToken: context.cancellationToken,
            });
            // Execute with ephemeral args
            await install.execute(command.payload.packages, command.payload.upgrade);
            return;
        }
        // Similar for uninstall, list, etc.
    }
}
```

## Architecture Components

### 1. Base Class

**File**: `src/managers/builtin/commands/commandSettings.ts`
