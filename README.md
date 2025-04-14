# Python Environments (experimental)

## Overview

The Python Environments extension for VS Code helps you manage Python environments and packages using your preferred environment manager backed by its extensible APIs. This extension provides unique support to specify environments for specific files or whole Python folders or projects, including multi-root & mono-repos scenarios.

> Note: This extension is in preview and its APIs and features are subject to change as the project continues to evolve.

> Important: This extension currently requires the pre-release version of the Python extension (ms-python.python) to operate (version 2024.23.2025010901 or later).

## Features

<img src=https://raw.githubusercontent.com/microsoft/vscode-python-environments/main/images/python-envs-overview.gif width=734 height=413>


### Environment Management

This extension provides an Environments view, which can be accessed via the VS Code Activity Bar, where you can manage your Python environments. Here, you can create, delete, and switch between environments, as well as install and uninstall packages within the selected environment. It also provides APIs for extension developers to contribute their own environment managers.

ADD A QUICK REFERENCE FOR UI BUTTON 

To further simplify the environment creation process, you can create a virtual environments using "Quick Create", which uses your default environment manager (i.e. `venv`) and the most updated Python version to create a virtual environment. If you would like more control over your environment features, such as the Python version used, the environment name, packages installed, etc. you can create a custom environment.  

The following environment managers are supported out of the box:

