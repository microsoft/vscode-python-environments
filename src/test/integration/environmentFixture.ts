// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as path from 'path';
import type { ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi } from '../../api';
import { spawnProcess } from '../../common/childProcess.apis';
import { CONDA_MANAGER_ID, VENV_MANAGER_ID } from '../../common/constants';
import { normalizePath } from '../../common/utils/pathUtils';
import { PythonProjectSettings } from '../../internal.api';
import { waitForCondition } from '../testUtils';

const OWNERSHIP_FILE_NAME = '.python-envs-test-owner.json';
const COMMAND_TIMEOUT_MS = 180_000;
const DISCOVERY_TIMEOUT_MS = 60_000;
const API_REMOVAL_SETTLE_TIMEOUT_MS = 10_000;

export interface EnvironmentFixtureProvider {
    readonly environmentDirectory: string;
    readonly managerId: string;
    create(
        api: PythonEnvironmentApi,
        prefix: vscode.Uri,
        projectUri: vscode.Uri,
    ): Promise<PythonEnvironment | undefined>;
    discover(
        api: PythonEnvironmentApi,
        prefix: vscode.Uri,
        projectUri: vscode.Uri,
    ): Promise<PythonEnvironment | undefined>;
    remove(prefix: vscode.Uri): Promise<void>;
}

export interface EnvironmentFixtureRequest {
    readonly name: string;
    readonly packageManagerId: string;
    readonly provider: EnvironmentFixtureProvider;
}

export interface EnvironmentFixture {
    readonly environment: PythonEnvironment;
    readonly prefix: vscode.Uri;
    readonly projectUri: vscode.Uri;
    dispose(): Promise<void>;
}

interface CommandResult {
    stdout: string;
    stderr: string;
}

/**
 * Creates an isolated environment owned by the integration test and returns a lease that removes it.
 *
 * @param api The activated Python Environments extension API.
 * @param workspaceFolder Workspace folder that owns the temporary test project.
 * @param request Environment and package manager configuration for the fixture.
 */
