// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as fs from 'fs/promises';
import { pathExists } from 'fs-extra';
import * as path from 'path';
import { CancellationError, CancellationToken, Disposable, l10n, Uri } from 'vscode';
import {
    CONDA_MANAGER_ID,
    INLINE_SCRIPT_MANAGER_ID,
    PYENV_MANAGER_ID,
    SYSTEM_MANAGER_ID,
    VENV_MANAGER_ID,
} from '../common/constants';
import { traceError } from '../common/logging';
import { createDeferred } from '../common/utils/deferred';
import { resolveVariables } from '../common/utils/internalVariables';
import { isSameOrParentPath, normalizePath } from '../common/utils/pathUtils';
import { ProcessTerminationError, ProcessTimeoutError } from '../common/utils/processRunner';
import { handlePythonPath } from '../common/utils/pythonPath';
import { getWorkspaceFolder, getWorkspaceFolders, isWorkspaceTrusted } from '../common/workspace.apis';
import type { EnvironmentManagers } from '../features/envManagers';
import type { PythonProjectManager } from '../features/projectManager';
import { getDefaultEnvManagerSetting, getProjectEnvironmentManagerSetting } from '../features/settings/settingHelpers';
import { getUserConfiguredSetting } from '../helpers';
import type { InternalEnvironmentManager, InternalPackageManager } from '../managers/common/registeredManagers';
import type { PackageManagementOptions, PythonEnvironment } from '../types';
import type {
    PythonToolEnvironmentRequest,
    PythonToolInstallRequest,
    PythonToolQueryRequest,
    PythonToolResult,
    PythonToolsApi,
} from './pythonToolsApi';
import { PythonToolError, PythonToolOperation, throwIfCancelled, waitForToolRead } from './pythonToolSupport';

interface ToolTarget {
    readonly resource: Uri;
    readonly isDirectory: boolean;
}

export class PythonToolsApiImpl implements PythonToolsApi {
    readonly version = 1;
    private readonly pending = new Map<string, Promise<void>>();

    constructor(private readonly managers: EnvironmentManagers, private readonly projects: PythonProjectManager) {}

    configureEnvironment(request: PythonToolEnvironmentRequest, token: CancellationToken): Promise<PythonToolResult> {
        return this.run(request, token, async (target) => {
            const pythonPath =
                request.pythonPath === undefined ? undefined : parseAbsolutePath(request.pythonPath, 'pythonPath');
            const explicitEnvironment = pythonPath
                ? await this.resolveInterpreter(pythonPath, undefined, token)
                : undefined;
            if (pythonPath && !explicitEnvironment) {
                throw new PythonToolError(
                    'INVALID_PYTHON',
                    l10n.t('No Python environment could be resolved at {0}.', pythonPath.fsPath),
                );
            }
            const initialManager = pythonPath
                ? this.managers.getEnvironmentManager(target.resource)
                : await this.getConfigurationManager(target, token);
            const scope = this.selectionScope(target, initialManager);
            return this.serialize(scope, token, async () => {
                let environment: PythonEnvironment | undefined = explicitEnvironment;
                let created = false;
                try {
                    if (!pythonPath) {
                        let manager = await this.getConfigurationManager(target, token);
                        this.checkSelectionScope(target, manager, scope);
                        const selected = await this.getSelectedEnvironment(scope, manager, token);
                        environment = selected && (await this.isIsolated(selected, token)) ? selected : undefined;
                        if (!environment) {
                            manager = await this.getCreationManager(manager, token);
                        }
                        if (!environment && manager.tools?.resolveProject) {
                            environment = await waitForToolRead(manager.tools.resolveProject(scope), token);
                        }
                        if (!environment && (manager.id === VENV_MANAGER_ID || manager.id === CONDA_MANAGER_ID)) {
                            const prefix = Uri.file(
                                path.join(
                                    this.creationRoot(target, manager).fsPath,
                                    manager.id === VENV_MANAGER_ID ? '.venv' : '.conda',
                                ),
                            );
                            if (await pathExists(prefix.fsPath)) {
                                const resolved = await waitForToolRead(manager.tools!.resolve(prefix), token);
                                environment =
                                    resolved &&
                                    isSameOrParentPath(prefix.fsPath, resolved.sysPrefix) &&
                                    (await this.isIsolated(resolved, token))
                                        ? resolved
                                        : undefined;
                            }
                        }
                        if (!environment) {
                            if (!manager.tools?.create) {
                                throw new PythonToolError(
                                    'UNSUPPORTED_CREATION',
                                    l10n.t(
                                        'Manager {0} does not support non-interactive environment creation. Create an environment with that manager, then configure its Python path.',
                                        manager.id,
                                    ),
                                );
                            }
                            throwIfCancelled(token);
                            environment = await manager.tools.create(
                                manager.id === INLINE_SCRIPT_MANAGER_ID
                                    ? target.resource
                                    : this.creationRoot(target, manager),
                                this.operation(target, token, selected),
                            );
                            created = true;
                        }
                    }
                    if (!environment) {
                        throw new PythonToolError(
                            'ENVIRONMENT_NOT_FOUND',
                            l10n.t('No environment was returned for {0}.', scope.fsPath),
                        );
                    }
                    if (!pythonPath && !(await this.isIsolated(environment, token))) {
                        throw new PythonToolError(
                            'INVALID_ENVIRONMENT',
                            l10n.t('The environment manager did not return an isolated project environment.'),
                            environment,
                        );
                    }
                    await this.validateEnvironment(environment, token);
                    const described = await this.describeEnvironment(environment, token);
                    throwIfCancelled(token);
                    if (environment.envId.managerId !== INLINE_SCRIPT_MANAGER_ID) {
                        await this.ensureProject(scope);
                    }
                    this.checkSelectionScope(
                        target,
                        pythonPath
                            ? this.managers.getEnvironmentManager(target.resource)
                            : await this.getConfigurationManager(target, token),
                        scope,
                    );
                    throwIfCancelled(token);
                    await this.managers.setEnvironmentForTools(scope, environment, token);
                    return {
                        status: 'success',
                        environment: described,
                        resourcePath: scope.fsPath,
                        created,
                    };
                } catch (error) {
                    throw environment ? this.withEnvironment(error, environment, 'CONFIGURATION_FAILED') : error;
                }
            });
        });
    }

