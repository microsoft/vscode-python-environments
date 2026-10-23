import { CancellationToken, l10n } from 'vscode';
import { throwIfCancelled } from '../../internal/pythonToolSupport';
import { NativeEnvInfo, NativePythonEnvironmentKind } from '../common/nativePythonFinder';
import { getUvExecutable, runUV } from './helpers';
import { isUvManagedPythonInstall } from './utils';
import { addUvEnvironment, clearUvEnvironments, removeUvEnvironment, UV_ENVS_KEY } from './uvEnvironments';
import type { EnvironmentCreationBackend, EnvironmentCreationOptions } from './venvUtils';

/** Implements uv virtual environment creation, classification, descriptions, and persistence tracking. */
export class UvEnvironmentManager implements EnvironmentCreationBackend {
    readonly usesUv = true;
    readonly cacheKeys = [UV_ENVS_KEY] as const;

    /** Returns true when the native environment kind is a uv virtual environment or workspace. */
    isSupportedKind(kind?: NativePythonEnvironmentKind): boolean {
        return (
            kind === NativePythonEnvironmentKind.venvUv ||
            kind === NativePythonEnvironmentKind.uvWorkspace
        );
    }

    /**
     * Returns true when a discovered uv environment is a virtual environment rather than a
     * uv-managed base Python installation (which belongs to the Global manager).
     */
    async shouldIncludeDiscovered(env: NativeEnvInfo): Promise<boolean> {
        if (!this.isSupportedKind(env.kind)) {
            return false;
        }
        if (env.kind === NativePythonEnvironmentKind.venvUv && (await isUvManagedPythonInstall(env))) {
            return false;
        }
        return true;
    }

    /** Returns true when a resolved path is a uv virtual environment rather than a base Python install. */
    async shouldResolve(env: NativeEnvInfo): Promise<boolean> {
        return this.shouldIncludeDiscovered(env);
    }

    /** Returns the localized uv description badge for uv virtual environments and workspaces. */
    getDescription(kind?: NativePythonEnvironmentKind): string | undefined {
        if (kind === NativePythonEnvironmentKind.venvUv) {
            return l10n.t('uv');
        }
        if (kind === NativePythonEnvironmentKind.uvWorkspace) {
            return l10n.t('uv workspace');
        }
        return undefined;
    }

    /**
     * Creates a seeded virtual environment using the uv executable available to the creation scope.
     * @param options Command inputs and execution policy prepared by the creation workflow.
     */
    async create(options: EnvironmentCreationOptions): Promise<void> {
        const { executable, environmentPath, cwd, log, token, timeout, toolExecution } = options;
        throwIfCancelled(token);
        const uvExecutable = await getUvExecutable(log, cwd, token);
        if (!uvExecutable) {
            throw new Error(`uv became unavailable for workspace: ${cwd}`);
        }
        throwIfCancelled(token);
        await runUV(
            ['venv', '--verbose', '--seed', '--python', executable, environmentPath],
            cwd,
            log,
            token,
            timeout,
            uvExecutable,
            toolExecution,
        );
    }

    /** Records a created or discovered uv virtual environment in workspace persistent state. */
    async trackEnvironment(
        environmentPath: string,
        kind?: NativePythonEnvironmentKind,
        token?: CancellationToken,
    ): Promise<void> {
        if (this.isSupportedKind(kind)) {
            throwIfCancelled(token);
            await addUvEnvironment(environmentPath);
        }
    }

    /** Removes a deleted environment path from uv persistent state tracking. */
    async untrackEnvironment(environmentPath: string): Promise<void> {
        await removeUvEnvironment(environmentPath);
    }

    /** Clears all tracked uv virtual environments from workspace persistent state. */
    async clearCache(): Promise<void> {
        await clearUvEnvironments();
    }
}