export async function createEnvironmentFixture(
    api: PythonEnvironmentApi,
    workspaceFolder: vscode.WorkspaceFolder,
    request: EnvironmentFixtureRequest,
): Promise<EnvironmentFixture> {
    const token = randomUUID();
    const fixtureName = `pyenvs-${sanitizeName(request.name).slice(0, 8)}-${process.pid}-${token.slice(0, 8)}`;
    const projectUri = vscode.Uri.file(path.join(os.tmpdir(), fixtureName));
    const prefix = vscode.Uri.joinPath(projectUri, request.provider.environmentDirectory);
    const markerUri = vscode.Uri.joinPath(projectUri, OWNERSHIP_FILE_NAME);
    const config = vscode.workspace.getConfiguration('python-envs', workspaceFolder.uri);
    const previousPythonProjects = config.inspect<PythonProjectSettings[]>('pythonProjects')?.workspaceFolderValue;
    let projectSettingAdded = false;
    let environmentCreated = false;
    let environment: PythonEnvironment | undefined;
    let disposePromise: Promise<void> | undefined;
    let markerWritten = false;
    let projectRootCreated = false;

    const cleanup = async (): Promise<void> => {
        const cleanupErrors: Error[] = [];
        let environmentRemovalPending = false;

        if (markerWritten && (environmentCreated || (await pathExists(prefix)))) {
            let ownershipVerified = false;
            try {
                await verifyOwnership(projectUri, markerUri, token, prefix);
                ownershipVerified = true;
            } catch (error) {
                cleanupErrors.push(toError(error));
            }
            if (ownershipVerified && environment) {
                let apiRemovalSettled = false;
                const apiRemoval = api
                    .removeEnvironment(environment, { runHeadless: true })
                    .finally(() => {
                        apiRemovalSettled = true;
                    });
                try {
                    await withTimeout(
                        apiRemoval,
                        COMMAND_TIMEOUT_MS,
                        `${request.name} API environment removal timed out`,
                    );
                } catch (error) {
                    cleanupErrors.push(toError(error));
                    if (!apiRemovalSettled) {
                        try {
                            await withTimeout(
                                apiRemoval,
                                API_REMOVAL_SETTLE_TIMEOUT_MS,
                                `${request.name} API environment removal did not settle after timing out`,
                            );
                        } catch (settleError) {
                            if (apiRemovalSettled) {
                                cleanupErrors.push(toError(settleError));
                            } else {
                                environmentRemovalPending = true;
                                cleanupErrors.push(
                                    new Error(
                                        `${request.name} direct cleanup was skipped because API removal is still running`,
                                    ),
                                );
                            }
                        }
                    }
                }
            }
            if (ownershipVerified && (await pathExists(prefix))) {
                cleanupErrors.push(
                    new Error(`${request.name} API removal left the environment on disk: ${prefix.fsPath}`),
                );
                if (!environmentRemovalPending) {
                    try {
                        await request.provider.remove(prefix);
                        await assertPathMissing(prefix, `${request.name} environment was not removed`);
                    } catch (error) {
                        cleanupErrors.push(toError(error));
                    }
                }
            }
            if (ownershipVerified && !(await pathExists(prefix))) {
                environmentCreated = false;
                environment = undefined;
            }
        }

        try {
            await api.setEnvironment(projectUri, undefined);
        } catch (error) {
            cleanupErrors.push(toError(error));
        }

        if (projectSettingAdded) {
            try {
                await config.update(
                    'pythonProjects',
                    previousPythonProjects,
                    vscode.ConfigurationTarget.WorkspaceFolder,
                );
                await waitForCondition(
                    () =>
                        !api
                            .getPythonProjects()
                            .some((project) => pathsEqual(project.uri.fsPath, projectUri.fsPath)),
                    10_000,
                    `Python project was not unregistered: ${projectUri.fsPath}`,
                );
            } catch (error) {
                cleanupErrors.push(toError(error));
            }
        }

        if (!environmentRemovalPending && projectRootCreated && (await pathExists(projectUri))) {
            try {
                if (markerWritten) {
                    await verifyOwnership(projectUri, markerUri, token, prefix);
                } else if (environmentCreated) {
                    throw new Error(`Refusing to remove an unmarked fixture after environment creation: ${projectUri.fsPath}`);
                }
                await vscode.workspace.fs.delete(projectUri, { recursive: true, useTrash: false });
            } catch (error) {
                cleanupErrors.push(toError(error));
            }
        }

        if (cleanupErrors.length > 0) {
            throw new Error(cleanupErrors.map((error) => error.message).join('\n'));
        }
    };

    const dispose = (): Promise<void> => {
        if (!disposePromise) {
            disposePromise = cleanup().catch((error) => {
                disposePromise = undefined;
                throw error;
            });
        }
        return disposePromise;
    };

    try {
        await assertPathMissing(projectUri, `Fixture directory already exists: ${projectUri.fsPath}`);
        await vscode.workspace.fs.createDirectory(projectUri);
        projectRootCreated = true;
        await vscode.workspace.fs.writeFile(
            markerUri,
            Buffer.from(JSON.stringify({ managerId: request.provider.managerId, token }), 'utf8'),
        );
        markerWritten = true;

        const pythonProjects = config.get<PythonProjectSettings[]>('pythonProjects', []);
        const projectSetting: PythonProjectSettings = {
            path: projectUri.fsPath,
            envManager: request.provider.managerId,
            packageManager: request.packageManagerId,
            workspace: workspaceFolder.name,
        };
        await config.update(
            'pythonProjects',
            [...pythonProjects, projectSetting],
            vscode.ConfigurationTarget.WorkspaceFolder,
        );
        projectSettingAdded = true;

        await waitForCondition(
            () => api.getPythonProjects().some((project) => pathsEqual(project.uri.fsPath, projectUri.fsPath)),
            10_000,
            `Python project was not registered: ${projectUri.fsPath}`,
        );

        environment = await request.provider.create(api, prefix, projectUri);
        environmentCreated = true;

        const candidate =
            environment ??
            (await withTimeout(
                request.provider.discover(api, prefix, projectUri),
                DISCOVERY_TIMEOUT_MS,
                `${request.name} environment discovery timed out`,
            ));
        if (
            candidate?.envId.managerId !== request.provider.managerId ||
            !(await canonicalPathsEqual(candidate.sysPrefix, prefix.fsPath))
        ) {
            throw new Error(
                `${request.name} environment was not discovered: ${prefix.fsPath}. Resolved environment: ${
                    candidate ? `${candidate.envId.managerId} (${candidate.sysPrefix})` : 'none'
                }`,
            );
        }
        environment = candidate;

        return {
            environment,
            prefix,
            projectUri,
            dispose,
        };
    } catch (error) {
        try {
            await dispose();
        } catch (cleanupError) {
            throw new Error(
                `${request.name} fixture setup failed: ${toError(error).message}\nCleanup failed: ${toError(cleanupError).message}`,
            );
        }
        throw error;
    }
}