    getEnvironment(request: PythonToolQueryRequest, token: CancellationToken): Promise<PythonToolResult> {
        return this.run(request, token, async (target) => {
            if (request.includePackages !== undefined && typeof request.includePackages !== 'boolean') {
                throw new PythonToolError('INVALID_REQUEST', l10n.t('includePackages must be a boolean.'));
            }
            const initialManager = await this.getManager(target.resource, token);
            const scope = this.selectionScope(target, initialManager);
            return this.serialize(scope, token, async () => {
                const manager = await this.getManager(target.resource, token);
                this.checkSelectionScope(target, manager, scope);
                const environment = await this.getSelectedEnvironment(scope, manager, token);
                if (!environment) {
                    throw new PythonToolError(
                        'ENVIRONMENT_NOT_FOUND',
                        l10n.t(
                            'No Python environment is available for {0}. Configure an environment first.',
                            scope.fsPath,
                        ),
                    );
                }
                await this.validateEnvironment(environment, token);
                if (!request.includePackages) {
                    return {
                        status: 'success',
                        environment: await this.describeEnvironment(environment, token),
                        resourcePath: scope.fsPath,
                    };
                }
                try {
                    const packageManager = await this.getPackageManager(environment, token);
                    const packages = await packageManager.tools!.getPackages(
                        environment,
                        token,
                        this.creationRoot(target, manager),
                    );
                    return {
                        status: 'success',
                        environment: await this.describeEnvironment(environment, token),
                        resourcePath: scope.fsPath,
                        packages: packages.map((pkg) => ({
                            name: pkg.name,
                            ...(pkg.version ? { version: String(pkg.version) } : {}),
                        })),
                    };
                } catch (error) {
                    throw this.withEnvironment(error, environment, 'PACKAGE_QUERY_FAILED');
                }
            });
        });
    }

