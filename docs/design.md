
# Python Environments API
The following helps describe the technical design of the Python Environments Extension for use mainly by contributing extension authors. This extension is the entry point which will surface the entire environment management experience for Python in VS Code and its modularity should allow for individual tools / libraries to implement these methods for their tool making them usable in VS Code.


**Table of Contents**
- [Python Environments API](#python-environments-api)
  - [Functionalities of Extension \& its API](#functionalities-of-extension--its-api)
  - [API Surface](#api-surface)
  - [Objects in Extension API](#objects-in-extension-api)
  - [Relationships between API Components](#relationships-between-api-components)
    - [Workspace and Environments](#workspace-and-environments)
    - [EnvironmentManagers and PackageManagers](#environmentmanagers-and-packagemanagers)
    - [Packages and Related Objects](#packages-and-related-objects)
    - [PythonProject and PythonProjectCreator](#pythonproject-and-pythonprojectcreator)
  - [Connection to UI](#connection-to-ui)
    - [Python Side Pane](#python-side-pane)
    - [Copilot Tooling](#copilot-tooling)
    - [Command Palette](#command-palette)
    - [Contributions to File Explorer](#contributions-to-file-explorer)


## Functionalities of Extension & its API
The python environment extension has four main functionalities: 
- getting / setting environments (including the packages found in them)
- terminal activation
- code execution
- project management

## API Surface
- **PythonProjectApi** -> The API for interacting with Python projects. 
- **PythonExecutionApi**
- **PythonEnvironmentApi** -> The API for interacting with Python environments, package 
- **PythonEnvironmentManagerApi**
- **PythonPackageManagerApi**


## Objects in Extension API
The core components are as follows:
- `PythonEnvironment`: a python environment
    - Has unique id and correlates to a `EnvironmentManager` 
    - Contains `PythonEnvironmentExecutionInfo`
- `EnvironmentManager`: an object which manages `PythonEnvironment`
    - registered by an extension in form with id `<publisher-id>.<extension-id>:<manager-name>`
    - acts on an environment (get, set, etc)  `PythonEnvironment`
    - one `EnvironmentManager` can create many `PythonEnvironment` objects
- `PackageManagementOptions`: actions relating to, and specifying packages
- `PackageManager`: an object which manages packages
    - registered by an extension in form with id `<publisher-id>.<extension-id>:<manager-name>`
    - performs actions for packages using `PackageManagementOptions`


## Relationships between API Components
Generally in the extension, the PackageManagers and EnvironmentManagers handle the entry-point for contributing actions in the area of getting and setting environments as well as accessing activation / execution events. Projects can be created via PythonProjectCreators but ongoing management of projects in a workspace are handled through the envs ext API.


### Workspace and Environments
The relationship between **workspaces** and **environments** in the extension can be any of the following configurations:
| workspace | environment | description | example |
| -------- | ------- | -------- | ------- |
| 1 | 1 | single workspace, single environment | simplest, think Django app in a workspace |
| 1 | n | single workspace, multiple environments | one workspace with a client and server which have diff envs OR monorepo with multiple environments |
| m | n | multiroot workspace, multiple environments | many workspaces with many environments |
| m | 1 | multiroot workspace, single environment | covered in m:n scenario |


 `PythonEnvironment` describes a unique python environment that is identified by its `PythonEnvironmentId` a property containing the `id` of the environment and the `managerId`. A `PythonEnvironment` object can contain many attributes included in the code block below. Note `execInfo` of type `PythonEnvironmentExecutionInfo` contains information on both terminal activation for a given environment and code execution. The group attribute can be used to provide differentiation between environments from the same manager, such as named vs unnamed conda environments.

```
PythonEnvironment
- envId: PythonEnvironmentId; (unique identifier)
    - id: string;
    - managerId: string;
- name: string;
- displayName: string;
- displayPath: string;
- version: string;
- environmentPath: Uri;
- execInfo: PythonEnvironmentExecutionInfo;
- sysPrefix: string;
- optional: shortDisplayName?, description?, tooltip?, iconPath?, group?
```

### EnvironmentManagers and PackageManagers
The API surfaces the concept of managers which can be registered by external contributors / extensions and provide a variety of actions. These managers can usually be referenced under their nested ownership notation: `<publisher-id>.<extension-id>:<manager-name>`

An `EnvironmentManager` can provide a variety of actions for environments under its management such as create, remove, set, get, etc. The default `EnvironmentManager` defined in this extension is `venv`. 

A `PackageManager` provides a variety of action which can be taken on an environment with that environment provided as an argument. An `EnvironmentManager` when registered is required to provide a `preferredPackageManagerId` attribute meaning each `EnvironmentManager` will have one `PackageManager` but the reverse is not true (a `PackageManager` can work with many `EnvironmentManager`). Once set on registration, this relationship cannot be amended unless a new `EnvironmentManager` is created. Example `EnvironmentManager-PackageManager` relationships include:

| EnvironmentManager | PackageManager |
| -------- | ------- |
| venv | pip | 
| conda | conda |


Note two things in the table, a given python tool like conda can be both a `EnvironmentManager` and a `PackageManager`. Secondly an `EnvironmentManager`'s preferred `PackageManager` is an opinionated selection made by the manager's author but can be overruled in specific package actions (ie install packageA using into envA using packageManager X). For the default `EnvironmentManager` (venv) the default `PackageManager` is `pip`.


Connecting these objects back to the API functionality, the `EnvironmentManager` is the essential object in "terminal activation" and "code execution" with each of these actions tied to a specific environment. Meanwhile the packageManager is used in tandem with the environment manager to handle "getting / setting environments" as this action includes the packages found in them.


### Packages and Related Objects
Instances of packages are uniquely referenced by PackageId which is made up of 3 attributes, string id of the package, managerId and environmentId. The string Id of a package is the same name registered with pip. PackageInfo, which the package interface extends, contains information on the package like description and version. Package in this extension follows the same definition as that used for python overall, that package is an installable piece of code. This means that any packages, regardless of if they are on PyPi or instantiated as part of the top 1000 pkgs in the extension, can be created and used in the extension.

As an example of the `package` design, if there was a workspace with two environments which both had the same version of `pytest` installed, their Package instances would be unique, separated by the environmentId attribute, but their packageInfo may be the same or different. A difference could arise if each environment had a different `pytest` version, since version is stored in `packageInfo`.

By default, the top 1000 packages per pypi statistics are instantiated in the environments extension. When it comes time to install a package, the package id (a string) is the value that will be passed to the install helper. Anything thats installable / modular python code can be a package in this extension. 

### PythonProject and PythonProjectCreator
Finally there is the concept of a `PythonProject` which for the purposes of this extension, we will define as "a single or group of python files which have a environment connected to them".`PythonProject` do not have a Manager but instead the `PythonProjectCreator` since creation is the only action to take on a `PythonProject` object. Once created the project, the association between the files and the environment will be maintained but otherwise the project can be edited using normal file-system operations. `PythonProject` objects can look many different ways; a few options of things that could be a `PythonProject` are: a python package, a server, a Django web app, a single script with the PEP723, etc.

A `PythonProjectCreator` is contributed by an extensions and provides a `create` function that will return a `PythonProject`.  The `supportsQuickCreate` just defines if this project creation step can be done without any user input- ie there is a default way to create a project of this type. All projects in a workspace can be managed (add, remove, get) via the PythonProject specific APIs (PythonProjectGetterApi, PythonProjectModifyApi).


## Connection to UI

Users of the Python Environments extension can interact with the environments extension in a few different ways. These entry points include the "Python Side Pane", contributed commands to VS Code menus / command palette, and actions taken by copilot. 

### Python Side Pane

Selectable by the Python logo icon and located by default in the sidepane, the Python Side Pane is the main surface of information a user sees about their python environments. The user can take actions from the UI, such as "install packages" or just view existing information like projects in a workspace. 


### Copilot Tooling
xxxx

### Command Palette

### Contributions to File Explorer
