import { CancellationToken } from 'vscode';
import { ENVS_EXTENSION_ID } from '../../common/constants';
import { getWorkspacePersistentState } from '../../common/persistentState';
import { throwIfCancelled } from '../../internal/pythonToolSupport';
import { NativeEnvInfo, NativePythonEnvironmentKind } from '../common/nativePythonFinder';
import { runPython } from './helpers';
import type { EnvironmentCreationBackend, EnvironmentCreationOptions } from './venvUtils';

export const VENV_WORKSPACE_KEY = `${ENVS_EXTENSION_ID}:venv:WORKSPACE_SELECTED`;
export const VENV_GLOBAL_KEY = `${ENVS_EXTENSION_ID}:venv:GLOBAL_SELECTED`;

/** Implements standard-library virtual environment creation, classification, and cache state. */
export class VenvEnvironmentManager implements EnvironmentCreationBackend {
    readonly usesUv = false;
    readonly cacheKeys = [VENV_WORKSPACE_KEY, VENV_GLOBAL_KEY] as const;

    /** Returns true when the native environment kind belongs to standard venv/virtualenv tools. */
    isSupportedKind(kind?: NativePythonEnvironmentKind): boolean {
        return (
            kind === NativePythonEnvironmentKind.venv ||
            kind === NativePythonEnvironmentKind.virtualEnv ||
            kind === NativePythonEnvironmentKind.virtualEnvWrapper
        );
    }

    /** Returns true when a discovered native environment should be included in the collection. */
    async shouldIncludeDiscovered(env: NativeEnvInfo): Promise<boolean> {
        return this.isSupportedKind(env.kind);
    }

    /** Returns true when a resolved native environment should be treated as a standard venv. */
    async shouldResolve(env: NativeEnvInfo): Promise<boolean> {
        return env.kind === NativePythonEnvironmentKind.venv;
    }

    /** Standard virtual environments do not add a tool-specific description badge. */
    getDescription(_kind?: NativePythonEnvironmentKind): string | undefined {
        return undefined;
    }

    /**
     * Creates a virtual environment with the selected base interpreter using `python -m venv`.
     * @param options Command inputs and execution policy prepared by the creation workflow.
     */
    async create(options: EnvironmentCreationOptions): Promise<void> {
        const { executable, environmentPath, cwd, log, token, timeout, toolExecution } = options;
        throwIfCancelled(token);
        await runPython(executable, ['-m', 'venv', environmentPath], cwd, log, token, timeout, toolExecution);
    }

    /** Standard virtual environments do not require extra tool tracking on creation or discovery. */
    async trackEnvironment(
        _environmentPath: string,
        _kind?: NativePythonEnvironmentKind,
        _token?: CancellationToken,
    ): Promise<void> {}

    /** Standard virtual environments do not require extra tool tracking cleanup on removal. */
    async untrackEnvironment(_environmentPath: string): Promise<void> {}

    /** Clears persisted workspace and global venv selection state. */
    async clearCache(): Promise<void> {
        const state = await getWorkspacePersistentState();
        await state.clear([...this.cacheKeys]);
    }
}