    installPackages(request: PythonToolInstallRequest, token: CancellationToken): Promise<PythonToolResult> {
        return this.run(request, token, async (target) => {
            if (
                !Array.isArray(request.packages) ||
                request.packages.length === 0 ||
                request.packages.some(
                    (pkg) =>
                        typeof pkg !== 'string' || !pkg.trim() || pkg.trim().startsWith('-') || /[\0\r\n]/.test(pkg),
                )
            ) {
                throw new PythonToolError(
                    'INVALID_REQUEST',
                    l10n.t('packages must be a non-empty array of package specifications, not command-line options.'),
                );
            }
            const initialManager = await this.getManager(target.resource, token);
            const scope = this.selectionScope(target, initialManager);
            return this.serialize(scope, token, async () => {
                const manager = await this.getManager(target.resource, token);
                this.checkSelectionScope(target, manager, scope);
                const environment = await this.getSelectedEnvironment(scope, manager, token);
                if (environment?.envId.managerId === INLINE_SCRIPT_MANAGER_ID) {
                    throw new PythonToolError(
                        'IMMUTABLE_ENVIRONMENT',
                        l10n.t(
                            "Inline-script environments are shared immutable caches. Edit the script's PEP 723 dependencies, then configure its environment again instead of installing packages directly.",
                        ),
                        environment,
                    );
                }
                if (!environment) {
                    throw new PythonToolError(
                        'ENVIRONMENT_NOT_CONFIGURED',
                        l10n.t('Configure an environment for {0} before installing packages.', scope.fsPath),
                    );
                }
                if (!(await this.isIsolated(environment, token))) {
                    throw new PythonToolError(
                        'ENVIRONMENT_NOT_ISOLATED',
                        l10n.t(
                            'Global and base Python environments are not modified by package tools. Configure {0} without pythonPath to create a project environment, or select an existing isolated environment.',
                            scope.fsPath,
                        ),
                        environment,
                    );
                }
                await this.validateEnvironment(environment, token);
                try {
                    const described = await this.describeEnvironment(environment, token);
                    await this.operation(target, token).managePackages(environment, {
                        install: request.packages.map((pkg) => pkg.trim()),
                        runHeadless: true,
                    });
                    return {
                        status: 'success',
                        environment: described,
                        resourcePath: scope.fsPath,
                    };
                } catch (error) {
                    throw this.withEnvironment(error, environment, 'PACKAGE_INSTALL_FAILED');
                }
            });
        });
    }

    private async run(
        request: unknown,
        token: CancellationToken,
        action: (target: ToolTarget) => Promise<PythonToolResult>,
    ): Promise<PythonToolResult> {
        let target: ToolTarget | undefined;
        try {
            if (
                !token ||
                typeof token.isCancellationRequested !== 'boolean' ||
                typeof token.onCancellationRequested !== 'function'
            ) {
                throw new PythonToolError('INVALID_REQUEST', l10n.t('A cancellation token is required.'));
            }
            throwIfCancelled(token);
            if (!isWorkspaceTrusted()) {
                throw new PythonToolError(
                    'WORKSPACE_UNTRUSTED',
                    l10n.t('Trust this workspace before running Python environment tools.'),
                );
            }
            if (!request || typeof request !== 'object' || Array.isArray(request)) {
                throw new PythonToolError('INVALID_REQUEST', l10n.t('An environment tool request object is required.'));
            }
            target = await this.resolveTarget('resourcePath' in request ? request.resourcePath : undefined, token);
            return await action(target);
        } catch (error) {
            const terminationFailed =
                error instanceof ProcessTerminationError ||
                (error instanceof PythonToolError && error.code === 'PROCESS_TERMINATION_FAILED');
            if (!terminationFailed && (error instanceof CancellationError || token?.isCancellationRequested)) {
                throw new CancellationError();
            }
            traceError('Python environment tool failed:', error);
            return {
                status: 'error',
                code:
                    error instanceof PythonToolError
                        ? error.code
                        : error instanceof ProcessTerminationError
                        ? 'PROCESS_TERMINATION_FAILED'
                        : error instanceof ProcessTimeoutError
                        ? 'TIMEOUT'
                        : 'OPERATION_FAILED',
                message: error instanceof Error ? error.message : String(error),
                ...(error instanceof PythonToolError && error.environment ? { environment: error.environment } : {}),
                ...(target ? { resourcePath: target.resource.fsPath } : {}),
            };
        }
    }