/**
 * Creates a provider for standard-library virtual environments.
 */
export function createVenvFixtureProvider(): EnvironmentFixtureProvider {
    return {
        environmentDirectory: '.venv',
        managerId: VENV_MANAGER_ID,
        create: async (_api, prefix) => {
            await runFixtureCommand('python', ['-m', 'venv', prefix.fsPath]);
            return undefined;
        },
        discover: async (_api, prefix) =>
            resolveEnvironmentWithManager(
                VENV_MANAGER_ID,
                vscode.Uri.joinPath(
                    prefix,
                    process.platform === 'win32' ? 'Scripts' : 'bin',
                    process.platform === 'win32' ? 'python.exe' : 'python',
                ),
            ),
        remove: async (prefix) => {
            if (await pathExists(prefix)) {
                await vscode.workspace.fs.delete(prefix, { recursive: true, useTrash: false });
            }
        },
    };
}

/**
 * Creates a provider for Conda environments.
 */
export function createCondaFixtureProvider(): EnvironmentFixtureProvider {
    return {
        environmentDirectory: '.conda',
        managerId: CONDA_MANAGER_ID,
        create: async (_api, prefix) => {
            const version = await runFixtureCommand('python', [
                '-c',
                'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")',
            ]);
            await runFixtureCommand(await getCondaExecutable(), [
                'create',
                '--yes',
                '--prefix',
                prefix.fsPath,
                `python=${version.stdout.trim()}`,
            ]);
            return undefined;
        },
        discover: async (_api, prefix) => resolveEnvironmentWithManager(CONDA_MANAGER_ID, prefix),
        remove: async (prefix) => {
            if (await pathExists(prefix)) {
                await runFixtureCommand(await getCondaExecutable(), [
                    'env',
                    'remove',
                    '--yes',
                    '--prefix',
                    prefix.fsPath,
                ]);
            }
        },
    };
}

