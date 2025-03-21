import { l10n } from 'vscode';

export namespace Common {
    export const recommended = l10n.t('Recommended');
    export const install = l10n.t('Install');
    export const uninstall = l10n.t('Uninstall');
    export const openInBrowser = l10n.t('Open in Browser');
    export const openInEditor = l10n.t('Open in Editor');
    export const browse = l10n.t('Browse');
    export const selectFolder = l10n.t('Select Folder');
    export const viewLogs = l10n.t('View Logs');
    export const yes = l10n.t('Yes');
    export const no = l10n.t('No');
}

export namespace Interpreter {
    export const statusBarSelect = l10n.t('Select Interpreter');
    export const browsePath = l10n.t('Browse...');
    export const createVirtualEnvironment = l10n.t('Create Virtual Environment...');
}

export namespace PackageManagement {
    export const selectPackagesToInstall = l10n.t('Select packages to install');
    export const enterPackageNames = l10n.t('Enter package names');
    export const commonPackages = l10n.t('Search common `PyPI` packages');
    export const commonPackagesDescription = l10n.t('Search and Install common `PyPI` packages');
    export const workspaceDependencies = l10n.t('Install workspace dependencies');
    export const workspaceDependenciesDescription = l10n.t('Install dependencies found in the current workspace.');
    export const selectPackagesToUninstall = l10n.t('Select packages to uninstall');
    export const enterPackagesPlaceHolder = l10n.t('Enter package names separated by space');
    export const editArguments = l10n.t('Edit arguments');
    export const skipPackageInstallation = l10n.t('Skip package installation');
}

export namespace Pickers {
    export namespace Environments {
        export const selectExecutable = l10n.t('Select Python Executable');
        export const selectEnvironment = l10n.t('Select a Python Environment');
    }

    export namespace Packages {
        export const selectOption = l10n.t('Select an option');
        export const installPackages = l10n.t('Install packages');
        export const uninstallPackages = l10n.t('Uninstall packages');
    }

    export namespace Managers {
        export const selectEnvironmentManager = l10n.t('Select an environment manager');
        export const selectPackageManager = l10n.t('Select a package manager');
        export const selectProjectCreator = l10n.t('Select a project creator');
    }

    export namespace Project {
        export const selectProject = l10n.t('Select a project, folder or script');
        export const selectProjects = l10n.t('Select one or more projects, folders or scripts');
    }
}

export namespace ProjectViews {
    export const noPackageManager = l10n.t('No package manager found');
    export const waitingForEnvManager = l10n.t('Waiting for environment managers to load');
    export const noEnvironmentManager = l10n.t('Environment manager not found');
    export const noEnvironmentManagerDescription = l10n.t(
        'Install an environment manager to get started. If you have installed then it might be loading or errored',
    );
    export const noEnvironmentProvided = l10n.t('No environment provided by:');
    export const noPackages = l10n.t('No packages found');
}

export namespace VenvManagerStrings {
    export const venvManagerDescription = l10n.t('Manages virtual environments created using `venv`');
    export const venvInitialize = l10n.t('Initializing virtual environments');
    export const venvRefreshing = l10n.t('Refreshing virtual environments');
    export const venvGlobalFolder = l10n.t('Select a folder to create a global virtual environment');
    export const venvGlobalFoldersSetting = l10n.t('Venv Folders Setting');

    export const venvErrorNoBasePython = l10n.t('No base Python found');
    export const venvErrorNoPython3 = l10n.t('Did not find any base Python 3');

    export const venvName = l10n.t('Enter a name for the virtual environment');
    export const venvNameErrorEmpty = l10n.t('Name cannot be empty');
    export const venvNameErrorExists = l10n.t('A folder with the same name already exists');

    export const venvCreating = l10n.t('Creating virtual environment');
    export const venvCreateFailed = l10n.t('Failed to create virtual environment');

    export const venvRemoving = l10n.t('Removing virtual environment');
    export const venvRemoveFailed = l10n.t('Failed to remove virtual environment');

    export const installEditable = l10n.t('Install project as editable');
    export const searchingDependencies = l10n.t('Searching for dependencies');
}

export namespace SysManagerStrings {
    export const sysManagerDescription = l10n.t('Manages Global Python installs');
    export const sysManagerRefreshing = l10n.t('Refreshing Global Python interpreters');
    export const sysManagerDiscovering = l10n.t('Discovering Global Python interpreters');

    export const selectInstall = l10n.t('Select packages to install');
    export const selectUninstall = l10n.t('Select packages to uninstall');

    export const packageRefreshError = l10n.t('Error refreshing packages');
}

export namespace CondaStrings {
    export const condaManager = l10n.t('Manages Conda environments');
    export const condaDiscovering = l10n.t('Discovering Conda environments');
    export const condaRefreshingEnvs = l10n.t('Refreshing Conda environments');

    export const condaPackageMgr = l10n.t('Manages Conda packages');
    export const condaRefreshingPackages = l10n.t('Refreshing Conda packages');
    export const condaInstallingPackages = l10n.t('Installing Conda packages');
    export const condaInstallError = l10n.t('Error installing Conda packages');
    export const condaUninstallingPackages = l10n.t('Uninstalling Conda packages');
    export const condaUninstallError = l10n.t('Error uninstalling Conda packages');

    export const condaNamed = l10n.t('Named');
    export const condaPrefix = l10n.t('Prefix');

    export const condaNamedDescription = l10n.t('Create a named conda environment');
    export const condaPrefixDescription = l10n.t('Create environment in your workspace');
    export const condaSelectEnvType = l10n.t('Select the type of conda environment to create');

    export const condaNamedInput = l10n.t('Enter the name of the conda environment to create');

    export const condaCreateFailed = l10n.t('Failed to create conda environment');
    export const condaRemoveFailed = l10n.t('Failed to remove conda environment');
    export const condaExists = l10n.t('Environment already exists');
}

export namespace ProjectCreatorString {
    export const addExistingProjects = l10n.t('Add Existing Projects');
    export const autoFindProjects = l10n.t('Auto Find Projects');
    export const selectProjects = l10n.t('Select Python projects');
    export const selectFilesOrFolders = l10n.t('Select Project folders or Python files');
    export const autoFindProjectsDescription = l10n.t(
        'Automatically find folders with `pyproject.toml` or `setup.py` files.',
    );

    export const noProjectsFound = l10n.t('No projects found');
}

export namespace EnvViewStrings {
    export const selectedGlobalTooltip = l10n.t('This environment is selected for non-workspace files');
    export const selectedWorkspaceTooltip = l10n.t('This environment is selected for workspace files');
}

export namespace PermissionsCommon {
    export const allow = l10n.t('Allow');
    export const deny = l10n.t('Deny');
    export const confirmEachTime = l10n.t('Confirm each time');
    export const updatePermissions = l10n.t('Update permissions');
}