    private async resolveTarget(resourcePath: unknown, token: CancellationToken): Promise<ToolTarget> {
        let resource: Uri;
        if (resourcePath === undefined) {
            const folders = getWorkspaceFolders() ?? [];
            if (folders.length !== 1) {
                throw new PythonToolError(
                    folders.length === 0 ? 'NO_WORKSPACE' : 'AMBIGUOUS_RESOURCE',
                    folders.length === 0
                        ? l10n.t('Open a workspace folder and provide its absolute resourcePath.')
                        : l10n.t(
                              'Specify resourcePath to choose one of these workspace folders: {0}',
                              folders.map((folder) => folder.uri.fsPath).join(', '),
                          ),
                );
            }
            resource = folders[0].uri;
        } else {
            resource = parseAbsolutePath(resourcePath, 'resourcePath');
        }
        if (resource.scheme !== 'file' || !getWorkspaceFolder(resource)) {
            throw new PythonToolError(
                'INVALID_RESOURCE',
                l10n.t('Open {0} in a local workspace folder before configuring its environment.', resource.fsPath),
            );
        }
        const stat = await waitForToolRead(fs.stat(resource.fsPath), token);
        if (!stat.isFile() && !stat.isDirectory()) {
            throw new PythonToolError('INVALID_RESOURCE', l10n.t('resourcePath must identify a file or directory.'));
        }
        return { resource, isDirectory: stat.isDirectory() };
    }

    private async getConfigurationManager(
        target: ToolTarget,
        token: CancellationToken,
    ): Promise<InternalEnvironmentManager> {
        const inline = this.managers.getEnvironmentManager(INLINE_SCRIPT_MANAGER_ID);
        if (
            !target.isDirectory &&
            inline?.tools?.canConfigure &&
            (await waitForToolRead(inline.tools.canConfigure(target.resource), token))
        ) {
            await waitForToolRead(inline.tools.initialize(), token);
            return inline;
        }
        return this.getManager(target.resource, token);
    }

    private async getManager(scope: Uri, token: CancellationToken): Promise<InternalEnvironmentManager> {
        const project = this.projects.get(scope);
        const explicitManagerId =
            getProjectEnvironmentManagerSetting(this.projects, project?.uri ?? scope) ??
            getUserConfiguredSetting<string>('python-envs', 'defaultEnvManager', scope);
        const configuredId = explicitManagerId ?? getDefaultEnvManagerSetting(this.projects, scope);
        try {
            await this.waitForRegistration(
                () => this.managers.getEnvironmentManager(configuredId),
                this.managers.onDidChangeEnvironmentManager,
                token,
            );
        } catch (error) {
            if (error instanceof PythonToolError && error.code === 'NOT_READY') {
                throw new PythonToolError(
                    'UNSUPPORTED_MANAGER',
                    l10n.t(
                        'The environment manager {0} is not registered. Install the extension that provides it, or configure a different environment manager.',
                        configuredId,
                    ),
                );
            }
            throw error;
        }
        const routed = this.managers.getEnvironmentManager(scope);
        const manager =
            routed?.id === INLINE_SCRIPT_MANAGER_ID || !explicitManagerId
                ? routed
                : this.managers.getEnvironmentManager(explicitManagerId);
        if (!manager?.tools) {
            throw new PythonToolError(
                'UNSUPPORTED_MANAGER',
                l10n.t(
                    'The selected environment manager {0} does not provide non-interactive tool support.',
                    manager?.id ?? configuredId,
                ),
            );
        }
        await waitForToolRead(manager.tools.initialize(), token);
        return manager;
    }

    private async getSelectedEnvironment(
        scope: Uri,
        manager: InternalEnvironmentManager,
        token: CancellationToken,
    ): Promise<PythonEnvironment | undefined> {
        const selectedEnvironment = this.managers.getLastKnownEnvironment(scope);
        const interpreterSetting = getUserConfiguredSetting<string>('python', 'defaultInterpreterPath', scope);
        const hasManagerSetting =
            getProjectEnvironmentManagerSetting(this.projects, this.projects.get(scope)?.uri ?? scope) ||
            getUserConfiguredSetting<string>('python-envs', 'defaultEnvManager', scope);
        if (interpreterSetting && !hasManagerSetting && !selectedEnvironment) {
            const interpreter = parseAbsolutePath(
                resolveVariables(interpreterSetting, scope),
                'python.defaultInterpreterPath',
            );
            const environment = await this.resolveInterpreter(interpreter, manager, token);
            if (!environment) {
                throw new PythonToolError(
                    'INVALID_PYTHON',
                    l10n.t('The configured interpreter at {0} could not be resolved.', interpreter.fsPath),
                );
            }
            return environment;
        }
        return waitForToolRead(manager.tools!.get(scope), token);
    }

    private async isIsolated(environment: PythonEnvironment, token: CancellationToken): Promise<boolean> {
        if (environment.envId.managerId === INLINE_SCRIPT_MANAGER_ID) {
            return true;
        }
        if (environment.envId.managerId === CONDA_MANAGER_ID) {
            return environment.name !== 'base' || environment.group === 'Prefix';
        }
        return waitForToolRead(pathExists(path.join(environment.sysPrefix, 'pyvenv.cfg')), token);
    }

