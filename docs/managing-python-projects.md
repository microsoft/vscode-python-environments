# Making and Managing Python Projects

This guide explains how to set up and manage Python projects in VS Code using the Python Environments extension. By the end, you'll understand what a "project" is, how to create and configure them, and how to assign the right environments and package managers to each one.

## What is a Python Project?

A **Python Project** is any file or folder that contains runnable Python code and needs its own environment. Think of it as a way to tell VS Code: "This folder (or file) is a distinct Python codebase that should use a specific Python interpreter and package manager."

By default, every workspace folder you open in VS Code is automatically treated as a project. However, you can also:

- Add subfolders as separate projects (useful for mono-repos)
- Add individual Python files as projects (great for standalone scripts)
- Create brand new projects from templates

### Why use projects?

Projects solve a common challenge: **different parts of your workspace need different Python environments**.

| Scenario | Without Projects | With Projects |
|----------|-----------------|---------------|
| Mono-repo with multiple services | All services share one environment | Each service gets its own environment |
| Testing different Python versions | Manual interpreter switching | Assign Python 3.10 to one folder, 3.12 to another |
| Shared workspace with scripts and packages | Confusing environment management | Clear separation of concerns |

## The Python Environments Panel

The Python Environments extension adds a dedicated view to VS Code's Activity Bar. This panel has two main sections:

1. **Python Projects**: Shows all projects in your workspace and their selected environments
2. **Environment Managers**: Shows available environment managers (venv, conda, etc.) with their environments

<!-- INSERT IMAGE: Screenshot of the Python Environments panel showing both sections
     Alt text: VS Code sidebar showing Python Projects section with project list and Environment Managers section below
     Caption: The Python Environments panel with Python Projects and Environment Managers sections -->

## Adding Projects to Your Workspace

There are several ways to add Python projects:

### Method 1: Add existing files or folders

Use this when you have existing Python code that should be treated as a separate project.

1. Open the Python Environments panel in the Activity Bar.
2. In the **Python Projects** section, click the **+** button.
3. Select **Add Existing**.
4. Browse to and select the folder(s) or file(s) you want to add.
5. Select **Open** to add them as projects.

Alternatively, right-click any folder or Python file in the Explorer and select **Add as Python Project**.

<!-- INSERT IMAGE: Context menu in Explorer showing "Add as Python Project" option
     Alt text: VS Code Explorer context menu with "Add as Python Project" highlighted
     Caption: Right-click any folder or file to add it as a Python project -->

### Method 2: Auto-find projects

Use this to quickly discover all Python projects in your workspace based on common project markers.

1. Open the Python Environments panel.
2. Click the **+** button in the Python Projects section.
3. Select **Auto Find**.
4. The extension searches for folders containing `pyproject.toml` or `setup.py` files.
5. Select which discovered projects to add from the list.

> **Tip**: Auto-find is especially useful when you clone a mono-repo and want to quickly identify all its Python projects.

### Method 3: Create a new project from a template

Use this to scaffold a brand new Python project with the correct structure and files.

1. Open the Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Windows/Linux).
2. Run **Python Envs: Create New Project from Template**.
3. Choose a template type:
   - **Package**: A structured Python package with `pyproject.toml`, tests folder, and package directory
   - **Script**: A simple standalone Python file using PEP 723 inline metadata
4. Enter a name for your project.
5. Choose whether to create a virtual environment.

The extension creates the project structure, adds it to your workspace, and optionally creates a virtual environment.

#### Package template structure

When you create a package named `my_package`, the extension generates:

```
my_package_project/
├── pyproject.toml          # Project metadata and dependencies
├── dev-requirements.txt    # Development dependencies
├── my_package/             # Your package source code
│   └── __init__.py
└── tests/                  # Test directory
    └── __init__.py
```

#### Script template

When you create a script, the extension generates a single `.py` file with PEP 723 inline script metadata, which allows you to specify dependencies directly in the file.

## Assigning Environments to Projects

Each project can have its own Python environment. This is the core benefit of project management.

### Set an environment for a project

1. In the **Python Projects** section, find your project.
2. Click on the environment path shown beneath the project name (or "No environment" if none is set).
3. Select an environment from the list of available environments.

You can also:

- Click the environment icon next to a project
- Right-click the project and select **Set Project Environment**

