# Python Environments and Package Manager (preview)

## Overview

Python Environments and Package Manager is a VS Code extension that helps users manage their Python environments and package management with their preferred environment manager using extensible APIs. This extension provides unique support to specify environments for specific files, whole Python projects, or multiroot/monorepos scenarios.

> Note: This extension is in preview and the APIs and features are subject to change as the project evolves.

## Features

### Environment Management

This extension provides an environment view in the Activity Bar for the user to manage their Python environments. The user can create, delete, and switch between environments as desired. The user can also install and uninstall packages in the current environment. This extension provides APIs for extension developers to contribute environment managers.

The default environment manager is the environment manager that the extension uses automatically, unless you specify otherwise. It determines how environments are created, managed, and where the packages are installed. The extension by uses `venv` by default, however you can change this by setting the `python-envs.defaultEnvManager` setting to a different environment manager. The following are environment managers that are supported out of the box:

|Id| name |Description|
|---|----|--|
|ms-python.python:venv| `venv` |The default environment manager. It is a built-in environment manager provided by the Python standard library.|
|ms-python.python:system| System Installed Python | These are python installs on your system. Installed either with your OS, or from python.org, or any other OS package manager |
|ms-python.python:conda| `conda` |The conda environment manager. It is a popular environment manager for Python.|

The environment manager is responsible for specifying which package manager will be used by default to install and manage Python packages within the environment. This ensures that packages are managed consistently according to the preferred tools and settings of the chosen environment manager.

### Package Management

This extension provides a package view for the user to manage, install and uninstall, their Python packages in any partiular environment. This extension provides APIs for extension developers to contribute package managers.

The extension by uses `pip` as the default package manager. You can change this by setting the `python-envs.defaultPackageManager` setting to a different package manager. Following are the out of the box package managers:

|Id| name |Description|
|---|----|--|
|ms-python.python:pip| `pip` |The default package manager. It is a built-in package manager provided by the Python standard library.|
|ms-python.python:conda| `conda` |The conda package manager. It is a popular package manager for Python.|

## Settings Reference

The extension recognizes and consumes a variety of settings from the Python extension and third-party providers to allow more control over your desired experience. 

| Setting (python.environments) |	Default |	Description |
| ----- | ----- | -----| 
defaultInterpreterPath | `"python"` |	Path to the default Python interpreter to be used by the Python extension on the first time it loads for a workspace, or the path to a folder containing the Python interpreter. Can use variables like ${workspaceFolder} and ${workspaceFolder}/.venv. Using a path to a folder allows anyone working with a project to create an environment in the .venv folder as appropriate to their operating system, rather than having to specify an exact platform-dependent path. The settings.json file can then be included in a source code repository. Note: Changes to this setting made after an interpreter has been selected for a workspace will not be applied or considered by the Python extension. The Python extension doesn't automatically add or change this setting. |


### Third party settings 
| Setting (python.environments) |	Default |	Description |
| ----- | ----- | -----| 
| condaPath |	`"conda"`	| Path to the conda executable. |
| poetryPath |	`"poetry"`	| Specifies the location of the Poetry dependency manager executable, if installed. The default value "poetry" assumes the executable is in the current path. The Python extension uses this setting to install packages when Poetry is available and there's a poetry.lock file in the workspace folder. |
| pipenvPath |	`"pipenv"` |	Path to the pipenv executable to use for activation. |


## API Reference

See the `src\api.ts` for the full list of APIs.

## Contributing

This project welcomes contributions and suggestions.  Most contributions require you to agree to a
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

The Microsoft Python Extension for Visual Studio Code collects usage
data and sends it to Microsoft to help improve our products and
services. Read our
[privacy statement](https://privacy.microsoft.com/privacystatement) to
learn more. This extension respects the `telemetry.enableTelemetry`
setting which you can learn more about at
https://code.visualstudio.com/docs/supporting/faq#_how-to-disable-telemetry-reporting.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft 
trademarks or logos is subject to and must follow 
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.