    private async getCreationManager(
        manager: InternalEnvironmentManager,
        token: CancellationToken,
    ): Promise<InternalEnvironmentManager> {
        if (manager.id !== SYSTEM_MANAGER_ID && manager.id !== PYENV_MANAGER_ID) {
            return manager;
        }
        const venv = await this.waitForRegistration(
            () => this.managers.getEnvironmentManager(VENV_MANAGER_ID),
            this.managers.onDidChangeEnvironmentManager,
            token,
        );
        if (!venv.tools?.create) {
            throw new PythonToolError(
                'UNSUPPORTED_CREATION',
                l10n.t('The venv manager is not available to create an isolated project environment.'),
            );
        }
        await waitForToolRead(venv.tools.initialize(), token);
        return venv;
    }

    private selectionScope(target: ToolTarget, manager: InternalEnvironmentManager | undefined): Uri {
        return target.isDirectory || manager?.id === INLINE_SCRIPT_MANAGER_ID
            ? target.resource
            : this.projects.get(target.resource)?.uri ?? Uri.file(path.dirname(target.resource.fsPath));
    }

    private checkSelectionScope(
        target: ToolTarget,
        manager: InternalEnvironmentManager | undefined,
        expected: Uri,
    ): void {
        if (normalizePath(this.selectionScope(target, manager).fsPath) !== normalizePath(expected.fsPath)) {
            throw new PythonToolError(
                'RESOURCE_CHANGED',
                l10n.t('The project scope changed while this operation was queued. Retry the operation.'),
            );
        }
    }

    private creationRoot(target: ToolTarget, manager: InternalEnvironmentManager | undefined): Uri {
        const scope = this.selectionScope(target, manager);
        if (manager?.id === INLINE_SCRIPT_MANAGER_ID) {
            return Uri.file(path.dirname(target.resource.fsPath));
        }
        const project = this.projects.get(scope);
        return target.isDirectory
            ? scope
            : project && project.uri.toString() !== target.resource.toString()
            ? project.uri
            : Uri.file(path.dirname(scope.fsPath));
    }

    private async ensureProject(scope: Uri): Promise<void> {
        if (
            this.projects
                .getProjects()
                .some((project) => normalizePath(project.uri.fsPath) === normalizePath(scope.fsPath))
        ) {
            return;
        }
        await this.projects.add(this.projects.create(path.basename(scope.fsPath), scope), { persistSettings: false });
    }

    private async resolveInterpreter(
        interpreter: Uri,
        preferred: InternalEnvironmentManager | undefined,
        token: CancellationToken,
    ): Promise<PythonEnvironment | undefined> {
        await this.waitForRegistration(
            () => this.managers.getEnvironmentManager(SYSTEM_MANAGER_ID),
            this.managers.onDidChangeEnvironmentManager,
            token,
        );
        const available: InternalEnvironmentManager[] = [];
        for (const manager of this.managers.managers.filter((candidate) => candidate.tools)) {
            try {
                await waitForToolRead(manager.tools!.initialize(), token);
                available.push(manager);
            } catch (error) {
                if (error instanceof CancellationError) {
                    throw error;
                }
                traceError(`Skipping unavailable interpreter resolver ${manager.id}:`, error);
            }
        }
        if (available.length === 0) {
            throw new PythonToolError('NOT_READY', l10n.t('No supported Python interpreter resolver is ready.'));
        }
        return waitForToolRead(
            handlePythonPath(
                interpreter,
                available,
                preferred && available.includes(preferred) ? [preferred] : [],
                undefined,
                token,
                true,
            ),
            token,
        );
    }

    private async validateEnvironment(environment: PythonEnvironment, token: CancellationToken): Promise<void> {
        const executable = environment.execInfo?.run.executable;
        if (!executable || !path.isAbsolute(executable) || environment.version === 'no-python') {
            throw new PythonToolError(
                'INVALID_ENVIRONMENT',
                l10n.t('The selected environment does not have a usable Python executable.'),
                environment,
            );
        }
        try {
            const stat = await waitForToolRead(fs.stat(executable), token);
            if (!stat.isFile()) {
                throw new Error(l10n.t('The Python executable is not a file.'));
            }
        } catch (error) {
            throw this.withEnvironment(error, environment, 'INVALID_ENVIRONMENT');
        }
    }

