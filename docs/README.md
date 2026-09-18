# Python Environments API

The `@vscode/python-environments` package lets VS Code extensions consume and
extend the API exposed by the
[Python Environments extension](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-python-envs).

Use this manual to:

- discover, select, create, and remove Python environments;
- inspect and manage installed packages;
- work with Python projects;
- run Python in terminals, tasks, or background processes;
- resolve environment variables; or
- contribute an environment manager, package manager, or project creator.

The runtime facade is [`src/api.ts`](../src/api.ts). The authoritative public
contracts are in [`src/types.ts`](../src/types.ts), with public errors and type
guards in [`src/publicErrors.ts`](../src/publicErrors.ts).

> [!IMPORTANT]
> The API is flat. Call `api.getEnvironments()`, not
> `api.environments.getEnvironments()`. The smaller API interfaces organize the
> TypeScript declarations; they are not nested runtime objects.

## Contents

- [Getting started](#getting-started)
- [Domains](#domains)
- [Environments](#environments)
    - [Environment data types](#environment-data-types)
    - [Environment methods](#environment-methods)
- [Packages](#packages)
    - [Package data types](#package-data-types)
    - [Package methods](#package-methods)
    - [Package errors](#package-errors)
- [Projects](#projects)
    - [Project data types](#project-data-types)
    - [Project methods](#project-methods)
- [Execution](#execution)
    - [Execution data types](#execution-data-types)
    - [Execution methods](#execution-methods)
- [Environment variables](#environment-variables)
    - [Environment variable data types](#environment-variable-data-types)
    - [Environment variable methods](#environment-variable-methods)
- [Extensibility](#extensibility)
    - [Extensibility data types](#extensibility-data-types)
    - [Extensibility methods](#extensibility-methods)
- [API interface groups](#api-interface-groups)
- [Compatibility guidance](#compatibility-guidance)
- [Related documentation](#related-documentation)

## Getting started

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

### Acquire the API

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

1. Finds the extension with ID `ms-python.vscode-python-envs`
   (exported as `EXTENSION_ID`).
2. Activates it when necessary.
3. Returns its `PythonEnvironmentApi`.

It rejects when the extension is missing or disabled, activation fails, or the
extension does not expose its API. Acquire the object once and reuse it.

### How to read this manual

Each domain below is self-contained and has the same shape:

1. **Data types** - the objects the domain accepts and returns. Every type is
   documented as a field table with these columns:

    | Column | Meaning |
    | --- | --- |
    | Field | The property name as declared in `src/types.ts`. |
    | Type | The TypeScript type of the property. |
    | Required | `Yes` when the property must be present; `No` when it is optional (`?`). |
    | Description | What the property means and how the extension uses it. |

    Most returned objects declare their properties `readonly`. Treat everything
    the API hands back as immutable, and build new objects rather than mutating
    them.

2. **Methods** - the calls the domain exposes. Each method documents its
   signature, a parameter table using the same `Required` convention, its
   return type, and an example.

Locations are not all the same type. Scopes, project locations, and resolution
contexts are declared as `vscode.Uri`, so pass a `Uri` there rather than a
string, and let the extension resolve the owning project. A few options carry a
filesystem path instead - `PythonTaskExecutionOptions.cwd`,
`PythonBackgroundRunOptions.cwd`, and `PythonCommandRunConfiguration.executable`
are all `string`. Use `uri.fsPath` for those so the separator is correct on
every platform.

## Domains

| Domain | Use it to | Representative members |
| --- | --- | --- |
| [Environments](#environments) | Discover, resolve, select, create, and remove interpreters. | `getEnvironments`, `resolveEnvironment`, `setEnvironment`, `createEnvironment` |
| [Packages](#packages) | Read and change what is installed in an environment. | `getPackages`, `managePackages`, `getPackageAvailableVersions` |
| [Projects](#projects) | Read and modify the set of Python projects. | `getPythonProjects`, `getPythonProject`, `addPythonProject` |
| [Execution](#execution) | Run Python with an environment already activated. | `createTerminal`, `runInTerminal`, `runAsTask`, `runInBackground` |
| [Environment variables](#environment-variables) | Resolve the effective variables for a scope. | `getEnvironmentVariables`, `onDidChangeEnvironmentVariables` |
| [Extensibility](#extensibility) | Contribute your own managers and creators. | `registerEnvironmentManager`, `registerPackageManager`, `registerPythonProjectCreator` |

## Environments

An environment is a Python interpreter plus the information needed to run and
activate it. Environments are supplied by environment managers (venv, conda,
and any manager contributed by another extension) and are identified by
`envId`, never by path alone.

### Environment data types

#### `PythonEnvironmentId`

Uniquely identifies an environment. Two environments are the same only when
both fields match.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | Yes | Manager-scoped unique identifier for the environment. Unique only within `managerId`. |
| `managerId` | `string` | Yes | Identifier of the environment manager that owns the environment, formatted `<publisher>.<extension>:<manager-name>`. |

```typescript
const key = `${env.envId.managerId}:${env.envId.id}`;
```

#### `PythonEnvironmentInfo`

The descriptive payload of an environment. Providers build this object and pass
it to [`createPythonEnvironmentItem`](#createpythonenvironmentitem); consumers
read these fields off a `PythonEnvironment`.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Short internal name of the environment. |
| `displayName` | `string` | Yes | Name shown in pickers and the environment tree. |
| `shortDisplayName` | `string` | No | Compact name for constrained UI such as the status bar. |
| `displayPath` | `string` | Yes | Human-readable path shown alongside the name. Use a home-relative or otherwise shortened form. |
| `version` | `string` | Yes | Python version string, for example `3.12.1`. |
| `environmentPath` | `Uri` | Yes | Path to the Python binary or the environment folder. |
| `description` | `string` | No | Extra descriptive text shown next to the environment. |
| `tooltip` | `string \| MarkdownString` | No | Hover text for the environment. |
| `iconPath` | [`IconPath`](#iconpath) | No | Icon shown for the environment. |
| `execInfo` | [`PythonEnvironmentExecutionInfo`](#pythonenvironmentexecutioninfo) | Yes | How to run and activate the interpreter. Required for any execution. |
| `sysPrefix` | `string` | Yes | Value of `sys.prefix` for the environment. Consumed by Pylance, Jupyter, and similar extensions. |
| `group` | `string \| EnvironmentGroupInfo` | No | Groups the environment in the environment manager UI. The first group instance with a given name wins. |
| `error` | `string` | No | Set when the environment is broken or invalid, for example a missing interpreter or dangling symlink. The UI shows a warning with this message. |

```typescript
const info: PythonEnvironmentInfo = {
    name: 'my-venv',
    displayName: 'Python 3.12.1 (my-venv)',
    shortDisplayName: 'my-venv',
    displayPath: '~/code/app/.venv',
    version: '3.12.1',
    environmentPath: vscode.Uri.file('/home/me/code/app/.venv/bin/python'),
    sysPrefix: '/home/me/code/app/.venv',
    execInfo: { run: { executable: '/home/me/code/app/.venv/bin/python' } },
};
```

#### `PythonEnvironment`

`PythonEnvironmentInfo` plus its identity. This is the object every environment
method returns and nearly every other method accepts.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `envId` | [`PythonEnvironmentId`](#pythonenvironmentid) | Yes | Identity of the environment. Use this - there is no `id` property. |
| *(inherited)* | [`PythonEnvironmentInfo`](#pythonenvironmentinfo) | - | All descriptive fields listed above. |

```typescript
const env = await api.getEnvironment(projectUri);
if (env) {
    console.log(env.displayName, env.envId.id, env.execInfo.run.executable);
}
```

> [!NOTE]
> `PythonEnvironment` is a structural interface, so TypeScript will accept a
> hand-written literal - but manager-backed calls such as `getPackages` and
> `removeEnvironment` need an `envId` that belongs to a registered manager.
> Consumers should pass environments the API returned; providers should build
> them with `createPythonEnvironmentItem`, which attaches a valid `envId`.

#### `EnvironmentGroupInfo`

Describes a group heading in the environment manager UI, for managers that want
richer grouping than a plain string.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Group name, also used as the group identifier. |
| `description` | `string` | No | Secondary text for the group. |
| `tooltip` | `string \| MarkdownString` | No | Hover text for the group. |
| `iconPath` | [`IconPath`](#iconpath) | No | Icon shown for the group. |

```typescript
const group: EnvironmentGroupInfo = {
    name: 'Conda',
    description: 'Managed by conda',
    iconPath: new vscode.ThemeIcon('package'),
};
```

#### `IconPath`

Shared icon type used by environments, groups, packages, managers, and
creators.

| Form | Description |
| --- | --- |
| `Uri` | A single icon used for every theme. |
| `{ light: Uri; dark: Uri }` | Theme-specific icons; both fields are required. |
| `ThemeIcon` | A built-in VS Code codicon, for example `new vscode.ThemeIcon('snake')`. |

#### Scope types

Scopes tell the extension *which* project, folder, or global state a call
applies to.

| Type | Values | Meaning | Used by |
| --- | --- | --- | --- |
| `GetEnvironmentsScope` | `Uri \| 'all' \| 'global'` | `Uri` limits results to the owning project; `'all'` returns everything known; `'global'` returns base installations used to create virtual environments. | [`getEnvironments`](#getenvironments) |
| `RefreshEnvironmentsScope` | `Uri \| undefined` | `Uri` refreshes one project; `undefined` refreshes global and workspace discovery. | [`refreshEnvironments`](#refreshenvironments) |
| `GetEnvironmentScope` | `Uri \| undefined` | `Uri` reads the selection for that project or file; `undefined` reads the global selection. | [`getEnvironment`](#getenvironment) |
| `SetEnvironmentScope` | `Uri \| Uri[] \| undefined` | `Uri` or `Uri[]` sets the selection for those projects; `undefined` sets the global selection. | [`setEnvironment`](#setenvironment) |
| `CreateEnvironmentScope` | `Uri \| Uri[] \| 'global'` | Where to create the environment; `'global'` creates one outside any project. | [`createEnvironment`](#createenvironment) |
| `ResolveEnvironmentContext` | `Uri` | An interpreter path or environment folder to resolve. Only a `Uri` is accepted. | [`resolveEnvironment`](#resolveenvironment) |

#### `CreateEnvironmentOptions`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `quickCreate` | `boolean` | No | `true` creates without any prompts. `false` means the user explicitly declined quick create, so prompts are allowed. `undefined` leaves the decision to the manager, which may offer quick create. |
| `additionalPackages` | `string[]` | No | Packages to install in addition to whatever the manager installs by default. |

```typescript
const env = await api.createEnvironment(projectUri, {
    quickCreate: true,
    additionalPackages: ['requests', 'pytest'],
});
```

#### `RemoveEnvironmentOptions`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `runHeadless` | `boolean` | No | `true` removes the environment without a confirmation prompt. Intended for automated scenarios. Defaults to `false`. |

#### `QuickCreateConfig`

Returned by an environment manager's `quickCreateConfig()` to describe its
one-click creation path. Returning `undefined` disables quick create.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `description` | `string` | Yes | Short label for the quick create step. |
| `detail` | `string` | No | Secondary text explaining what quick create will do. |

```typescript
quickCreateConfig(): QuickCreateConfig | undefined {
    return { description: 'Quick create', detail: 'Creates .venv with pip' };
}
```

#### `EnvironmentChangeKind`

String enum describing a discovery change.

| Member | Value | Description |
| --- | --- | --- |
| `EnvironmentChangeKind.add` | `'add'` | An environment became known. |
| `EnvironmentChangeKind.remove` | `'remove'` | An environment is no longer known. |

#### `DidChangeEnvironmentsEventArgs`

Payload of [`onDidChangeEnvironments`](#ondidchangeenvironments). This is an
**array**; each element describes one discovery change.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | [`EnvironmentChangeKind`](#environmentchangekind) | Yes | Whether the environment was added or removed. |
| `environment` | [`PythonEnvironment`](#pythonenvironment) | Yes | The environment that was added or removed. |

```typescript
api.onDidChangeEnvironments((changes) => {
    for (const { kind, environment } of changes) {
        console.log(kind, environment.displayName);
    }
});
```

#### `DidChangeEnvironmentEventArgs`

Payload of [`onDidChangeEnvironment`](#ondidchangeenvironment), fired when the
*selected* environment changes.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `uri` | `Uri \| undefined` | Yes (may be `undefined`) | The scope whose selection changed. `undefined` means the global selection. |
| `old` | `PythonEnvironment \| undefined` | Yes (may be `undefined`) | The previously selected environment, or `undefined` if nothing was selected. |
| `new` | `PythonEnvironment \| undefined` | Yes (may be `undefined`) | The newly selected environment, or `undefined` if the selection was cleared. |

### Environment methods

#### `getEnvironments`

Returns the environments currently known for a scope. It does not trigger
discovery; call [`refreshEnvironments`](#refreshenvironments) for that.

```typescript
getEnvironments(scope: GetEnvironmentsScope): Promise<PythonEnvironment[]>;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `scope` | [`GetEnvironmentsScope`](#scope-types) | Yes | `Uri` for environments associated with a project, folder, or file; `'all'` for every known environment; `'global'` for base installations suitable for creating virtual environments. |

**Returns** `Promise<PythonEnvironment[]>` - possibly empty; never `undefined`.

```typescript
const all = await api.getEnvironments('all');
const bases = await api.getEnvironments('global');
const forProject = await api.getEnvironments(projectUri);
```

#### `refreshEnvironments`

Asks the relevant environment managers to re-discover environments.

```typescript
refreshEnvironments(scope: RefreshEnvironmentsScope): Promise<void>;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `scope` | [`RefreshEnvironmentsScope`](#scope-types) | Yes (may be `undefined`) | `Uri` refreshes discovery for that project or folder; `undefined` refreshes global and workspace discovery. |

**Returns** `Promise<void>`, resolving when the managers finish discovery.

Read the results with [`getEnvironments`](#getenvironments) once the promise
settles. Do not rely on [`onDidChangeEnvironments`](#ondidchangeenvironments)
to deliver them: that event is optional on `EnvironmentManager`, and
`refreshEnvironments` does not synthesize one, so whether a refresh produces
deltas is up to the provider.

```typescript
await api.refreshEnvironments(undefined);
// Authoritative: read the list rather than waiting for an event.
const refreshed = await api.getEnvironments('all');
```

#### `resolveEnvironment`

Turns an interpreter path or environment folder into a fully populated
`PythonEnvironment`, including `execInfo`.

```typescript
resolveEnvironment(
    context: ResolveEnvironmentContext,
): Promise<PythonEnvironment | undefined>;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `context` | [`ResolveEnvironmentContext`](#scope-types) (`Uri`) | Yes | A `Uri` pointing at a Python executable or at an environment folder. |

**Returns** `Promise<PythonEnvironment | undefined>` - `undefined` when no
manager recognizes the URI.

```typescript
const env = await api.resolveEnvironment(
    vscode.Uri.file('/usr/local/bin/python3.12'),
);
```

> [!IMPORTANT]
> `ResolveEnvironmentContext` is `Uri` only. Even though nearby source comments
> mention environments, the exported signature does not accept a
> `PythonEnvironment`. Pass `env.environmentPath` if you have an environment
> and want it re-resolved.

#### `getEnvironment`

Reads the environment currently selected for a scope.

```typescript
getEnvironment(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined>;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `scope` | [`GetEnvironmentScope`](#scope-types) | Yes (may be `undefined`) | `Uri` of a project, folder, or file to read the selection for; `undefined` reads the global selection. |

**Returns** `Promise<PythonEnvironment | undefined>` - `undefined` when nothing
is selected for the scope.

```typescript
const active = await api.getEnvironment(
    vscode.window.activeTextEditor?.document.uri,
);
```

> [!IMPORTANT]
> **This call can return a stale value.** It is deliberately non-blocking: it
> races the real resolution against a one-second timeout so that slow initial
> discovery cannot stall callers. If resolution has not finished in time, it
> returns the *last-known* environment for the scope - which may be `undefined`
> on a first call - while resolution continues in the background.
>
> The resolved value is published through
> [`onDidChangeEnvironment`](#ondidchangeenvironment) once it settles. If your
> feature needs the authoritative selection, subscribe to that event and treat
> the value from `getEnvironment` as a fast first guess:
>
> ```typescript
> let current = await api.getEnvironment(projectUri); // May be last-known.
> context.subscriptions.push(
>     api.onDidChangeEnvironment((e) => {
>         if (e.uri?.toString() === projectUri.toString()) {
>             current = e.new; // Authoritative once resolution settles.
>         }
>     }),
> );
> ```

#### `setEnvironment`

Selects - or clears - the environment for one or more scopes, and persists the
selection.

```typescript
setEnvironment(
    scope: SetEnvironmentScope,
    environment?: PythonEnvironment,
): Promise<void>;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `scope` | [`SetEnvironmentScope`](#scope-types) | Yes (may be `undefined`) | `Uri` or `Uri[]` for the projects to update; `undefined` updates the global selection. |
| `environment` | [`PythonEnvironment`](#pythonenvironment) | No | The environment to select. Omit it to clear the selection for the scope. |

**Returns** `Promise<void>`. Fires
[`onDidChangeEnvironment`](#ondidchangeenvironment).

```typescript
await api.setEnvironment(projectUri, env);
await api.setEnvironment(projectUri); // clear
```

#### `createEnvironment`

Creates an environment using the environment manager associated with the scope.

```typescript
createEnvironment(
    scope: CreateEnvironmentScope,
    options?: CreateEnvironmentOptions,
): Promise<PythonEnvironment | undefined>;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `scope` | [`CreateEnvironmentScope`](#scope-types) | Yes | `Uri` or `Uri[]` for the projects the environment is created for; `'global'` creates one outside any project. |
| `options` | [`CreateEnvironmentOptions`](#createenvironmentoptions) | No | Controls prompting (`quickCreate`) and extra packages (`additionalPackages`). |

**Returns** `Promise<PythonEnvironment | undefined>` - `undefined` when no
environment was created, for example because the user cancelled the flow.
Rejects when no environment manager is registered for the scope, when the
manager does not support creation, or when creation itself fails - so handle
errors as well as `undefined`.

```typescript
const created = await api.createEnvironment(projectUri, {
    quickCreate: true,
    additionalPackages: ['requests'],
});
if (created) {
    await api.setEnvironment(projectUri, created);
}
```

> [!NOTE]
> Creation is not guaranteed to select the new environment. Call
> [`setEnvironment`](#setenvironment) if your feature depends on it being
> active.

#### `removeEnvironment`

Removes an environment through its owning manager.

```typescript
removeEnvironment(
    environment: PythonEnvironment,
    options?: RemoveEnvironmentOptions,
): Promise<void>;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `environment` | [`PythonEnvironment`](#pythonenvironment) | Yes | The environment to remove. Its `envId.managerId` must belong to a registered manager, so pass an environment the API returned. |
| `options` | [`RemoveEnvironmentOptions`](#removeenvironmentoptions) | No | Set `runHeadless: true` to skip the confirmation prompt. |

**Returns** `Promise<void>`, resolving when removal completes. Rejects when the
manager fails to remove the environment.

```typescript
await api.removeEnvironment(env, { runHeadless: true });
```

> [!WARNING]
> Removal is defined by the owning manager and is usually destructive - for a
> local virtual environment it deletes the environment from disk. Only pass
> `runHeadless: true` when the user has already agreed, or in automated tests.

#### `createPythonEnvironmentItem`

Converts a provider's descriptive info into an identified `PythonEnvironment`.
Synchronous, and intended for environment manager implementations.

```typescript
createPythonEnvironmentItem(
    info: PythonEnvironmentInfo,
    manager: EnvironmentManager,
): PythonEnvironment;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `info` | [`PythonEnvironmentInfo`](#pythonenvironmentinfo) | Yes | Descriptive details of the environment, including `execInfo` and `sysPrefix`. |
| `manager` | [`EnvironmentManager`](#environmentmanager) | Yes | The manager that owns the environment; supplies `managerId` in the resulting `envId`. |

**Returns** [`PythonEnvironment`](#pythonenvironment) with a valid `envId`.

```typescript
const env = api.createPythonEnvironmentItem(info, this);
```

#### `onDidChangeEnvironments`

Fires when environments are discovered or removed.

```typescript
onDidChangeEnvironments: Event<DidChangeEnvironmentsEventArgs>;
```

| Payload | Type | Description |
| --- | --- | --- |
| `e` | [`DidChangeEnvironmentsEventArgs`](#didchangeenvironmentseventargs) | Array of `{ kind, environment }` entries describing each change. |

**Returns** a `Disposable` from the subscription; add it to
`context.subscriptions`.

```typescript
context.subscriptions.push(
    api.onDidChangeEnvironments((changes) => {
        for (const change of changes) {
            console.log(change.kind, change.environment.displayName);
        }
    }),
);
```

#### `onDidChangeEnvironment`

Fires when the selected environment changes for a project, folder, file, or the
global scope.

```typescript
onDidChangeEnvironment: Event<DidChangeEnvironmentEventArgs>;
```

| Payload | Type | Description |
| --- | --- | --- |
| `e` | [`DidChangeEnvironmentEventArgs`](#didchangeenvironmenteventargs) | `{ uri, old, new }` describing the scope and the selection transition. |

**Returns** a `Disposable` from the subscription.

```typescript
context.subscriptions.push(
    api.onDidChangeEnvironment((e) => {
        console.log(e.uri?.fsPath ?? 'global', '->', e.new?.displayName);
    }),
);
```

## Packages

Package methods read and change what is installed in an environment. Packages
are supplied by package managers (pip, conda, uv, and any manager contributed
by another extension) and are identified by `pkgId`.

### Package data types

#### `PackageId`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | Yes | Unique identifier of the package within its manager and environment. |
| `managerId` | `string` | Yes | Identifier of the package manager that reported the package. |
| `environmentId` | `string` | Yes | Identifier of the environment the package is installed in. |

#### `PackageInfo`

The descriptive payload of a package. Providers build this and pass it to
[`createPackageItem`](#createpackageitem).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Distribution name, for example `requests`. |
| `displayName` | `string` | Yes | Name shown in the packages view. |
| `version` | `string` | No | Installed version, when the manager can report one. |
| `description` | `string` | No | Summary text shown next to the package. |
| `tooltip` | `string \| MarkdownString` | No | Hover text for the package. |
| `iconPath` | [`IconPath`](#iconpath) | No | Icon shown for the package. |
| `uris` | `readonly Uri[]` | No | Related locations, such as the installed distribution folder. |
| `isTransitive` | `boolean` | No | `true` when the package was pulled in as a dependency rather than requested directly. |

```typescript
const info: PackageInfo = {
    name: 'requests',
    displayName: 'requests',
    version: '2.31.0',
    description: 'HTTP for Humans',
};
```

#### `Package`

`PackageInfo` plus its identity; this is what `getPackages` returns.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `pkgId` | [`PackageId`](#packageid) | Yes | Identity of the package. Use this - there is no `id` property. |
| *(inherited)* | [`PackageInfo`](#packageinfo) | - | All descriptive fields listed above. |

#### `GetPackagesOptions`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `skipCache` | `boolean` | No | `true` bypasses the cache and queries the underlying tool. Defaults to `false`. |

#### `PackageManagementInteractionOptions`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `runHeadless` | `boolean` | No | `true` runs without prompts and uses only the packages given in the options. Steps that would normally prompt - such as asking which packages to install - are skipped. Defaults to `false`. |

#### `PackageManagementOptions`

An intersection of
[`PackageManagementInteractionOptions`](#packagemanagementinteractionoptions)
with a union that requires **at least one** of `install` or `uninstall`. A
literal with neither does not compile.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `install` | `string[]` | Conditional | Requirement specifiers to install. Required unless `uninstall` is provided. |
| `uninstall` | `string[]` | Conditional | Package names to uninstall. Required unless `install` is provided. |
| `upgrade` | `boolean` | No | `true` upgrades packages that are already installed. |
| `showSkipOption` | `boolean` | No | `true` offers the user a way to skip the operation. |
| `runHeadless` | `boolean` | No | Inherited interaction flag; `true` suppresses all prompts. |

```typescript
// Valid: install only
const a: PackageManagementOptions = { install: ['requests'] };
// Valid: uninstall only
const b: PackageManagementOptions = { uninstall: ['requests'] };
// Valid: both, headless
const c: PackageManagementOptions = {
    install: ['httpx'],
    uninstall: ['requests'],
    runHeadless: true,
};
// Does not compile: neither install nor uninstall
// const d: PackageManagementOptions = { upgrade: true };
```

#### `GetPackageAvailableVersionsOptions`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `errorMode` | `'legacy' \| 'throw'` | No | `'legacy'` (the default) resolves to `undefined` for both unsupported lookups and operational failures. `'throw'` rejects with `PackageVersionLookupNotSupportedError` when lookup is unsupported and lets operational failures propagate unchanged. |

> [!TIP]
> Prefer `{ errorMode: 'throw' }`. `'legacy'` is kept for backward
> compatibility and may be removed in a future major version, and it cannot
> distinguish "not supported" from "the network failed".

#### `Pep440Version`

Re-exported from `@renovatebot/pep440`. Represents a parsed PEP 440 version,
returned by `getPackageAvailableVersions` and by a package manager's
`getVersion`. Import it from `@vscode/python-environments` so your types match
the API exactly.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `public` | `string` | Yes | The normalized version string, for example `2.31.0`. This is the field to display or feed back into a specifier - `Pep440Version` is a plain data object, so `toString()` yields `[object Object]`. |
| `base_version` | `string` | Yes | The release segment only, with pre/post/dev/local parts stripped. |
| `is_prerelease` | `boolean` | Yes | `true` for alpha, beta, release-candidate, and dev versions. |
| `is_devrelease` | `boolean` | Yes | `true` when the version carries a `.devN` segment. |
| `is_postrelease` | `boolean` | Yes | `true` when the version carries a `.postN` segment. |
| `epoch` | `number` | Yes | PEP 440 epoch; `0` unless the project has reset its versioning scheme. |
| `release` | `number[]` | Yes | Release segment components, for example `[2, 31, 0]`. |
| `pre` | `(string \| number)[]` | Yes | Pre-release segment, for example `['rc', 1]`; empty when absent. |
| `post` | `(string \| number)[]` | Yes | Post-release segment; empty when absent. |
| `dev` | `(string \| number)[]` | Yes | Development-release segment; empty when absent. |
| `local` | `string \| null` | Yes | Local version label, or `null` when absent. |

```typescript
// Show the newest non-prerelease version, if the manager returned any.
const stable = versions.find((v) => !v.is_prerelease);
console.log(stable?.public ?? 'no stable release found');
```

#### `PackageChangeKind`

| Member | Value | Description |
| --- | --- | --- |
| `PackageChangeKind.add` | `'add'` | A package was installed. |
| `PackageChangeKind.remove` | `'remove'` | A package was uninstalled. |

#### `DidChangePackagesEventArgs`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `environment` | [`PythonEnvironment`](#pythonenvironment) | Yes | The environment whose packages changed. |
| `manager` | [`PackageManager`](#packagemanager) | Yes | The package manager that reported the change. |
| `changes` | `{ kind: PackageChangeKind; pkg: Package }[]` | Yes | One entry per changed package. |

### Package methods

#### `getPackages`

Returns the packages installed in an environment.

```typescript
getPackages(
    environment: PythonEnvironment,
    options?: GetPackagesOptions,
): Promise<Package[] | undefined>;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `environment` | [`PythonEnvironment`](#pythonenvironment) | Yes | The environment to inspect. |
| `options` | [`GetPackagesOptions`](#getpackagesoptions) | No | Set `skipCache: true` to bypass the cache. |

**Returns** `Promise<Package[] | undefined>`. `undefined` means the manager
could not produce a list - for example no package manager is associated with
the environment - which is different from an empty array meaning "nothing
installed".

```typescript
const packages = await api.getPackages(env);
if (packages === undefined) {
    // Package listing unavailable for this environment.
} else {
    const direct = packages.filter((p) => !p.isTransitive);
}
```

#### `refreshPackages`

Forces the package manager to re-read the installed package list.

```typescript
refreshPackages(environment: PythonEnvironment): Promise<void>;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `environment` | [`PythonEnvironment`](#pythonenvironment) | Yes | The environment whose package list should be refreshed. |

**Returns** `Promise<void>`. Changes surface through
[`onDidChangePackages`](#ondidchangepackages).

```typescript
// Packages were installed outside the extension - re-read the list.
await api.refreshPackages(env);
const packages = await api.getPackages(env);
```

#### `managePackages`

Installs, upgrades, and uninstalls packages in one call.

```typescript
managePackages(
    environment: PythonEnvironment,
    options: PackageManagementOptions,
): Promise<void>;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `environment` | [`PythonEnvironment`](#pythonenvironment) | Yes | The environment to modify. |
| `options` | [`PackageManagementOptions`](#packagemanagementoptions) | Yes | Must specify `install`, `uninstall`, or both. Also carries `upgrade`, `showSkipOption`, and `runHeadless`. |

**Returns** `Promise<void>`, resolving when the operation finishes. Rejects if
the underlying tool fails.

```typescript
await api.managePackages(env, {
    install: ['requests', 'rich'],
    uninstall: ['obsolete-package'],
    upgrade: true,
});
```

> [!NOTE]
> Plain package names are the portable choice. Version pinning syntax belongs to
> the package manager - `requests==2.31.0` is pip's format, and conda and others
> differ. A manager that implements `formatInstallSpec` produces the right
> string for its own tool; do not assume `name==version`.

#### `getPackageAvailableVersions`

Looks up the versions available for a package, newest first.

```typescript
// Overload 1 - recommended
getPackageAvailableVersions(
    environment: PythonEnvironment,
    packageName: string,
    options: GetPackageAvailableVersionsOptions & { errorMode: 'throw' },
): Promise<Pep440Version[]>;

// Overload 2 - legacy default
getPackageAvailableVersions(
    environment: PythonEnvironment,
    packageName: string,
    options?: GetPackageAvailableVersionsOptions,
): Promise<Pep440Version[] | undefined>;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `environment` | [`PythonEnvironment`](#pythonenvironment) | Yes | Environment context for the lookup; determines which package manager answers. |
| `packageName` | `string` | Yes | Name of the package to look up. |
| `options` | [`GetPackageAvailableVersionsOptions`](#getpackageavailableversionsoptions) | No (overload 2) / Yes (overload 1) | Pass `{ errorMode: 'throw' }` to select the first overload and get error-mode reporting. |

**Returns**

| Call form | Return type | Failure behavior |
| --- | --- | --- |
| `{ errorMode: 'throw' }` | `Promise<Pep440Version[]>` | Rejects with `PackageVersionLookupNotSupportedError` when unsupported; operational errors propagate unchanged. |
| Omitted or `{ errorMode: 'legacy' }` | `Promise<Pep440Version[] \| undefined>` | Resolves to `undefined` for both unsupported lookups and operational failures. |

```typescript
import { isPackageVersionLookupNotSupportedError } from '@vscode/python-environments';

try {
    const versions = await api.getPackageAvailableVersions(env, 'requests', {
        errorMode: 'throw',
    });
    // The array can be empty, and `Pep440Version` is a data object - read `public`.
    const newest = versions[0]?.public;
    if (newest) {
        void vscode.window.showInformationMessage(`Newest requests: ${newest}`);
    }
} catch (error) {
    if (isPackageVersionLookupNotSupportedError(error)) {
        // Fall back to manual version entry.
    } else {
        throw error; // Real failure: surface it.
    }
}
```

> [!IMPORTANT]
> Do not paste a returned version straight into an `install` entry. The
> specifier syntax belongs to the package manager - `name==version` is pip's
> format, not a universal one. A manager that implements `formatInstallSpec`
> builds the correct string for its own tool.

#### `createPackageItem`

Converts a provider's descriptive info into an identified `Package`.
Synchronous, and intended for package manager implementations.

```typescript
createPackageItem(
    info: PackageInfo,
    environment: PythonEnvironment,
    manager: PackageManager,
): Package;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `info` | [`PackageInfo`](#packageinfo) | Yes | Descriptive details of the package. |
| `environment` | [`PythonEnvironment`](#pythonenvironment) | Yes | The environment the package is installed in; supplies `environmentId`. |
| `manager` | [`PackageManager`](#packagemanager) | Yes | The reporting package manager; supplies `managerId`. |

**Returns** [`Package`](#package) with a valid `pkgId`.

```typescript
// Inside a PackageManager implementation:
const pkg = api.createPackageItem(
    { name: 'requests', displayName: 'requests', version: '2.31.0' },
    environment,
    this,
);
```

#### `onDidChangePackages`

Fires when packages are installed or removed.

```typescript
onDidChangePackages: Event<DidChangePackagesEventArgs>;
```

| Payload | Type | Description |
| --- | --- | --- |
| `e` | [`DidChangePackagesEventArgs`](#didchangepackageseventargs) | The environment, the reporting manager, and the list of `{ kind, pkg }` changes. |

**Returns** a `Disposable` from the subscription.

```typescript
context.subscriptions.push(
    api.onDidChangePackages((e) => {
        console.log(e.environment.displayName, e.changes.length);
    }),
);
```

### Package errors

#### `PackageVersionLookupNotSupportedError`

Thrown when a package manager cannot list available versions at all. It
separates an *unsupported capability* from an *operational failure* such as a
failed command, a network error, or unparseable output.

| Member | Type | Required | Description |
| --- | --- | --- | --- |
| `code` | `'PackageVersionLookupNotSupported'` | Yes | Stable discriminator that survives bundle boundaries. Declared `readonly`. |
| `name` | `string` | Yes | Inherited from `Error`. Its runtime value is set to `'PackageVersionLookupNotSupportedError'`, but its static type stays `string`, so do not assign it to a string-literal type. |
| `message` | `string` | Yes | Inherited from `Error`. Defaults to an explanation that version lookup is unsupported. |

Providers throw it with `new PackageVersionLookupNotSupportedError(message?)`;
the single `message` parameter is optional.

```typescript
import { PackageVersionLookupNotSupportedError } from '@vscode/python-environments';

// Inside a PackageManager implementation:
async getPackageAvailableVersions(): Promise<Pep440Version[]> {
    throw new PackageVersionLookupNotSupportedError();
}
```

#### `isPackageVersionLookupNotSupportedError`

```typescript
isPackageVersionLookupNotSupportedError(
    error: unknown,
): error is PackageVersionLookupNotSupportedError;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `error` | `unknown` | Yes | The caught value to test. |

**Returns** `boolean` (a type guard). Checks the stable `code` discriminator, so
it still returns `true` when the error crossed an extension bundle boundary.

> [!IMPORTANT]
> Always use this guard instead of `instanceof`. Each extension bundle can load
> its own copy of the error class, so `instanceof` can return `false` for an
> error that is semantically the right one.

## Projects

A project is anything that can own a Python environment: a workspace folder, a
subfolder, or even a single PEP 723 script. Every
`vscode.workspace.workspaceFolders` entry is a project by default.

### Project data types

#### `PythonProject`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Display name of the project. |
| `uri` | `Uri` | Yes | Root folder, or the file for file-based projects. Used to match a project to a file. |
| `description` | `string` | No | Secondary text shown next to the project. |
| `tooltip` | `string \| MarkdownString` | No | Hover text for the project. |

```typescript
const project: PythonProject = {
    name: 'service-api',
    uri: vscode.Uri.file('/home/me/code/app/service-api'),
    description: 'FastAPI service',
};
```

#### `PythonProjectCreatorOptions`

Passed to a [`PythonProjectCreator`](#pythonprojectcreator).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Name for the project being created. |
| `rootUri` | `Uri` | Yes | Folder to use as the project root. |
| `quickCreate` | `boolean` | No | `true` requires creation to complete without any user input. |

#### `DidChangePythonProjectsEventArgs`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `added` | `PythonProject[]` | Yes | Projects added in this change. May be empty. |
| `removed` | `PythonProject[]` | Yes | Projects removed in this change. May be empty. |

### Project methods

#### `getPythonProjects`

Returns every project the extension currently tracks. Synchronous.

```typescript
getPythonProjects(): readonly PythonProject[];
```

Takes no parameters.

**Returns** `readonly PythonProject[]` - a snapshot; re-read it after
[`onDidChangePythonProjects`](#ondidchangepythonprojects) rather than caching.

```typescript
for (const project of api.getPythonProjects()) {
    console.log(project.name, project.uri.fsPath);
}
```

#### `getPythonProject`

Finds the project that owns a URI. Synchronous.

```typescript
getPythonProject(uri: Uri): PythonProject | undefined;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `uri` | `Uri` | Yes | A file or folder URI. The extension resolves the owning project, so a file inside a project resolves to that project. |

**Returns** `PythonProject | undefined` - `undefined` when the URI is not inside
any known project.

```typescript
const doc = vscode.window.activeTextEditor?.document;
const project = doc ? api.getPythonProject(doc.uri) : undefined;
```

#### `addPythonProject`

Adds one or more projects to the tracked collection. Synchronous.

```typescript
addPythonProject(projects: PythonProject | PythonProject[]): void;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `projects` | `PythonProject \| PythonProject[]` | Yes | The project or projects to track. Each needs at least `name` and `uri`. |

**Returns** `void`. Fires
[`onDidChangePythonProjects`](#ondidchangepythonprojects) with the additions.

```typescript
api.addPythonProject({
    name: 'tools',
    uri: vscode.Uri.joinPath(workspaceFolder.uri, 'tools'),
});
```

#### `removePythonProject`

Stops tracking a project. Synchronous.

```typescript
removePythonProject(project: PythonProject): void;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project` | [`PythonProject`](#pythonproject) | Yes | The project to remove. Obtain it from `getPythonProjects` or `getPythonProject` so it matches a tracked entry. |

**Returns** `void`. Fires
[`onDidChangePythonProjects`](#ondidchangepythonprojects) with the removal.

Removing a project stops environment tracking for it; it does not delete
anything on disk.

```typescript
const project = api.getPythonProject(projectUri);
if (project) {
    api.removePythonProject(project);
}
```

#### `onDidChangePythonProjects`

Fires when projects are added or removed.

```typescript
onDidChangePythonProjects: Event<DidChangePythonProjectsEventArgs>;
```

| Payload | Type | Description |
| --- | --- | --- |
| `e` | [`DidChangePythonProjectsEventArgs`](#didchangepythonprojectseventargs) | `{ added, removed }` arrays for this change. |

**Returns** a `Disposable` from the subscription.

```typescript
context.subscriptions.push(
    api.onDidChangePythonProjects((e) => {
        console.log('added', e.added.length, 'removed', e.removed.length);
    }),
);
```

## Execution

Execution methods take an environment and use its
[`PythonEnvironmentExecutionInfo`](#pythonenvironmentexecutioninfo) - including
its activation commands, where the method applies them - so you do not have to
assemble activation yourself. Choose a method by where the output should go: a
terminal the user watches, a VS Code task, or a background process you read
programmatically.

### Execution data types

#### `PythonCommandRunConfiguration`

A single command to execute.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `executable` | `string` | Yes | Absolute path to a spawnable binary, such as `python.exe` or `python3`. |
| `args` | `string[]` | No | Arguments passed on every execution of this command, for interpreter-specific flags. |

#### `PythonEnvironmentExecutionInfo`

Tells the extension how to run and activate an environment. Providers must
populate at least `run`.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `run` | [`PythonCommandRunConfiguration`](#pythoncommandrunconfiguration) | Yes | Base command used to run Python. |
| `activatedRun` | `PythonCommandRunConfiguration` | No | Command used to run Python *after* the environment has been activated. When set, it overrides `run`. |
| `activation` | `PythonCommandRunConfiguration[]` | No | Shell-agnostic commands that activate the environment. |
| `shellActivation` | `Map<string, PythonCommandRunConfiguration[]>` | No | Shell-specific activation keyed by shell type, with `'unknown'` as the fallback key. Overrides `activation`. |
| `deactivation` | `PythonCommandRunConfiguration[]` | No | Shell-agnostic commands that deactivate the environment. |
| `shellDeactivation` | `Map<string, PythonCommandRunConfiguration[]>` | No | Shell-specific deactivation keyed by shell type, with `'unknown'` as the fallback key. Overrides `deactivation`. |

Resolution order when running in a terminal:

1. `activatedRun`, if present.
2. Otherwise `shellActivation` for the detected shell; if the shell is unknown,
   the `'unknown'` entry, then `activation`.
3. Otherwise `activation`.
4. Otherwise `run`.

```typescript
const execInfo: PythonEnvironmentExecutionInfo = {
    run: { executable: '/home/me/app/.venv/bin/python' },
    activation: [
        { executable: 'source', args: ['/home/me/app/.venv/bin/activate'] },
    ],
    shellActivation: new Map([
        ['pwsh', [{ executable: '/home/me/app/.venv/bin/Activate.ps1' }]],
    ]),
};
```

#### `PythonTerminalCreateOptions`

Extends [`vscode.TerminalOptions`](https://code.visualstudio.com/api/references/vscode-api#TerminalOptions),
so every standard terminal option - `name`, `cwd`, `env`, `hideFromUser`, and
the rest - is available alongside the field below.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `disableActivation` | `boolean` | No | `true` creates the terminal without running activation commands. |
| *(inherited)* | [`vscode.TerminalOptions`](https://code.visualstudio.com/api/references/vscode-api#TerminalOptions) | - | See the VS Code API reference for the full list and their defaults. |

#### `PythonTerminalExecutionOptions`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cwd` | `string \| Uri` | Yes | Working directory. Used only when the terminal is created. |
| `args` | `string[]` | No | Arguments passed to the Python executable. |
| `show` | `boolean` | No | `true` reveals the terminal. |

```typescript
// python myscript.py --arg1
const script: PythonTerminalExecutionOptions = {
    cwd: projectUri,
    args: ['myscript.py', '--arg1'],
    show: true,
};

// python -m my_module --arg1
const module: PythonTerminalExecutionOptions = {
    cwd: projectUri,
    args: ['-m', 'my_module', '--arg1'],
};
```

#### `PythonTaskExecutionOptions`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Name of the task, shown in the task UI. |
| `args` | `string[]` | Yes | Arguments passed to the Python executable. |
| `project` | [`PythonProject`](#pythonproject) | No | Project the task belongs to. |
| `cwd` | `string` | No | Working directory for the task's shell execution. When omitted, VS Code resolves it from the task scope - the workspace folder containing `project`, or the global scope when `project` is not supplied. |
| `env` | `{ [key: string]: string }` | No | Additional environment variables for the task. |

#### `PythonBackgroundRunOptions`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `args` | `string[]` | Yes | Arguments passed to the Python executable. |
| `cwd` | `string` | No | Working directory, passed straight to the spawned process. When omitted, the process inherits the extension host's working directory, which is **not** your project folder - always supply `cwd` (for example `project.uri.fsPath`) if the script resolves relative paths. |
| `env` | `{ [key: string]: string \| undefined }` | No | Additional environment variables. An `undefined` value unsets a variable. |

#### `PythonProcess`

Returned by [`runInBackground`](#runinbackground).

| Member | Type | Required | Description |
| --- | --- | --- | --- |
| `pid` | `number` | No | Process ID, when available. |
| `stdin` | `NodeJS.WritableStream` | Yes | Standard input stream. |
| `stdout` | `NodeJS.ReadableStream` | Yes | Standard output stream. |
| `stderr` | `NodeJS.ReadableStream` | Yes | Standard error stream. |
| `kill()` | `() => void` | Yes | Terminates the process. |
| `onExit(listener)` | `(listener: (code: number \| null, signal: NodeJS.Signals \| null) => void) => void` | Yes | Registers an exit listener receiving the exit code and signal. |

### Execution methods

#### `createTerminal`

Creates a terminal with the environment activated, without running anything.

```typescript
createTerminal(
    environment: PythonEnvironment,
    options: PythonTerminalCreateOptions,
): Promise<Terminal>;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `environment` | [`PythonEnvironment`](#pythonenvironment) | Yes | Environment to activate in the new terminal. |
| `options` | [`PythonTerminalCreateOptions`](#pythonterminalcreateoptions) | Yes | Standard terminal options plus `disableActivation`. |

**Returns** `Promise<vscode.Terminal>`.

```typescript
const terminal = await api.createTerminal(env, {
    name: 'My Extension',
    cwd: projectUri,
});
terminal.show();
```

Environments that cannot be activated simply produce a normal terminal.

#### `runInTerminal`

Runs Python in a shared terminal, creating one if needed.

```typescript
runInTerminal(
    environment: PythonEnvironment,
    options: PythonTerminalExecutionOptions,
): Promise<Terminal>;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `environment` | [`PythonEnvironment`](#pythonenvironment) | Yes | Environment used to run the command. |
| `options` | [`PythonTerminalExecutionOptions`](#pythonterminalexecutionoptions) | Yes | `cwd` plus the `args` to pass to Python and whether to `show` the terminal. |

**Returns** `Promise<vscode.Terminal>` - the terminal the command was sent to.

```typescript
await api.runInTerminal(env, {
    cwd: projectUri,
    args: ['-m', 'pytest', '-q'],
    show: true,
});
```

Terminal reuse has limits imposed by VS Code: reloading the window or closing
the terminal creates a new one, and multi-root or multi-project scenarios get
one terminal per project.

#### `runInDedicatedTerminal`

Like `runInTerminal`, but keeps a terminal per key so repeated runs reuse the
same one.

```typescript
runInDedicatedTerminal(
    terminalKey: Uri | string,
    environment: PythonEnvironment,
    options: PythonTerminalExecutionOptions,
): Promise<Terminal>;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `terminalKey` | `Uri \| string` | Yes | Stable key identifying the dedicated terminal. Use the script's `Uri` for per-script terminals, or a string for a logical channel. |
| `environment` | [`PythonEnvironment`](#pythonenvironment) | Yes | Environment used to run the command. |
| `options` | [`PythonTerminalExecutionOptions`](#pythonterminalexecutionoptions) | Yes | `cwd`, `args`, and `show`. |

**Returns** `Promise<vscode.Terminal>` - the dedicated terminal for the key.

```typescript
await api.runInDedicatedTerminal(scriptUri, env, {
    cwd: projectUri,
    args: [scriptUri.fsPath],
    show: true,
});
```

#### `runAsTask`

Runs Python as a VS Code task, so output appears in the task terminal and
problem matchers apply.

```typescript
runAsTask(
    environment: PythonEnvironment,
    options: PythonTaskExecutionOptions,
): Promise<TaskExecution>;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `environment` | [`PythonEnvironment`](#pythonenvironment) | Yes | Environment used to run the task. |
| `options` | [`PythonTaskExecutionOptions`](#pythontaskexecutionoptions) | Yes | Task `name` and `args`, plus optional `project`, `cwd`, and `env`. |

**Returns** `Promise<vscode.TaskExecution>` - use it to observe or terminate the
task.

```typescript
const execution = await api.runAsTask(env, {
    name: 'Run tests',
    args: ['-m', 'pytest'],
    project,
});
```

#### `runInBackground`

Starts a Python process you control programmatically.

```typescript
runInBackground(
    environment: PythonEnvironment,
    options: PythonBackgroundRunOptions,
): Promise<PythonProcess>;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `environment` | [`PythonEnvironment`](#pythonenvironment) | Yes | Environment used to start the process. |
| `options` | [`PythonBackgroundRunOptions`](#pythonbackgroundrunoptions) | Yes | `args` for Python, plus optional `cwd` and `env`. Supply `cwd` - it is not inferred. |

**Returns** `Promise<PythonProcess>` with `stdin`, `stdout`, `stderr`, `kill()`,
and `onExit()`.

> [!IMPORTANT]
> `cwd` is forwarded to the spawned process unchanged. There is no project
> context to infer it from, so when you omit it the process inherits the
> extension host's working directory rather than your project folder. Pass
> `cwd` explicitly whenever the script resolves relative paths.
>
> You own the process lifetime: call `kill()` when your feature is done, and
> tie it to your disposables so it does not outlive deactivation.

```typescript
const proc = await api.runInBackground(env, {
    args: ['-c', 'import sys; print(sys.version)'],
    cwd: projectUri.fsPath,
});

proc.stdout.on('data', (chunk) => console.log(String(chunk)));
proc.stderr.on('data', (chunk) => console.error(String(chunk)));
proc.onExit((code) => console.log('exited with', code));
```

> [!IMPORTANT]
> You own the process lifetime. Always attach an `onExit` handler and call
> `kill()` when your extension deactivates or the work is cancelled, otherwise
> processes can outlive the window.

## Environment variables

These methods resolve the variables Python should run with for a scope,
including `.env` files the extension monitors.

### Environment variable data types

#### `DidChangeEnvironmentVariablesEventArgs`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `uri` | `Uri` | No | The file that changed. Absent when a non-file source changed. |
| `changeType` | `vscode.FileChangeType` | Yes | Whether the source was created, changed, or deleted. |

### Environment variable methods

#### `getEnvironmentVariables`

Resolves the effective environment variables for a scope.

```typescript
getEnvironmentVariables(
    uri: Uri | undefined,
    overrides?: ({ [key: string]: string | undefined } | Uri)[],
    baseEnvVar?: { [key: string]: string | undefined },
): Promise<{ [key: string]: string | undefined }>;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `uri` | `Uri \| undefined` | Yes (may be `undefined`) | Project, workspace, or file to resolve variables for. `undefined` resolves the global scope. |
| `overrides` | `({ [key: string]: string \| undefined } \| Uri)[]` | No | Additional sources applied in array order. A plain object contributes its entries; a `Uri` is read as an `.env` file. |
| `baseEnvVar` | `{ [key: string]: string \| undefined }` | No | Starting set of variables. Defaults to `process.env`. |

**Returns** `Promise<{ [key: string]: string | undefined }>` - the merged
result. An `undefined` value means the variable is unset.

Precedence, lowest to highest:

1. `baseEnvVar` if provided, otherwise `process.env`.
2. The `.env` file named by the `python.envFile` setting for the workspace.
3. The `.env` file at the root of the Python project.
4. Each entry in `overrides`, in order.

```typescript
const env = await api.getEnvironmentVariables(
    projectUri,
    [vscode.Uri.joinPath(projectUri, '.env.test'), { CI: '1' }],
    process.env,
);
```

#### `onDidChangeEnvironmentVariables`

Fires when a monitored `.env` file or other variable source changes.

```typescript
onDidChangeEnvironmentVariables: Event<DidChangeEnvironmentVariablesEventArgs>;
```

| Payload | Type | Description |
| --- | --- | --- |
| `e` | [`DidChangeEnvironmentVariablesEventArgs`](#didchangeenvironmentvariableseventargs) | `{ uri, changeType }` for the changed source. |

**Returns** a `Disposable` from the subscription. Re-call
`getEnvironmentVariables` to get refreshed values; the event does not carry
them.

```typescript
context.subscriptions.push(
    api.onDidChangeEnvironmentVariables(async (e) => {
        console.log('env source changed', e.uri?.fsPath, e.changeType);
        const refreshed = await api.getEnvironmentVariables(projectUri);
    }),
);
```

## Extensibility

Implement one of these interfaces and register it to contribute your own
environment manager, package manager, or project creator. Registration returns
a `Disposable`; dispose it on deactivation.

### Extensibility data types

#### `EnvironmentManager`

Discovers, creates, removes, and selects environments of one kind. The
extension calls these methods in response to UI actions, startup, terminal
activation, and API calls; treat the documented contract, not any particular
trigger, as the specification.

| Member | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Manager name. Allowed characters: `a-z`, `A-Z`, `0-9`, `-`, `_`. |
| `displayName` | `string` | No | Name shown in the UI. |
| `preferredPackageManagerId` | `string` | Yes | Package manager to pair with, formatted `<publisher>.<extension>:<manager-name>`, for example `ms-python.python:pip`. |
| `description` | `string` | No | Secondary text shown in the UI. |
| `tooltip` | `string \| MarkdownString` | No | Hover text for the manager. |
| `iconPath` | [`IconPath`](#iconpath) | No | Icon shown for the manager. |
| `log` | `LogOutputChannel` | No | Output channel used for the manager's logs. |
| `getEnvironments(scope)` | `(scope: GetEnvironmentsScope) => Promise<PythonEnvironment[]>` | Yes | Returns the environments known for the scope. Called frequently by UI surfaces. |
| `refresh(scope)` | `(scope: RefreshEnvironmentsScope) => Promise<void>` | Yes | Re-discovers environments for the scope. |
| `set(scope, environment?)` | `(scope: SetEnvironmentScope, environment?: PythonEnvironment) => Promise<void>` | Yes | Sets or clears the active environment for the scope. Also called at startup to rehydrate persisted state. |
| `get(scope)` | `(scope: GetEnvironmentScope) => Promise<PythonEnvironment \| undefined>` | Yes | Returns the active environment for the scope. Called very frequently. |
| `resolve(context)` | `(context: ResolveEnvironmentContext) => Promise<PythonEnvironment \| undefined>` | Yes | Turns a `Uri` for an interpreter or environment folder into a fully populated environment with complete `execInfo`. |
| `create(scope, options?)` | `(scope: CreateEnvironmentScope, options?: CreateEnvironmentOptions) => Promise<PythonEnvironment \| undefined>` | No | Creates an environment. Omit the method entirely if creation is unsupported - the UI disables create when `create === undefined`. Add a `.gitignore` when creating a folder inside the workspace. |
| `remove(environment, options?)` | `(environment: PythonEnvironment, options?: RemoveEnvironmentOptions) => Promise<void>` | No | Deletes an environment. |
| `quickCreateConfig()` | `() => QuickCreateConfig \| undefined` | No | Describes the quick create path. Implementing it enables quick create, which requires `create` too. |
| `clearCache()` | `() => Promise<void>` | No | Drops cached environment data so later calls re-discover from disk. |
| `onDidChangeEnvironments` | `Event<DidChangeEnvironmentsEventArgs>` | No | Fire when discovery results change. |
| `onDidChangeEnvironment` | `Event<DidChangeEnvironmentEventArgs>` | No | Fire when the manager's active environment changes. |

```typescript
class MyEnvManager implements EnvironmentManager {
    readonly name = 'my-manager';
    readonly displayName = 'My Manager';
    readonly preferredPackageManagerId = 'ms-python.python:pip';

    constructor(private readonly api: PythonEnvironmentApi) {}

    async getEnvironments(
        scope: GetEnvironmentsScope,
    ): Promise<PythonEnvironment[]> {
        const found = await discover(scope);
        return found.map((info) =>
            this.api.createPythonEnvironmentItem(info, this),
        );
    }

    async refresh(scope: RefreshEnvironmentsScope): Promise<void> {}
    async set(
        scope: SetEnvironmentScope,
        environment?: PythonEnvironment,
    ): Promise<void> {}
    async get(
        scope: GetEnvironmentScope,
    ): Promise<PythonEnvironment | undefined> {
        return undefined;
    }
    async resolve(
        context: ResolveEnvironmentContext,
    ): Promise<PythonEnvironment | undefined> {
        return undefined;
    }
}
```

#### `PackageManager`

Reports and changes the packages of an environment.

| Member | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Manager name. Allowed characters: `a-z`, `A-Z`, `0-9`, `-`, `_`. |
| `displayName` | `string` | No | Name shown in the UI. |
| `description` | `string` | No | Secondary text shown in the UI. |
| `tooltip` | `string \| MarkdownString` | No | Hover text for the manager. |
| `iconPath` | [`IconPath`](#iconpath) | No | Icon shown for the manager. |
| `log` | `LogOutputChannel` | No | Output channel used for the manager's logs. |
| `manage(environment, options)` | `(environment: PythonEnvironment, options: PackageManagementOptions) => Promise<void>` | Yes | Installs and uninstalls the requested packages. |
| `refresh(environment)` | `(environment: PythonEnvironment) => Promise<void>` | Yes | Re-reads the installed package list. |
| `getPackages(environment, options?)` | `(environment: PythonEnvironment, options?: GetPackagesOptions) => Promise<Package[] \| undefined>` | Yes | Returns installed packages, or `undefined` if they cannot be retrieved. |
| `getPackageWatchTargets(environment)` | `(environment: PythonEnvironment) => RelativePattern[]` | No | Extra filesystem patterns to watch for install and uninstall changes, appended to the default site-packages locations. Implement for manager-specific locations such as `conda-meta`. |
| `getDirectPackageNames(environment)` | `(environment: PythonEnvironment) => Promise<Set<string> \| undefined>` | No | Best-effort set of non-transitive package names. Most tools cannot record user intent - pip uses `pip list --not-required`, which reports leaf packages rather than explicitly installed ones. |
| `clearCache()` | `() => Promise<void>` | No | Drops cached package data. |
| `getVersion(environment)` | `(environment: PythonEnvironment) => Promise<Pep440Version \| undefined>` | No | Version of the underlying tool, such as pip, uv, or conda. |
| `getPackageAvailableVersions(environment, packageName)` | `(environment: PythonEnvironment, packageName: string) => Promise<Pep440Version[] \| undefined>` | No | Available versions, newest first. Throw `PackageVersionLookupNotSupportedError` when unsupported and let operational failures propagate. Resolving to `undefined` is treated as unsupported. |
| `formatInstallSpec(packageName, version)` | `(packageName: string, version: string) => string` | No | Formats a pinned specifier for this tool, for example `requests==2.31.0` for pip or `requests=2.31.0` for conda. Callers default to `name==version` when absent. |
| `onDidChangePackages` | `Event<DidChangePackagesEventArgs>` | No | Fire when packages change. |

```typescript
class MyPackageManager implements PackageManager {
    readonly name = 'my-pm';

    constructor(private readonly api: PythonEnvironmentApi) {}

    async manage(
        environment: PythonEnvironment,
        options: PackageManagementOptions,
    ): Promise<void> {
        if (options.install?.length) {
            /* install */
        }
        if (options.uninstall?.length) {
            /* uninstall */
        }
    }

    async refresh(environment: PythonEnvironment): Promise<void> {}

    async getPackages(
        environment: PythonEnvironment,
    ): Promise<Package[] | undefined> {
        const infos = await readInstalled(environment);
        return infos.map((info) =>
            this.api.createPackageItem(info, environment, this),
        );
    }

    async getPackageAvailableVersions(
        environment: PythonEnvironment,
        packageName: string,
    ): Promise<Pep440Version[]> {
        throw new PackageVersionLookupNotSupportedError();
    }

    formatInstallSpec(packageName: string, version: string): string {
        return `${packageName}==${version}`;
    }
}
```

#### `PythonProjectCreator`

Contributes a project-creation flow, such as a template or scaffolding wizard.

| Member | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Creator name. |
| `displayName` | `string` | No | Name shown in the creation picker. |
| `description` | `string` | No | Secondary text shown in the picker. |
| `tooltip` | `string \| MarkdownString` | No | Hover text for the creator. |
| `supportsQuickCreate` | `boolean` | No | `true` when the creator can run with no user input. |
| `create(options?)` | `(options?: PythonProjectCreatorOptions) => Promise<PythonProject \| PythonProject[] \| Uri \| Uri[] \| undefined>` | Yes | Creates the project or files. Return `PythonProject`(s) for real projects, `Uri`(s) for files that do not constitute a project, or `undefined` if creation fails or is cancelled. |

### Extensibility methods

#### `registerEnvironmentManager`

```typescript
registerEnvironmentManager(
    manager: EnvironmentManager,
    options?: { extensionId?: string },
): Disposable;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `manager` | [`EnvironmentManager`](#environmentmanager) | Yes | The manager implementation to register. |
| `options` | `{ extensionId?: string }` | No | Registration options. |
| `options.extensionId` | `string` | No | Extension ID of the calling extension. Detected automatically when omitted or not found. |

**Returns** `Disposable` that unregisters the manager.

```typescript
context.subscriptions.push(
    api.registerEnvironmentManager(new MyEnvManager(api)),
);
```

#### `registerPackageManager`

```typescript
registerPackageManager(
    manager: PackageManager,
    options?: { extensionId?: string },
): Disposable;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `manager` | [`PackageManager`](#packagemanager) | Yes | The package manager implementation to register. |
| `options` | `{ extensionId?: string }` | No | Registration options. |
| `options.extensionId` | `string` | No | Extension ID of the calling extension. Detected automatically when omitted or not found. |

**Returns** `Disposable` that unregisters the manager.

```typescript
context.subscriptions.push(
    api.registerPackageManager(new MyPackageManager(api)),
);
```

To pair your package manager with your environment manager, set
`preferredPackageManagerId` on the environment manager to
`<publisher>.<extension>:<package-manager-name>`.

#### `registerPythonProjectCreator`

```typescript
registerPythonProjectCreator(creator: PythonProjectCreator): Disposable;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `creator` | [`PythonProjectCreator`](#pythonprojectcreator) | Yes | The project creator implementation to register. |

**Returns** `Disposable` that unregisters the creator.

```typescript
context.subscriptions.push(
    api.registerPythonProjectCreator({
        name: 'my-template',
        displayName: 'My Project Template',
        supportsQuickCreate: true,
        async create(options) {
            if (!options) {
                return undefined;
            }
            await scaffold(options.rootUri, options.name);
            return { name: options.name, uri: options.rootUri };
        },
    }),
);
```

## API interface groups

`PythonEnvironmentApi` is assembled from the interfaces below. They exist to
organize the TypeScript declarations only - at runtime every member lives
directly on the single flat API object.

| Interface | Members grouped by the interface | Description |
| --- | --- | --- |
| `PythonEnvironmentsApi` | Environment discovery and resolution | Lists and refreshes discovered environments, resolves environment URIs, and reports discovery changes. |
| `PythonProjectEnvironmentApi` | Selected environment get/set | Reads, updates, and observes the selected environment for URI or global scopes. |
| `PythonEnvironmentManagementApi` | Environment creation/removal | Creates and removes environments through their associated environment managers. |
| `PythonEnvironmentItemApi` | Environment item creation | Converts provider-supplied environment information into an identified `PythonEnvironment`. |
| `PythonEnvironmentManagerRegistrationApi` | Environment manager registration | Registers an `EnvironmentManager` implementation with the extension. |
| `PythonEnvironmentManagerApi` | Combined environment API | Combines environment registration, item creation, lifecycle, discovery, and selection interfaces. |
| `PythonPackageGetterApi` | Package retrieval and version lookup | Retrieves and refreshes packages, looks up available versions, and reports package changes. |
| `PythonPackageManagementApi` | Package installation/removal | Installs, upgrades, or uninstalls packages in an environment. |
| `PythonPackageItemApi` | Package item creation | Converts provider-supplied package information into an identified `Package`. |
| `PythonPackageManagerRegistrationApi` | Package manager registration | Registers a `PackageManager` implementation with the extension. |
| `PythonPackageManagerApi` | Combined package API | Combines package registration, retrieval, management, and item creation interfaces. |
| `PythonProjectGetterApi` | Project lookup | Returns all known projects or the project associated with a URI. |
| `PythonProjectModifyApi` | Project collection modification | Adds, removes, and observes projects in the tracked project collection. |
| `PythonProjectCreationApi` | Project creator registration | Registers a `PythonProjectCreator` implementation. |
| `PythonProjectApi` | Combined project API | Combines project lookup, modification, events, and creator registration interfaces. |
| `PythonTerminalCreateApi` | Terminal creation | Creates a terminal configured for a Python environment. |
| `PythonTerminalRunApi` | Terminal execution | Runs Python in shared or dedicated terminals. |
| `PythonTaskRunApi` | Task execution | Runs Python as a VS Code task. |
| `PythonBackgroundRunApi` | Background execution | Starts Python as a background process with stream and exit access. |
| `PythonExecutionApi` | Combined execution API | Combines terminal creation, terminal execution, task execution, and background execution. |
| `PythonEnvironmentVariablesApi` | Environment variable lookup/events | Resolves effective environment variables and reports source changes. |
| `PythonEnvironmentApi` | Complete flat public API | Combines all environment, package, project, execution, and environment-variable APIs exposed at runtime. |

## Compatibility guidance

- Use only exports from `@vscode/python-environments`; do not import
  `internal.api.ts` or extension implementation modules.
- Declare `ms-python.vscode-python-envs` in `extensionDependencies`.
- Acquire the API through `PythonEnvironments.api()`.
- Remember that the API object is flat.
- Use `env.envId` and `pkg.pkgId`, not `env.id` or `pkg.id`.
- Pass URIs so the API can route project and environment operations.
- Feature-detect optional provider methods before calling them.
- Dispose event subscriptions and provider registrations.
- Preserve operational errors and handle documented `undefined` results.
- Use `isPackageVersionLookupNotSupportedError()` across bundle boundaries.
- Recompile after updating the npm package so TypeScript detects API changes.

The public API is intended to avoid breaking changes. Check
[`api/CHANGELOG.md`](../api/CHANGELOG.md) when updating the package.

## Related documentation

- [`src/api.ts`](../src/api.ts) - runtime API facade
- [`src/types.ts`](../src/types.ts) - authoritative public type contracts
- [`src/publicErrors.ts`](../src/publicErrors.ts) - public errors and type guards
- [`api/README.md`](../api/README.md) - npm package quick start
- [Making and Managing Python Projects](managing-python-projects.md)
- [Projects API Reference](projects-api-reference.md)
- [Python Environments API Design](design.md)
- [Startup Flow](startup-flow.md)