<!-- INSERT IMAGE: Python Projects section showing a project with environment selection dropdown
     Alt text: Project item in Python Environments panel with environment selector expanded
     Caption: Click the environment path to change a project's Python interpreter -->

### Use an environment from the Environment Managers section

1. In the **Environment Managers** section, expand a manager (e.g., venv, conda).
2. Find the environment you want to use.
3. Right-click it and select **Set As Project Environment**.
4. Choose which project should use this environment.

## Setting Environment and Package Managers

Beyond selecting which Python interpreter a project uses, you can also specify which **environment manager** and **package manager** the project should use. This affects how environments are created and how packages are installed.

### Environment managers

Environment managers control how Python environments are created and discovered:

| Manager | Description |
|---------|-------------|
| `venv` | Built-in Python virtual environments (default) |
| `conda` | Conda environments from Anaconda or Miniconda |
| `pyenv` | Multiple Python versions via pyenv |
| `poetry` | Poetry-managed environments |
| `pipenv` | Pipenv-managed environments |
| `system` | System-installed Python interpreters |

### Package managers

Package managers control how packages are installed in environments:

| Manager | Description |
|---------|-------------|
| `pip` | Standard Python package installer (default) |
| `conda` | Conda package manager for conda environments |

### Set managers for a project

1. Right-click a project in the Python Projects section.
2. Select **Set Environment Manager** to change how environments are created.
3. Select **Set Package Manager** to change how packages are installed.

> **Note**: The default package manager is typically determined by the environment manager. For example, venv environments use pip by default, while conda environments use the conda package manager.

## Where Settings Are Stored

The extension stores project configurations in your VS Code settings. Understanding this helps you manage settings across different scopes.

### Settings location

Project settings are stored in the `python-envs.pythonProjects` setting. Depending on your workspace setup:

| Workspace Type | Settings Location |
|----------------|-------------------|
| Single folder | `.vscode/settings.json` in your workspace |
| Multi-root workspace | `.code-workspace` file |

### Settings structure

The `pythonProjects` setting is an array of project configurations:

```json
{
    "python-envs.pythonProjects": [
        {
            "path": "backend",
            "envManager": "ms-python.python:venv",
            "packageManager": "ms-python.python:pip"
        },
        {
            "path": "ml-service",
            "envManager": "ms-python.python:conda",
            "packageManager": "ms-python.python:conda"
        }
    ]
}
```

Each project entry contains:

| Property | Description |
|----------|-------------|
| `path` | Relative path from workspace root to the project |
| `envManager` | ID of the environment manager (e.g., `ms-python.python:venv`) |
| `packageManager` | ID of the package manager (e.g., `ms-python.python:pip`) |
| `workspace` | (Multi-root only) Name of the workspace folder containing the project |

### Default managers

You can set default managers that apply to all projects without explicit overrides:

```json
{
    "python-envs.defaultEnvManager": "ms-python.python:venv",
    "python-envs.defaultPackageManager": "ms-python.python:pip"
}
```

## Working with Multi-Root Workspaces

Multi-root workspaces contain multiple top-level folders. The extension handles these seamlessly:

1. Each workspace folder is automatically treated as a project.
2. You can add sub-projects within any workspace folder.
3. Project settings include a `workspace` property to identify which folder they belong to.
4. When creating a new project from a template, you're prompted to select which workspace folder to use.

### Example: Multi-root mono-repo

```
my-workspace.code-workspace
├── frontend/           → Project with Python 3.12
│   └── scripts/        → Sub-project with same environment
├── backend/            → Project with Python 3.10, venv
│   ├── api/            → Sub-project with its own venv
│   └── workers/        → Sub-project with its own venv
└── ml-pipeline/        → Project with conda environment
```

## Removing Projects

To remove a project (this does not delete any files):

1. Right-click the project in the Python Projects section.
2. Select **Remove Python Project**.

The project is removed from the extension's tracking. Its files remain untouched, and you can always add it back later.

## Quick Reference: Commands

Access these via the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):