async function runFixtureCommand(command: string, args: string[], cwd?: vscode.Uri): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
        const child = spawnProcess(command, args, {
            cwd: cwd?.fsPath,
            detached: process.platform !== 'win32',
            stdio: 'pipe',
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timedOut = false;
        let forceTimer: NodeJS.Timeout | undefined;
        const finish = (error?: Error, result?: CommandResult) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            if (forceTimer) {
                clearTimeout(forceTimer);
            }
            if (error) {
                reject(error);
            } else {
                resolve(result ?? { stdout, stderr });
            }
        };
        const timer = setTimeout(() => {
            timedOut = true;
            const timeoutError = new Error(
                `${command} ${args.join(' ')} timed out after ${COMMAND_TIMEOUT_MS}ms`,
            );
            void terminateProcessTree(child).catch((error) => {
                finish(new Error(`${timeoutError.message}\nFailed to terminate process tree: ${toError(error).message}`));
            });
            forceTimer = setTimeout(() => finish(timeoutError), 10_000);
        }, COMMAND_TIMEOUT_MS);

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (data: string) => {
            stdout += data;
        });
        child.stderr.on('data', (data: string) => {
            stderr += data;
        });
        child.on('error', (error) => {
            finish(timedOut ? new Error(`${command} timed out and failed to terminate: ${error.message}`) : error);
        });
        child.on('close', (code) => {
            if (timedOut) {
                finish(new Error(`${command} ${args.join(' ')} timed out after ${COMMAND_TIMEOUT_MS}ms`));
                return;
            }
            if (code === 0) {
                finish(undefined, { stdout, stderr });
                return;
            }
            finish(
                new Error(
                    `${command} ${args.join(' ')} exited with code ${code}\n${stderr.trim() || stdout.trim()}`,
                ),
            );
        });
    });
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
    if (!child.pid) {
        child.kill('SIGKILL');
        return;
    }
    if (process.platform !== 'win32') {
        try {
            process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
                throw error;
            }
        }
        return;
    }

    await new Promise<void>((resolve, reject) => {
        const killer = spawnProcess('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
        });
        killer.on('error', reject);
        killer.on('close', (code) => {
            if (code === 0 || child.exitCode !== null) {
                resolve();
            } else {
                reject(new Error(`taskkill exited with code ${code}`));
            }
        });
    });
}

async function getCondaExecutable(): Promise<string> {
    const condaRoot = process.env.CONDA;
    if (condaRoot) {
        const executable =
            process.platform === 'win32'
                ? path.join(condaRoot, 'Scripts', 'conda.exe')
                : path.join(condaRoot, 'bin', 'conda');
        try {
            await fs.access(executable);
            return executable;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT') {
                throw error;
            }
        }
    }
    return process.platform === 'win32' ? 'conda.exe' : 'conda';
}

async function resolveEnvironmentWithManager(
    managerId: string,
    environmentUri: vscode.Uri,
): Promise<PythonEnvironment | undefined> {
    return vscode.commands.executeCommand<PythonEnvironment | undefined>(
        'python-envs.test.resolveEnvironmentWithManager',
        managerId,
        environmentUri,
    );
}

async function verifyOwnership(
    projectUri: vscode.Uri,
    markerUri: vscode.Uri,
    token: string,
    prefix: vscode.Uri,
): Promise<void> {
    if (!isPathWithin(projectUri.fsPath, prefix.fsPath)) {
        throw new Error(`Refusing to remove environment outside fixture root: ${prefix.fsPath}`);
    }
    const marker = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(markerUri)).toString('utf8')) as {
        token?: string;
    };
    if (marker.token !== token) {
        throw new Error(`Refusing to remove fixture without matching ownership marker: ${projectUri.fsPath}`);
    }
}

function isPathWithin(parent: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function pathsEqual(first: string, second: string): boolean {
    const firstPath = path.resolve(vscode.Uri.file(first).fsPath);
    const secondPath = path.resolve(vscode.Uri.file(second).fsPath);
    return normalizePath(firstPath) === normalizePath(secondPath);
}

async function canonicalPathsEqual(first: string, second: string): Promise<boolean> {
    const [firstPath, secondPath] = await Promise.all([canonicalPath(first), canonicalPath(second)]);
    return normalizePath(firstPath) === normalizePath(secondPath);
}

async function canonicalPath(value: string): Promise<string> {
    return await fs.realpath(path.resolve(vscode.Uri.file(value).fsPath));
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
            return false;
        }
        throw error;
    }
}

async function assertPathMissing(uri: vscode.Uri, message: string): Promise<void> {
    if (await pathExists(uri)) {
        throw new Error(message);
    }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${message} after ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

function sanitizeName(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
