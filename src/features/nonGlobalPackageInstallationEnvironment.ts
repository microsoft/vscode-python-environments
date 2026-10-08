import { l10n, QuickPickItem } from 'vscode';
import { GetEnvironmentsScope, PackageManagementOptions, PythonEnvironment } from '../api';
import { VENV_MANAGER_ID } from '../common/constants';
import { pickEnvironmentFrom } from '../common/pickers/environments';
import { showQuickPick } from '../common/window.apis';
import { getConfiguration } from '../common/workspace.apis';
import { waitForAllEnvManagers, waitForEnvManagerId } from './common/managerReady';
import type { EnvironmentManagers } from './envManagers';

type GlobalPackageInstallationAction = 'ask' | 'continueGlobally' | 'useExisting' | 'createNew';

interface PackageInstallationQuickPickItem extends QuickPickItem {
    readonly action: Exclude<GlobalPackageInstallationAction, 'ask'>;
}

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

    let action: GlobalPackageInstallationAction | undefined = getConfiguration('python-envs', null).get(
        'globalPackageInstallationAction',
        'ask',
    );
    if (action === 'ask') {
        const choice = await showQuickPick<PackageInstallationQuickPickItem>(
            [
                { label: l10n.t('Continue Globally'), action: 'continueGlobally' },
                { label: l10n.t('Use Existing Virtual Environment'), action: 'useExisting' },
                { label: l10n.t('Create New Virtual Environment'), action: 'createNew' },
            ],
            {
                title: l10n.t('You are installing packages into a global Python environment'),
                placeHolder: l10n.t('Select where to install the packages'),
            },
        );
        action = choice?.action;
    }

    if (action === 'createNew') {
        await waitForEnvManagerId([VENV_MANAGER_ID]);
        const venvManager = envManagers.getEnvironmentManager(VENV_MANAGER_ID);
        if (!venvManager?.supportsCreate) {
            throw new Error(l10n.t('The virtual environment manager is not available.'));
        }
        return venvManager.create('global', { quickCreate: true });
    }

    if (action === 'useExisting') {
        const environments = await getEnvironments(envManagers, 'all');
        const virtualEnvironments = environments.filter(
            (candidate) =>
                !globalEnvironments.some((globalEnvironment) => hasSameEnvironmentId(candidate, globalEnvironment)),
        );
        return pickEnvironmentFrom(virtualEnvironments);
    }

    if (action === 'continueGlobally') {
        return environment;
    }

    return undefined;
}
