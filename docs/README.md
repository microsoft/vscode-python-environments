# Python Environments API

The `@vscode/python-environments` package lets VS Code extensions consume and
extend the API exposed by the
[Python Environments extension](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-python-envs).

Use this manual to:

- discover, select, create, and remove Python environments;
- inspect and manage installed packages;
- run Python in terminals, tasks, or background processes;
- work with Python projects and environment variables; or
- contribute an environment manager, package manager, or project creator.

The authoritative API declarations are in [`src/api.ts`](../src/api.ts).

> [!IMPORTANT]
> The API is flat. Call `api.getEnvironments()`, not
> `api.environments.getEnvironments()`. The smaller API interfaces organize the
> TypeScript declarations; they are not nested runtime objects.

## Contents

- [Get started](#get-started)
- [Environment methods](#environment-methods)
- [Package methods](#package-methods)
- [Project methods](#project-methods)
- [Execution methods](#execution-methods)
- [Environment variable methods](#environment-variable-methods)
- [Provider methods](#provider-methods)
- [Errors and lifecycle](#errors-and-lifecycle)
- [Shared types](#shared-types)
- [Compatibility guidance](#compatibility-guidance)

## Get started

### Install the package

Declare the Python Environments extension as a dependency of your extension:

```jsonc
{
    "extensionDependencies": ["ms-python.vscode-python-envs"]
}
```

Then install the API package:

```console
npm install @vscode/python-environments
```

The npm package provides the public types and the helper used to acquire the
API. The Python Environments VS Code extension provides the implementation at
runtime.

### `PythonEnvironments.api`

Call `PythonEnvironments.api()` during activation:

```typescript
import * as vscode from 'vscode';
import {
    PythonEnvironmentApi,
    PythonEnvironments,
} from '@vscode/python-environments';

export async function activate(
    context: vscode.ExtensionContext,
): Promise<void> {
    const api: PythonEnvironmentApi = await PythonEnvironments.api();

    const environments = await api.getEnvironments('all');
    // Use the API or pass it to services owned by the extension.
}
```

`PythonEnvironments.api()`:

1. Finds the extension with ID `ms-python.vscode-python-envs`.
2. Activates it when necessary.
3. Returns its `PythonEnvironmentApi`.

It rejects when the extension is missing or disabled, activation fails, or the
extension does not expose its API. Acquire the object once and reuse it.

### API areas

`PythonEnvironmentApi` combines the following interfaces into one object:

| Area | Representative members |
| --- | --- |
| Environments | `getEnvironments`, `resolveEnvironment`, `setEnvironment`, `createEnvironment` |
| Packages | `getPackages`, `managePackages`, `getPackageAvailableVersions` |
| Projects | `getPythonProjects`, `getPythonProject`, `addPythonProject` |
| Execution | `createTerminal`, `runInTerminal`, `runAsTask`, `runInBackground` |
| Environment variables | `getEnvironmentVariables`, `onDidChangeEnvironmentVariables` |
| Provider registration | `registerEnvironmentManager`, `registerPackageManager`, `registerPythonProjectCreator` |

## Environment methods

Environment methods discover, resolve, create, remove, and select Python
environments.

### Scopes

Many API calls use a scope to identify a project, workspace, manager, or global
state. Pass a `vscode.Uri` rather than a filesystem path whenever a method
accepts a URI.

| Type | Values | Used by |
| --- | --- | --- |
| `GetEnvironmentsScope` | `Uri`, `'all'`, or `'global'` | `getEnvironments` |
| `RefreshEnvironmentsScope` | `Uri` or `undefined` | `refreshEnvironments` |
| `GetEnvironmentScope` | `Uri` or `undefined` | `getEnvironment` |
| `SetEnvironmentScope` | `Uri`, `Uri[]`, or `undefined` | `setEnvironment` |
| `CreateEnvironmentScope` | `Uri`, `Uri[]`, or `'global'` | `createEnvironment` |
| `ResolveEnvironmentContext` | `Uri` | `resolveEnvironment` |

The scope values mean:

- **`Uri`**: the workspace, folder, file, environment directory, or Python
  executable relevant to that method.
- **`Uri[]`**: apply an environment operation to multiple URI scopes.
- **`'all'`**: return all discovered environments.
- **`'global'`**: address global Python installations or global environment
  creation.
- **`undefined` for selection**: get or set the global environment selection.
- **`undefined` for refresh**: refresh global and workspace discovery.
- **`undefined` for environment variables**: resolve variables for global
  scope.

`getEnvironments()` does not accept `undefined`. Use a URI, `'all'`, or
`'global'`.

`resolveEnvironment()` currently accepts only a `Uri`. Use the exported
signature as the contract even though older documentation may describe other
inputs.

### `PythonEnvironment` and identity

A `PythonEnvironment` contains an `envId`:

```typescript
interface PythonEnvironmentId {
    id: string;
    managerId: string;
}
```

- `envId.id` identifies the environment within its manager.
- `envId.managerId` identifies the manager that owns the environment.

Use both values when storing or comparing identities:

```typescript
import { PythonEnvironment } from '@vscode/python-environments';

function environmentKey(environment: PythonEnvironment): string {
    return `${environment.envId.managerId}:${environment.envId.id}`;
}
```

Do not read `environment.id`; the identifier is `environment.envId`.

### `getEnvironments`

```typescript
getEnvironments(
    scope: Uri | 'all' | 'global',
): Promise<PythonEnvironment[]>
```

Returns environments associated with a URI, global Python installations, or
all discovered environments. The result is always an array.

```typescript
const all = await api.getEnvironments('all');
const globalInstallations = await api.getEnvironments('global');
const projectEnvironments = await api.getEnvironments(projectUri);
```

Each result contains the following `PythonEnvironmentInfo` plus `envId`:

| Property | Type | Required |
| --- | --- | --- |
| `name` | `string` | Yes |
| `displayName` | `string` | Yes |
| `displayPath` | `string` | Yes |
| `version` | `string` | Yes |
| `environmentPath` | `Uri` | Yes |
| `execInfo` | `PythonEnvironmentExecutionInfo` | Yes |
| `sysPrefix` | `string` | Yes |
| `shortDisplayName` | `string` | No |
| `description` | `string` | No |
| `tooltip` | `string \| MarkdownString` | No |
| `iconPath` | `IconPath` | No |
| `group` | `string \| EnvironmentGroupInfo` | No |
| `error` | `string` | No |

### `refreshEnvironments`

```typescript
refreshEnvironments(scope: Uri | undefined): Promise<void>
```

Refreshes discovery for a URI. Pass `undefined` to refresh global and workspace
discovery.

```typescript
await api.refreshEnvironments(projectUri);
await api.refreshEnvironments(undefined);
```

### `resolveEnvironment`

```typescript
resolveEnvironment(
    context: Uri,
): Promise<PythonEnvironment | undefined>
```

Resolves an environment directory or Python executable URI. It returns
`undefined` when no manager can resolve the URI. The current exported signature
accepts only `Uri`.

```typescript
const resolved = await api.resolveEnvironment(pythonExecutableUri);
if (resolved === undefined) {
    // No registered manager resolved the URI.
}
```

### `getEnvironment`

```typescript
getEnvironment(
    scope: Uri | undefined,
): Promise<PythonEnvironment | undefined>
```

Gets the selected environment for a URI. Pass `undefined` for the global
selection. It returns `undefined` when no environment is selected.

```typescript
const selected = await api.getEnvironment(projectUri);
const globalSelection = await api.getEnvironment(undefined);
```

### `setEnvironment`

```typescript
setEnvironment(
    scope: Uri | Uri[] | undefined,
    environment?: PythonEnvironment,
): Promise<void>
```

Sets the selected environment for one or more URI scopes, or for global scope
when `scope` is `undefined`. Omit `environment` to clear the selection.

```typescript
await api.setEnvironment(projectUri, environment);
await api.setEnvironment([applicationUri, testsUri], environment);
await api.setEnvironment(projectUri, undefined);
```

### `createEnvironment`

```typescript
createEnvironment(
    scope: Uri | Uri[] | 'global',
    options?: CreateEnvironmentOptions,
): Promise<PythonEnvironment | undefined>
```

Creates an environment through the manager associated with the scope. It
returns `undefined` when no environment is created.

```typescript
const environment = await api.createEnvironment(projectUri, {
    quickCreate: true,
    additionalPackages: ['pytest'],
});

if (environment !== undefined) {
    await api.setEnvironment(projectUri, environment);
}
```

`CreateEnvironmentOptions` supports:

| Property | Meaning |
| --- | --- |
| `quickCreate: true` | Request creation without user input or prompts. |
| `quickCreate: false` | Permit prompts and indicate that quick create was explicitly skipped. |
| `quickCreate: undefined` | Permit prompts and allow the manager to offer quick create. |
| `additionalPackages` | Install these packages in addition to packages chosen during creation. |

### `removeEnvironment`

```typescript
removeEnvironment(
    environment: PythonEnvironment,
    options?: RemoveEnvironmentOptions,
): Promise<void>
```

Removes an environment through its owning manager.

```typescript
await api.removeEnvironment(environment, {
    runHeadless: true,
});
```

`RemoveEnvironmentOptions.runHeadless` requests removal without a confirmation
prompt.

### `onDidChangeEnvironments`

```typescript
onDidChangeEnvironments: Event<{
    kind: EnvironmentChangeKind;
    environment: PythonEnvironment;
}[]>
```

Fires with one or more `add` or `remove` changes to discovered environments.

### `onDidChangeEnvironment`

```typescript
onDidChangeEnvironment: Event<{
    readonly uri: Uri | undefined;
    readonly old: PythonEnvironment | undefined;
    readonly new: PythonEnvironment | undefined;
}>
```

Fires when the selected environment changes. `uri` is `undefined` for a global
selection change.

## Package methods

Package operations use the package manager associated with a
`PythonEnvironment`.

### `getPackages`

```typescript
getPackages(
    environment: PythonEnvironment,
    options?: GetPackagesOptions,
): Promise<Package[] | undefined>
```

Gets installed packages. It returns `undefined` when package information is
unavailable. Set `skipCache: true` to query the underlying package tool.

```typescript
const cachedPackages = await api.getPackages(environment);
const currentPackages = await api.getPackages(environment, {
    skipCache: true,
});
```

`Package` extends `PackageInfo` with a `pkgId` containing `id`, `managerId`, and
`environmentId`. `PackageInfo` contains:

| Property | Type | Required |
| --- | --- | --- |
| `name` | `string` | Yes |
| `displayName` | `string` | Yes |
| `version` | `string` | No |
| `description` | `string` | No |
| `tooltip` | `string \| MarkdownString` | No |
| `iconPath` | `IconPath` | No |
| `uris` | `readonly Uri[]` | No |
| `isTransitive` | `boolean` | No |

### `refreshPackages`

```typescript
refreshPackages(environment: PythonEnvironment): Promise<void>
```

Refreshes package information for an environment.

```typescript
await api.refreshPackages(environment);
```

### `managePackages`

```typescript
managePackages(
    environment: PythonEnvironment,
    options: PackageManagementOptions,
): Promise<void>
```

`PackageManagementOptions` requires `install`, `uninstall`, or both:

```typescript
await api.managePackages(environment, {
    install: ['requests', 'pytest'],
    upgrade: true,
});

await api.managePackages(environment, {
    uninstall: ['requests'],
});

await api.managePackages(environment, {
    install: ['requests'],
    uninstall: ['urllib3'],
    runHeadless: true,
});
```

| Option | Meaning |
| --- | --- |
| `install` | Package names or install arguments. |
| `uninstall` | Package names to uninstall. |
| `upgrade` | Upgrade packages that are already installed. |
| `showSkipOption` | Let an interactive flow offer to skip the operation. |
| `runHeadless` | Run without prompts and rely on the supplied package lists. |

### `getPackageAvailableVersions`

```typescript
getPackageAvailableVersions(
    environment: PythonEnvironment,
    packageName: string,
    options: { errorMode: 'throw' },
): Promise<Pep440Version[]>

getPackageAvailableVersions(
    environment: PythonEnvironment,
    packageName: string,
    options?: { errorMode?: 'legacy' | 'throw' },
): Promise<Pep440Version[] | undefined>
```

The default, legacy mode returns `undefined` when lookup is unsupported or
fails:

```typescript
const versions = await api.getPackageAvailableVersions(
    environment,
    'requests',
);
```

New integrations should use throw mode when they need to distinguish an
unsupported capability from an operational failure:

```typescript
import {
    isPackageVersionLookupNotSupportedError,
} from '@vscode/python-environments';

try {
    const versions = await api.getPackageAvailableVersions(
        environment,
        'requests',
        { errorMode: 'throw' },
    );
} catch (error) {
    if (isPackageVersionLookupNotSupportedError(error)) {
        // Offer manual version entry or hide version suggestions.
    } else {
        throw error;
    }
}
```

With `{ errorMode: 'throw' }`, unsupported lookup rejects with
`PackageVersionLookupNotSupportedError`; operational failures propagate
unchanged. Use the exported type guard instead of relying only on `instanceof`,
because extensions may bundle separate copies of the API package.
The error exposes the stable code `PackageVersionLookupNotSupported`.

### `onDidChangePackages`

```typescript
onDidChangePackages: Event<{
    environment: PythonEnvironment;
    manager: PackageManager;
    changes: { kind: PackageChangeKind; pkg: Package }[];
}>
```

Fires when packages are added or removed. `PackageChangeKind` contains `add`
and `remove`.

## Project methods

A `PythonProject` represents a folder or file that can have its own Python
environment. Workspace folders are projects by default.

```typescript
interface PythonProject {
    readonly name: string;
    readonly uri: Uri;
    readonly description?: string;
    readonly tooltip?: string | MarkdownString;
}
```

### `getPythonProjects`

```typescript
getPythonProjects(): readonly PythonProject[]
```

Synchronously returns all known projects.

### `getPythonProject`

```typescript
getPythonProject(uri: Uri): PythonProject | undefined
```

Synchronously returns the project associated with a URI.

```typescript
const projects = api.getPythonProjects();
const project = api.getPythonProject(document.uri);

if (project !== undefined) {
    const environment = await api.getEnvironment(project.uri);
}
```

### `addPythonProject`

```typescript
addPythonProject(
    projects: PythonProject | PythonProject[],
): void
```

```typescript
import { PythonProject } from '@vscode/python-environments';

const project: PythonProject = {
    name: 'Backend',
    uri: backendUri,
    description: 'Backend service',
};

api.addPythonProject(project);
```

### `removePythonProject`

```typescript
removePythonProject(project: PythonProject): void
```

`removePythonProject()` removes the project from tracking; it does not describe
a filesystem deletion operation.

### `onDidChangePythonProjects`

```typescript
onDidChangePythonProjects: Event<{
    added: PythonProject[];
    removed: PythonProject[];
}>
```

Fires after projects are added to or removed from the tracked collection.

See [Making and Managing Python Projects](managing-python-projects.md) for
project-oriented user workflows.

## Execution methods

All execution methods require a `PythonEnvironment`.

### `PythonEnvironmentExecutionInfo`

The environment describes execution with a required `run` command and optional
`activatedRun`, `activation`, `shellActivation`, `deactivation`, and
`shellDeactivation` commands. Each `PythonCommandRunConfiguration` contains an
absolute, spawnable `executable` and optional `args`.

### `createTerminal`

```typescript
createTerminal(
    environment: PythonEnvironment,
    options: PythonTerminalCreateOptions,
): Promise<Terminal>
```

`PythonTerminalCreateOptions` extends VS Code's `TerminalOptions` and adds
`disableActivation?: boolean`.

```typescript
const terminal = await api.createTerminal(environment, {
    name: 'Python tools',
    cwd: project.uri,
    disableActivation: false,
});

terminal.show();
```

### `runInTerminal`

```typescript
runInTerminal(
    environment: PythonEnvironment,
    options: PythonTerminalExecutionOptions,
): Promise<Terminal>
```

Runs Python in an available project terminal, creating one when necessary.
`PythonTerminalExecutionOptions` requires `cwd: string | Uri` and optionally
accepts `args: string[]` and `show: boolean`.

```typescript
await api.runInTerminal(environment, {
    cwd: project.uri,
    args: ['script.py', '--verbose'],
    show: true,
});
```

### `runInDedicatedTerminal`

```typescript
runInDedicatedTerminal(
    terminalKey: Uri | string,
    environment: PythonEnvironment,
    options: PythonTerminalExecutionOptions,
): Promise<Terminal>
```

Runs Python in a terminal selected by a stable URI or string key.

```typescript
await api.runInDedicatedTerminal(
    document.uri,
    environment,
    {
        cwd: project.uri,
        args: [document.uri.fsPath],
        show: true,
    },
);
```

`runInDedicatedTerminal()` accepts a `Uri` or string key. Reuse a stable key for
work that should use the same dedicated terminal.

### `runAsTask`

```typescript
runAsTask(
    environment: PythonEnvironment,
    options: PythonTaskExecutionOptions,
): Promise<TaskExecution>
```

`PythonTaskExecutionOptions` requires `name` and `args`; it optionally accepts a
`project`, `cwd`, and string-valued `env`.

```typescript
const execution = await api.runAsTask(environment, {
    name: 'Run tests',
    args: ['-m', 'pytest', '-q'],
    project,
    cwd: project.uri.fsPath,
    env: {
        PYTHONUNBUFFERED: '1',
    },
});
```

### `runInBackground`

```typescript
runInBackground(
    environment: PythonEnvironment,
    options: PythonBackgroundRunOptions,
): Promise<PythonProcess>
```

Starts a new process. `PythonBackgroundRunOptions` requires `args`; `cwd` and
`env` are optional.

```typescript
const process = await api.runInBackground(environment, {
    args: ['-m', 'http.server', '8000'],
    cwd: project.uri.fsPath,
    env: {
        PYTHONUNBUFFERED: '1',
    },
});

process.stdout.on('data', (data) => {
    output.append(data.toString());
});

process.stderr.on('data', (data) => {
    output.append(data.toString());
});

process.onExit((code, signal) => {
    output.appendLine(`Python exited: code=${code}, signal=${signal}`);
});
```

`PythonProcess` exposes `pid`, `stdin`, `stdout`, `stderr`, `kill()`, and
`onExit()`. Unlike a VS Code `Event`, `onExit()` does not return a `Disposable`.

## Environment variable methods

### `getEnvironmentVariables`

```typescript
getEnvironmentVariables(
    uri: Uri | undefined,
    overrides?: ({ [key: string]: string | undefined } | Uri)[],
    baseEnvVar?: { [key: string]: string | undefined },
): Promise<{ [key: string]: string | undefined }>
```

`getEnvironmentVariables()` combines process, configured, project, and caller
variables:

```typescript
const variables = await api.getEnvironmentVariables(
    project.uri,
    [
        commonEnvironmentFileUri,
        { MY_EXTENSION_MODE: 'analysis' },
    ],
    {
        PATH: process.env.PATH,
        PYTHONUTF8: '1',
    },
);
```

Values are applied from lowest to highest precedence:

1. `baseEnvVar`, or `process.env` when it is omitted.
2. The file configured by the `python.envFile` setting.
3. The `.env` file at the Python project root.
4. Each `overrides` entry in array order.

An override can be a URI for an environment file or an object whose values are
`string | undefined`. Pass `undefined` as the first argument for global scope.

### `onDidChangeEnvironmentVariables`

```typescript
onDidChangeEnvironmentVariables:
    Event<DidChangeEnvironmentVariablesEventArgs>
```

Subscribe to changes when cached results depend on these variables:

```typescript
context.subscriptions.push(
    api.onDidChangeEnvironmentVariables((event) => {
        const changedFile = event.uri;
        const changeType = event.changeType;
    }),
);
```

The URI is absent when a non-file source changes. `changeType` is VS Code's
`FileChangeType`.

## Provider methods

### `registerEnvironmentManager`

```typescript
registerEnvironmentManager(
    manager: EnvironmentManager,
    options?: { extensionId?: string },
): Disposable
```

Registers an environment manager and returns a disposable that unregisters it.
When `extensionId` is omitted, or cannot be found, the API attempts to detect
the calling extension.

```typescript
context.subscriptions.push(
    api.registerEnvironmentManager(manager, {
        extensionId: context.extension.id,
    }),
);
```

#### `EnvironmentManager`

An `EnvironmentManager` discovers environments, controls environment
selection, and can optionally create and remove environments.

| Member | Required | Purpose |
| --- | --- | --- |
| `name` | Yes | Provider-local ID containing only letters, numbers, `-`, and `_`. |
| `preferredPackageManagerId` | Yes | Fully qualified ID of the preferred package manager. |
| `refresh(scope)` | Yes | Re-discover environments for the scope. |
| `getEnvironments(scope)` | Yes | Return environments known in the scope. |
| `set(scope, environment?)` | Yes | Apply or clear the selected environment. |
| `get(scope)` | Yes | Return the selected environment. |
| `resolve(context)` | Yes | Resolve a URI to an environment or return `undefined`. |
| `create(scope, options?)` | No | Create an environment. |
| `remove(environment, options?)` | No | Remove an environment. |
| `quickCreateConfig()` | No | Describe the manager's quick-create option. |
| `clearCache()` | No | Clear provider-owned environment caches. |
| `onDidChangeEnvironments` | No | Report discovered environment changes. |
| `onDidChangeEnvironment` | No | Report selection changes. |

Optional metadata includes `displayName`, `description`, `tooltip`, `iconPath`,
and a `LogOutputChannel`.

Omit unsupported optional methods rather than implementing methods that always
throw. `quickCreateConfig()` enables quick-create UI only when the manager also
implements `create()`.

### `createPythonEnvironmentItem`

```typescript
createPythonEnvironmentItem(
    info: PythonEnvironmentInfo,
    manager: EnvironmentManager,
): PythonEnvironment
```

Use `createPythonEnvironmentItem()` rather than constructing `envId`:

```typescript
const environment = api.createPythonEnvironmentItem(
    {
        name: discovered.name,
        displayName: discovered.displayName,
        displayPath: discovered.executable.fsPath,
        version: discovered.version,
        environmentPath: discovered.executable,
        sysPrefix: discovered.sysPrefix,
        execInfo: {
            run: {
                executable: discovered.executable.fsPath,
            },
        },
    },
    manager,
);
```

`PythonEnvironmentInfo` requires complete execution information and
`sysPrefix`. Register the manager before publishing items created for it.

The manager may be called by startup, UI, terminal, execution, and other
extension workflows. Implementations should:

- make `get()` and `getEnvironments()` efficient and safe to call repeatedly;
- update internal state before firing change events;
- return `undefined` from `resolve()` when the URI is not recognized;
- return complete execution details for resolved environments;
- treat `refresh()` as an explicit request to rediscover state;
- clear provider-owned state when `clearCache()` is called; and
- dispose their own event emitters, watchers, processes, and output channels.

### `registerPackageManager`

```typescript
registerPackageManager(
    manager: PackageManager,
    options?: { extensionId?: string },
): Disposable
```

Registers a package manager and returns a disposable that unregisters it.

```typescript
context.subscriptions.push(
    api.registerPackageManager(packageManager, {
        extensionId: context.extension.id,
    }),
);
```

Set an environment manager's `preferredPackageManagerId` to the fully qualified
ID of the package manager intended to handle its environments.

#### `PackageManager`

A `PackageManager` reports installed packages and performs package operations
for environments.

| Member | Required | Purpose |
| --- | --- | --- |
| `name` | Yes | Provider-local ID containing supported manager-name characters. |
| `manage(environment, options)` | Yes | Install or uninstall packages. |
| `refresh(environment)` | Yes | Refresh package state. |
| `getPackages(environment, options?)` | Yes | Return installed packages or `undefined`. |
| `getPackageWatchTargets(environment)` | No | Add manager-specific filesystem watch patterns. |
| `getDirectPackageNames(environment)` | No | Return a best-effort set of direct package names. |
| `clearCache()` | No | Clear provider-owned package caches. |
| `getVersion(environment)` | No | Return the package tool's PEP 440 version. |
| `getPackageAvailableVersions(environment, name)` | No | Return available versions, newest first. |
| `formatInstallSpec(name, version)` | No | Format a versioned install requirement. |
| `onDidChangePackages` | No | Report package additions and removals. |

Optional metadata includes `displayName`, `description`, `tooltip`, `iconPath`,
and a `LogOutputChannel`.

When `formatInstallSpec()` is absent, callers should use `name==version`.
`getDirectPackageNames()` is best effort because many package tools cannot
distinguish explicit installation intent from packages with no installed
dependents.

### `createPackageItem`

```typescript
createPackageItem(
    info: PackageInfo,
    environment: PythonEnvironment,
    manager: PackageManager,
): Package
```

```typescript
const packageItem = api.createPackageItem(
    {
        name: discovered.name,
        displayName: discovered.displayName,
        version: discovered.version,
        isTransitive: discovered.isTransitive,
    },
    environment,
    packageManager,
);
```

Use this helper instead of constructing `pkgId`. Register the package manager
before creating its items.

#### Implementing version lookup

A version lookup implementation should:

- return `Pep440Version[]` in newest-first order on success;
- throw `PackageVersionLookupNotSupportedError` when the capability is
  unsupported; and
- propagate command, network, and parsing failures unchanged.

Returning `undefined` is allowed by the provider signature, but callers treat
it as an unsupported capability.

### `registerPythonProjectCreator`

```typescript
registerPythonProjectCreator(
    creator: PythonProjectCreator,
): Disposable
```

Registers a project creation workflow and returns a disposable that unregisters
it.

A `PythonProjectCreator` contributes a project creation workflow.

| Member | Required | Purpose |
| --- | --- | --- |
| `name` | Yes | Identify the creator. |
| `create(options?)` | Yes | Create projects or standalone files. |
| `displayName` | No | Provide a user-facing name. |
| `description` | No | Describe the creator. |
| `tooltip` | No | Provide additional UI detail. |
| `supportsQuickCreate` | No | Declare support for creation without user input. |

`create()` returns:

- `PythonProject` or `PythonProject[]` for created projects;
- `Uri` or `Uri[]` for created files that are not projects; or
- `undefined` when creation produces no result.

When supplied, `PythonProjectCreatorOptions` contains a required project
`name`, a required `rootUri`, and an optional `quickCreate` flag.

```typescript
import * as vscode from 'vscode';
import {
    PythonProject,
    PythonProjectCreator,
    PythonProjectCreatorOptions,
} from '@vscode/python-environments';

class ExampleProjectCreator implements PythonProjectCreator {
    public readonly name = 'example';
    public readonly displayName = 'Example project';
    public readonly supportsQuickCreate = true;

    public async create(
        options?: PythonProjectCreatorOptions,
    ): Promise<PythonProject | undefined> {
        if (options === undefined) {
            return undefined;
        }

        const uri = vscode.Uri.joinPath(options.rootUri, options.name);
        await vscode.workspace.fs.createDirectory(uri);

        return {
            name: options.name,
            uri,
        };
    }
}
```

Register the creator and retain its disposable:

```typescript
context.subscriptions.push(
    api.registerPythonProjectCreator(projectCreator),
);
```

## Errors and lifecycle

### Events

API events follow the VS Code `Event<T>` pattern. Store their disposables:

```typescript
context.subscriptions.push(
    api.onDidChangeEnvironments((changes) => {
        for (const change of changes) {
            output.appendLine(
                `${change.kind}: ${change.environment.displayName}`,
            );
        }
    }),
    api.onDidChangeEnvironment(({ uri, old, new: current }) => {
        // React to a selected environment change.
    }),
    api.onDidChangePackages(({ environment, manager, changes }) => {
        // React to installed package changes.
    }),
    api.onDidChangePythonProjects(({ added, removed }) => {
        // React to project collection changes.
    }),
);
```

Change kinds are string enums:

- `EnvironmentChangeKind.add` and `EnvironmentChangeKind.remove`;
- `PackageChangeKind.add` and `PackageChangeKind.remove`.

Registration methods also return `Disposable` objects. Disposing a
registration unregisters that provider. Providers remain responsible for
resources they own.

### Errors and missing values

Handle rejected promises separately from `undefined` results:

- `PythonEnvironments.api()` rejects when the extension or API is unavailable.
- `resolveEnvironment()` returns `undefined` when a URI cannot be resolved.
- `createEnvironment()` can return `undefined` when no environment is created.
- `getEnvironment()` returns `undefined` when no environment is selected.
- `getPackages()` can return `undefined` when packages are unavailable.
- legacy package version lookup returns `undefined` for unsupported lookup and
  operational failure;
- throw-mode package version lookup distinguishes unsupported capability from
  other failures.

Provider implementations should propagate operational failures rather than
turning them into successful-looking empty results unless the public contract
explicitly defines such a result.

## Shared types

### UI-related types

`IconPath` can be a `Uri`, a light/dark pair of URIs, or a VS Code
`ThemeIcon`.

`EnvironmentGroupInfo` contains a required group `name` and optional
`description`, `tooltip`, and `iconPath`.

`QuickCreateConfig` contains a required `description` and optional `detail`.

## Compatibility guidance

- Use only exports from `@vscode/python-environments`; do not import
  `internal.api.ts` or extension implementation modules.
- Declare `ms-python.vscode-python-envs` in `extensionDependencies`.
- Acquire the API through `PythonEnvironments.api()`.
- Remember that the API object is flat.
- Use `env.envId`, not a direct `env.id`.
- Pass URIs so the API can route project and environment operations.
- Feature-detect optional provider methods.
- Dispose event subscriptions and provider registrations.
- Preserve operational errors and handle documented `undefined` results.
- Use `isPackageVersionLookupNotSupportedError()` across bundle boundaries.
- Recompile after updating the npm package so TypeScript detects API changes.

The public API is intended to avoid breaking changes. Check
[`api/CHANGELOG.md`](../api/CHANGELOG.md) when updating the package.

## Related documentation

- [`src/api.ts`](../src/api.ts) - authoritative API declarations
- [`api/README.md`](../api/README.md) - npm package quick start
- [Making and Managing Python Projects](managing-python-projects.md)
- [Projects API Reference](projects-api-reference.md)
- [Python Environments API Design](design.md)
- [Startup Flow](startup-flow.md)
- [`examples/sample1`](../examples/sample1) - sample environment manager
