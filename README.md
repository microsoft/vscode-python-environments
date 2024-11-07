# Python Environments and Package Manager (preview)

## Overview

Python Environments and Package Manager is a VS Code extension that helps users manage their Python environments and package management. It is a preview extension and the APIs and features are subject to change as the project evolves.

## Features

### Environment Management

This extension provides an environment view for the user to manage their Python environments. The user can create, delete, and switch between environments. The user can also install and uninstall packages in the current environment. This extension provides APIs for extension developers to contribute environment managers.

The extension by uses `venv` as the default environment manager. You can change this by setting the `python-envs.defaultEnvManager` setting to a different environment manager. Following are the out of the box environment managers:

|Id| name |Description|
|---|----|--|
|ms-python.python:venv| `venv` |The default environment manager. It is a built-in environment manager provided by the Python standard library.|
|ms-python.python:system| System Installed Python | These are python installs on your system. Installed either with your OS, or from python.org, or any other OS package manager |
|ms-python.python:conda| `conda` |The conda environment manager. It is a popular environment manager for Python.|


### Package Management

This extension provides a package view for the user to manage their Python packages. The user can install and uninstall packages in the any environment. This extension provides APIs for extension developers to contribute package managers.

The extension by uses `pip` as the default package manager. You can change this by setting the `python-envs.defaultPackageManager` setting to a different package manager. Following are the out of the box package managers:

|Id| name |Description|
|---|----|--|
|ms-python.python:pip| `pip` |The default package manager. It is a built-in package manager provided by the Python standard library.|
|ms-python.python:conda| `conda` |The conda package manager. It is a popular package manager for Python.|

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