| Command | Description |
|---------|-------------|
| **Python Envs: Create New Project from Template** | Create a new package or script from a template |
| **Python Envs: Add Python Project** | Add existing files/folders as projects |
| **Python Envs: Set Project Environment** | Change the Python interpreter for a project |
| **Python Envs: Set Environment Manager** | Change how environments are created |
| **Python Envs: Set Package Manager** | Change how packages are installed |
| **Python Envs: Create Environment** | Create a new environment for a project |
| **Python Envs: Manage Packages** | Install or uninstall packages |

## Quick Reference: Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `python-envs.defaultEnvManager` | `"ms-python.python:venv"` | Default environment manager for new projects |
| `python-envs.defaultPackageManager` | `"ms-python.python:pip"` | Default package manager for new projects |
| `python-envs.pythonProjects` | `[]` | List of project configurations |

## Common Scenarios

### Scenario 1: Mono-repo with microservices

You have a repository with multiple Python services, each needing isolated dependencies.

1. Open the root folder in VS Code.
2. Click **+** in Python Projects and select **Auto Find** to discover all services with `pyproject.toml`.
3. Select the services you want to track.
4. For each service, create a virtual environment by right-clicking and selecting **Create Environment**.
5. Each service now runs with its own isolated environment.

### Scenario 2: Switching a project from venv to conda

Your data science project needs packages that install more reliably with conda.

1. Right-click the project in Python Projects.
2. Select **Set Environment Manager** → **conda**.
3. Select **Set Package Manager** → **conda**.
4. Right-click the project again and select **Create Environment** to create a new conda environment.

### Scenario 3: Adding a standalone script

You have a utility script that needs specific packages without affecting your main project.

1. Right-click the `.py` file in Explorer.
2. Select **Add as Python Project**.
3. The script is now a separate project that can have its own environment.

## Troubleshooting

### Project not appearing in the panel

- Verify the file or folder is inside your workspace
- Check if it was already added (duplicates are prevented)
- Try using **Add Existing** and manually selecting it

### Environment changes not taking effect

- Restart any open terminals to use the new environment
- Check that the environment actually exists and is valid
- Verify the `pythonProjects` setting in `.vscode/settings.json`

### Settings not persisting

- Ensure you have write access to the workspace folder
- Check if settings are being overridden at a higher scope (User vs. Workspace)
- For multi-root workspaces, verify the `.code-workspace` file is being saved

## Related Resources

- [Environment Management](../README.md#environment-management): Learn about creating and managing Python environments
- [Package Management](../README.md#package-management): Learn how to install and manage packages
- [Projects API Reference](projects-api-reference.md): Technical reference for extension authors




RawEventsVSCodeExt
| where EventName == "ms-python.vscode-python-envs/project_structure"
| extend ProjectCount = toint(Properties["totalprojectcount"])
| extend Bucket = case(
    ProjectCount == 0, "0",
    ProjectCount == 1, "1",
    ProjectCount == 2, "2",
    ProjectCount == 3, "3",
    ProjectCount >= 4, "4+",
    "unknown")
| summarize Count = count() by Bucket
| order by Bucket asc

0	4,231
1	38,743  93.6%
2	1,163   2.8%
3	429     1%
4+	1,051   2.5%

1-4 == 41,386

RawEventsVSCodeExt
| where EventName == "ms-python.vscode-python-envs/project_structure"
| extend ProjectCount = toint(Properties["uniqueinterpretercount"])
| extend Bucket = case(
    ProjectCount == 0, "0",
    ProjectCount == 1, "1",
    ProjectCount == 2, "2",
    ProjectCount == 3, "3",
    ProjectCount >= 4, "4+",
    "unknown")
| summarize Count = count() by Bucket
| order by Bucket asc

0	4,934    10.9%
1	39,054   86.6%
2	820      1.8%
3	138      0.3%
4+	160      0.35

0-4+ = 45,106


RawEventsVSCodeExt
| where EventName == "ms-python.vscode-python-envs/project_structure"
| extend ProjectCount = toint(Properties["projectunderroot"])
| extend Bucket = case(
    ProjectCount == 0, "0",
    ProjectCount == 1, "1",
    ProjectCount == 2, "2",
    ProjectCount == 3, "3",
    ProjectCount >= 4, "4+",
    "unknown")
| summarize Count = count() by Bucket
| order by Bucket asc


0	45,293 98.2%
1	445 1%
2	119 0.25%
3	29
4+	194 0.4%

0-4+: 46,080