| Id                      | name                    | Description                                                                                                                                                                                                   |
| ----------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ms-python.python:venv   | `venv`                  | The default environment manager. It is a built-in environment manager provided by the Python standard library.                                                                                                |
| ms-python.python:system | System Installed Python | These are global Python installs on your system. These are typically installed with your OS, from [python.org](https://www.python.org/), or any other OS package manager.                                     |
| ms-python.python:conda  | `conda`                 | The [conda](https://conda.org) environment manager, as provided by conda distributions like [Anaconda Distribution](https://docs.anaconda.com/anaconda/) or [conda-forge](https://conda-forge.org/download/). |

The environment manager is responsible for specifying which package manager will be used by default to install and manage Python packages within the environment. This ensures that packages are managed consistently according to the preferred tools and settings of the chosen environment manager.

### Package Management

This extension provides a package view for you to manage, install and uninstall you Python packages in any particular environment. This extension provides APIs for extension developers to contribute package managers.

ADD A QUICK REFERENCE FOR BUTTONS 

The extension uses `pip` as the default package manager. You can change this by setting the `python-envs.defaultPackageManager` setting to a different package manager. The following are package managers supported out of the box:

| Id                     | Name    | Description                                                                                                                                                                                               |
| ---------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ms-python.python:pip   | `pip`   | Pip acts as the default package manager and it's typically built-in to Python.                                                                                                                            |
| ms-python.python:conda | `conda` | The [conda](https://conda.org) package manager, as provided by conda distributions like [Anaconda Distribution](https://docs.anaconda.com/anaconda/) or [conda-forge](https://conda-forge.org/download/). |

## Command Reference 

| Name    | Description  | 
| Python: Manage Packages | | 
| Python: Create Project | | 
| Python: Activate Environment in Current Terminal | |
| Python: Deactivate Environment in Current Terminal  | |
| Python: Run as Task | |          

## Settings Reference

| Setting (python-envs.)      | Default                   | Description                                                                                                                                                                                                                                                                            |
| --------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| defaultEnvManager           | `"ms-python.python:venv"` | The default environment manager used for creating and managing environments.                                                                                                                                                                                                           |
| defaultPackageManager       | `"ms-python.python:pip"`  | The default package manager to use for installing and managing packages. This is often dictated by the default environment manager but can be customized.                                                                                                                              |
| pythonProjects              | `[]`                      | A list of Python workspaces, specified by the path, in which you can set particular environment and package managers. You can set information for a workspace as `[{"path":  "/path/to/workspace", "envManager": "ms-python.python:venv", "packageManager": "ms-python.python:pip"]}`. |
| terminal.showActivateButton | `false`                   | [experimental] Show a button in the terminal to activate/deactivate the current environment for the terminal. This button is only shown if the active terminal is associated with a project that has an activatable environment.                                                       |

## Extensibility

The Python Environments extension was built to provide a cohesive and user friendly experience with `venv` as the default. However, the extension is built with extensibility in mind so that any environment manager could build an extension using the supported APIs to plug-in and provide a seamless and incirporated experience for their users in VS Code. 

### API Reference (proposed)

See [api.ts](https://github.com/microsoft/vscode-python-environments/blob/main/src/api.ts) for the full list of Extension APIs.

To consume these APIs you can look at the example here:
https://github.com/microsoft/vscode-python-environments/blob/main/examples/README.md


## Extension Dependency

This section provides an overview of how the Python extension interacts with the Python Environments extension and other tool-specific extensions. The Python Environments extension allows users to create, manage, and remove Python environments and packages. It also provides an API that other extensions can use to support environment management or consume it for running Python tools or projects.  

Tools that may rely on these APIs in their own extensions include:
- **Debuggers** (e.g., `debugpy`)
- **Linters** (e.g., Pylint, Flake8, Mypy)
- **Formatters** (e.g., Black, autopep8)
- **Language Server extensions** (e.g., Pylance, Jedi)
- **Environment and Package Manager extensions** (e.g., Pixi, Conda, Hatch)

### API Dependency
The relationship between these extensions can be represented as follows:

<img src=https://raw.githubusercontent.com/microsoft/vscode-python-environments/refs/heads/main/images/extension_relationships.png width=734 height=413>

Users who do not need to execute code or work in **Virtual Workspaces** can use the Python extension to access language features like hover, completion, and go-to definition. However, executing code (e.g., running a debugger, linter, or formatter), creating/modifying environments, or managing packages requires the Python Environments extension to enable these functionalities.

### Trust Relationship Between Python and Python Environments Extensions

VS Code supports trust management, allowing extensions to function in either **trusted** or **untrusted** scenarios. Code execution and tools that can modify the user’s environment are typically unavailable in untrusted scenarios.  

The relationship is illustrated below:

<img src=https://raw.githubusercontent.com/microsoft/vscode-python-environments/refs/heads/main/images/trust_relationships.png width=734 height=413>

In **trusted mode**, the Python Environments extension supports tasks like managing environments, installing/removing packages, and running tools. In **untrusted mode**, functionality is limited to language features, ensuring a secure and restricted environment.

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.opensource.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Questions, issues, feature requests, and contributions

-   If you have a question about how to accomplish something with the extension, please [ask on our Discussions page](https://github.com/microsoft/vscode-python/discussions/categories/q-a).
-   If you come across a problem with the extension, please [file an issue](https://github.com/microsoft/vscode-python).
-   Contributions are always welcome! Please see our [contributing guide](https://github.com/Microsoft/vscode-python/blob/main/CONTRIBUTING.md) for more details.
-   Any and all feedback is appreciated and welcome!
    -   If someone has already [filed an issue](https://github.com/Microsoft/vscode-python) that encompasses your feedback, please leave a 👍/👎 reaction on the issue.
    -   Otherwise please start a [new discussion](https://github.com/microsoft/vscode-python/discussions/categories/ideas).
-   If you're interested in the development of the extension, you can read about our [development process](https://github.com/Microsoft/vscode-python/blob/main/CONTRIBUTING.md#development-process).

## Data and telemetry

The Microsoft Python Extension for Visual Studio Code collects usage data and sends it to Microsoft to help improve our products and services. Read our [privacy statement](https://privacy.microsoft.com/privacystatement) to learn more. This extension respects the `telemetry.enableTelemetry` setting which you can learn more about at https://code.visualstudio.com/docs/supporting/faq#_how-to-disable-telemetry-reporting.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.
