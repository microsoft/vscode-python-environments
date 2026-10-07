import { l10n } from 'vscode';
import { GetEnvironmentsScope, PackageManagementOptions, PythonEnvironment } from '../api';
import { VENV_MANAGER_ID } from '../common/constants';
import { getGlobalPersistentState } from '../common/persistentState';
import { pickEnvironmentFrom } from '../common/pickers/environments';
import { showQuickPickWithToggle } from '../common/window.apis';
import { waitForAllEnvManagers, waitForEnvManagerId } from './common/managerReady';
import type { EnvironmentManagers } from './envManagers';

export const GLOBAL_PACKAGE_INSTALLATION_SELECTION_KEY = 'python-envs:packageManagement:GLOBAL_INSTALLATION_SELECTION';

type RememberedPackageInstallationTarget =
    | { readonly kind: 'global' }
    | { readonly kind: 'environment'; readonly managerId: string; readonly environmentId: string };

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

    const state = await getGlobalPersistentState();
    const rememberedTarget = await state.get<RememberedPackageInstallationTarget>(
        GLOBAL_PACKAGE_INSTALLATION_SELECTION_KEY,
    );
    if (rememberedTarget?.kind === 'global') {
        return environment;
    }
    if (rememberedTarget?.kind === 'environment') {
        const environments = await getEnvironments(envManagers, 'all');
        const rememberedEnvironment = environments.find(
            (candidate) =>
                candidate.envId.managerId === rememberedTarget.managerId &&
                candidate.envId.id === rememberedTarget.environmentId,
        );
        if (rememberedEnvironment) {
            return rememberedEnvironment;
        }
        await state.clear([GLOBAL_PACKAGE_INSTALLATION_SELECTION_KEY]);
    }

    const continueGlobally = { label: l10n.t('Continue Globally') };
    const useExisting = { label: l10n.t('Use Existing Virtual Environment') };
    const createNew = { label: l10n.t('Create New Virtual Environment') };
    const { item: choice, toggled: rememberSelection } = await showQuickPickWithToggle(
        [continueGlobally, useExisting, createNew],
        {
            title: l10n.t('You are installing packages into a global Python environment'),
            placeHolder: l10n.t('Select where to install the packages'),
        },
        {
            off: { label: `$(circle-large-outline) ${l10n.t('Remember my selection')}`, alwaysShow: true },
            on: { label: `$(check) ${l10n.t('Remember my selection')}`, alwaysShow: true },
        },
    );

    if (choice?.label === createNew.label) {
        await waitForEnvManagerId([VENV_MANAGER_ID]);
        const venvManager = envManagers.getEnvironmentManager(VENV_MANAGER_ID);
        if (!venvManager?.supportsCreate) {
            throw new Error(l10n.t('The virtual environment manager is not available.'));
        }
        const createdEnvironment = await venvManager.create('global', { quickCreate: true });
        if (rememberSelection && createdEnvironment) {
            await state.set(GLOBAL_PACKAGE_INSTALLATION_SELECTION_KEY, {
                kind: 'environment',
                managerId: createdEnvironment.envId.managerId,
                environmentId: createdEnvironment.envId.id,
            });
        }
        return createdEnvironment;
    }

    if (choice?.label === useExisting.label) {
        const environments = await getEnvironments(envManagers, 'all');
        const virtualEnvironments = environments.filter(
            (candidate) =>
                !globalEnvironments.some((globalEnvironment) => hasSameEnvironmentId(candidate, globalEnvironment)),
        );
        const selectedEnvironment = await pickEnvironmentFrom(virtualEnvironments);
        if (rememberSelection && selectedEnvironment) {
            await state.set(GLOBAL_PACKAGE_INSTALLATION_SELECTION_KEY, {
                kind: 'environment',
                managerId: selectedEnvironment.envId.managerId,
                environmentId: selectedEnvironment.envId.id,
            });
        }
        return selectedEnvironment;
    }

    if (choice?.label === continueGlobally.label) {
        if (rememberSelection) {
            await state.set(GLOBAL_PACKAGE_INSTALLATION_SELECTION_KEY, { kind: 'global' });
        }
        return environment;
    }

    return undefined;
}