    private async describeEnvironment(
        environment: PythonEnvironment,
        token: CancellationToken,
    ): Promise<PythonEnvironment> {
        const describe = this.managers.getEnvironmentManager(environment)?.tools?.describe;
        return describe ? waitForToolRead(describe(environment, token), token) : environment;
    }

    private operation(
        target: ToolTarget,
        token: CancellationToken,
        baseEnvironment?: PythonEnvironment,
    ): PythonToolOperation {
        return {
            token,
            baseEnvironment,
            getGlobalEnvironments: async () => {
                const environments: PythonEnvironment[] = [];
                for (const id of [SYSTEM_MANAGER_ID, CONDA_MANAGER_ID, PYENV_MANAGER_ID]) {
                    const manager = this.managers.getEnvironmentManager(id);
                    if (manager?.tools) {
                        await waitForToolRead(manager.tools.initialize(), token);
                        environments.push(...(await waitForToolRead(manager.tools.getEnvironments('global'), token)));
                    }
                }
                return environments;
            },
            managePackages: async (environment: PythonEnvironment, options: PackageManagementOptions) => {
                const manager = await this.getPackageManager(environment, token);
                throwIfCancelled(token);
                const scope = this.creationRoot(target, this.managers.getEnvironmentManager(target.resource));
                await manager.tools!.manage(environment, { ...options, runHeadless: true }, token, scope);
            },
        };
    }

    private async getPackageManager(
        environment: PythonEnvironment,
        token: CancellationToken,
    ): Promise<InternalPackageManager> {
        const manager = await this.waitForRegistration(
            () => this.managers.getPackageManager(environment),
            this.managers.onDidChangePackageManager,
            token,
        );
        if (!manager.tools) {
            throw new PythonToolError(
                'UNSUPPORTED_PACKAGE_MANAGER',
                l10n.t('Package manager {0} does not provide non-interactive tool support.', manager.id),
                environment,
            );
        }
        return manager;
    }

    private async waitForRegistration<T>(
        get: () => T | undefined,
        subscribe: (listener: () => void) => Disposable,
        token: CancellationToken,
    ): Promise<T> {
        const existing = get();
        if (existing) {
            return existing;
        }
        let subscription: Disposable | undefined;
        try {
            const pending = new Promise<T>((resolve) => {
                const check = () => {
                    const value = get();
                    if (value) {
                        resolve(value);
                    }
                };
                subscription = subscribe(check);
                check();
            });
            return await waitForToolRead(pending, token);
        } finally {
            subscription?.dispose();
        }
    }

    private async serialize<T>(scope: Uri, token: CancellationToken, action: () => Promise<T>): Promise<T> {
        const key = normalizePath(path.resolve(scope.fsPath));
        const prior = this.pending.get(key) ?? Promise.resolve();
        const release = createDeferred<void>();
        const tail = prior.then(() => release.promise);
        this.pending.set(key, tail);
        void tail.then(() => {
            if (this.pending.get(key) === tail) {
                this.pending.delete(key);
            }
        });
        try {
            await waitForToolRead(prior, token, null);
            throwIfCancelled(token);
            return await action();
        } finally {
            release.resolve();
        }
    }

    private withEnvironment(error: unknown, environment: PythonEnvironment, code: string): Error {
        if (error instanceof CancellationError) {
            return error;
        }
        return new PythonToolError(
            error instanceof PythonToolError
                ? error.code
                : error instanceof ProcessTerminationError
                ? 'PROCESS_TERMINATION_FAILED'
                : error instanceof ProcessTimeoutError
                ? 'TIMEOUT'
                : code,
            error instanceof Error ? error.message : String(error),
            environment,
        );
    }
}

function parseAbsolutePath(value: unknown, name: string): Uri {
    if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) {
        throw new PythonToolError('INVALID_REQUEST', l10n.t('{0} must be an absolute path or file URI.', name));
    }
    const uri = path.isAbsolute(value) ? Uri.file(value) : /^file:/i.test(value) ? Uri.parse(value) : undefined;
    if (!uri || uri.scheme !== 'file' || uri.query || uri.fragment || !path.isAbsolute(uri.fsPath)) {
        throw new PythonToolError('INVALID_REQUEST', l10n.t('{0} must be an absolute path or file URI.', name));
    }
    return uri;
}
