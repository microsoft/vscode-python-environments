import { l10n } from 'vscode';
import { GetEnvironmentsScope, PackageManagementOptions, PythonEnvironment } from '../api';
import { VENV_MANAGER_ID } from '../common/constants';
import { pickEnvironmentFrom } from '../common/pickers/environments';
import { showInformationMessage } from '../common/window.apis';
import { waitForAllEnvManagers } from './common/managerReady';
import type { EnvironmentManagers } from './envManagers';

function hasSameEnvironmentId(first: PythonEnvironment, second: PythonEnvironment): boolean {
    return first.envId.managerId === second.envId.managerId && first.envId.id === second.envId.id;
}

async function getEnvironments(
    envManagers: EnvironmentManagers,
    scope: Extract<GetEnvironmentsScope, 'all' | 'global'>,
): Promise<PythonEnvironment[]> {
    await waitForAllEnvManagers();
    const environments = await Promise.all(envManagers.managers.map((manager) => manager.getEnvironments(scope)));
    return environments.flat();
}

/**
 * Offers alternatives when package installation targets a global environment.
 *
 * @param envManagers Registered environment managers used to create a venv.
 * @param environment Original package installation target.
 * @param options Requested package operation.
 * @returns The selected installation target, or `undefined` when the operation is canceled.
 */
export async function selectPackageManagementEnvironment(
    envManagers: EnvironmentManagers,
    environment: PythonEnvironment,
    options: PackageManagementOptions,
): Promise<PythonEnvironment | undefined> {
    const isUninstallOnly = (options.install?.length ?? 0) === 0 && (options.uninstall?.length ?? 0) > 0;
    if (options.runHeadless || isUninstallOnly) {
        return environment;
    }

    const globalEnvironments = await getEnvironments(envManagers, 'global');
    if (!globalEnvironments.some((globalEnvironment) => hasSameEnvironmentId(environment, globalEnvironment))) {
        return environment;
    }

    const createNew = l10n.t('Create New Virtual Environment');
    const useExisting = l10n.t('Use Existing Virtual Environment');
    const continueGlobally = l10n.t('Continue Globally');
    const choice = await showInformationMessage(
        l10n.t('You are installing packages into a global Python environment. Where would you like to install them?'),
        createNew,
        useExisting,
        continueGlobally,
    );

    if (choice === createNew) {
        const venvManager = envManagers.getEnvironmentManager(VENV_MANAGER_ID);
        if (!venvManager?.supportsCreate) {
            throw new Error(l10n.t('The virtual environment manager is not available.'));
        }
        return venvManager.create('global', { quickCreate: true });
    }

    if (choice === useExisting) {
        const environments = await getEnvironments(envManagers, 'all');
        const virtualEnvironments = environments.filter(
            (candidate) =>
                !globalEnvironments.some((globalEnvironment) =>
                    hasSameEnvironmentId(candidate, globalEnvironment),
                ),
        );
        return pickEnvironmentFrom(virtualEnvironments);
    }

    return choice === continueGlobally ? environment : undefined;
}
