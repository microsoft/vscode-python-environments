// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { Package, PackageManager, PythonEnvironment, PythonEnvironmentApi, PythonProject } from '../../api';
import { ENVS_EXTENSION_ID } from '../constants';
import { waitForCondition } from '../testUtils';
import {
    ActivePackageManagerFixture,
    CapabilityExpectation,
    packageManagerFixtures,
    PackageManagerProfile,
} from './packageManagerFixtures';

const EXPECTED_REGISTERED_MANAGER_IDS = packageManagerFixtures.map((fixture) => fixture.id);

type ActivePackageManagerProfile = Extract<PackageManagerProfile, { status: 'active' }>;

interface RegisteredPackageManager {
    readonly id: string;
    readonly manager: PackageManager;
}

interface IntegrationTestApi extends PythonEnvironmentApi {
    getRegisteredPackageManagersForTests(): readonly RegisteredPackageManager[];
}

interface SettingSnapshot<T> {
    readonly key: string;
    readonly value: T | undefined;
    readonly target: vscode.ConfigurationTarget;
}

class PrerequisiteUnavailable extends Error {}

suite('Integration: Package manager lifecycles', function () {
    this.timeout(900_000);

    let api: IntegrationTestApi;
    let workspaceFolder: vscode.WorkspaceFolder;

    suiteSetup(async function () {
        this.timeout(120_000);

        const extension = vscode.extensions.getExtension(ENVS_EXTENSION_ID);
        assert.ok(extension, `Bootstrap: extension ${ENVS_EXTENSION_ID} was not found`);
        if (!extension.isActive) {
            await extension.activate();
        }

        api = extension.exports as IntegrationTestApi;
        assert.ok(api, 'Bootstrap: extension API was not exported');
        assert.strictEqual(
            typeof api.getRegisteredPackageManagersForTests,
            'function',
            'Bootstrap: integration-test package-manager bridge was not exposed',
        );

        const folders = vscode.workspace.workspaceFolders;
        assert.ok(folders && folders.length > 0, 'Bootstrap: integration tests require a workspace folder');
        workspaceFolder = folders[0];

        await waitForCondition(
            () => EXPECTED_REGISTERED_MANAGER_IDS.every((id) => registeredManagers(api).has(id)),
            90_000,
            () =>
                `Bootstrap: package managers did not finish registering; found ${[
                    ...registeredManagers(api).keys(),
                ].join(', ')}`,
        );
    });

    test('fixture list exactly covers every live registered package manager', () => {
        const registeredIds = [...registeredManagers(api).keys()].sort();
        const fixtureIds = packageManagerFixtures.map((fixture) => fixture.id).sort();

        assert.strictEqual(
            new Set(fixtureIds).size,
            fixtureIds.length,
            'Registry completeness: fixture IDs must be unique',
        );
        assert.deepStrictEqual(
            fixtureIds,
            registeredIds,
            'Registry completeness: every live manager needs one active fixture or explicit deferral, and every fixture must be registered',
        );
    });

    for (const fixture of packageManagerFixtures) {
        if (fixture.status === 'deferred') {
            test(`${fixture.id} is explicitly deferred: ${fixture.reason}`, () => {
                assert.ok(registeredManagers(api).has(fixture.id), `Deferred fixture: ${fixture.id} is not registered`);
            });
            continue;
        }

        for (const profile of fixture.profiles) {
            if (profile.status === 'deferred') {
                test(`${fixture.id} (${profile.name}) is explicitly deferred: ${profile.reason}`, () => {
                    assert.ok(profile.reason, `Deferred profile: ${profile.name} requires a reason`);
                });
                continue;
            }

            test(`${fixture.id} (${profile.name}) install/list/uninstall lifecycle`, async function () {
                try {
                    await runLifecycle(api, workspaceFolder, fixture, profile);
                } catch (error) {
                    if (error instanceof PrerequisiteUnavailable) {
                        this.skip();
                        return;
                    }
                    throw error;
                }
            });
        }
    }
});

function registeredManagers(api: IntegrationTestApi): Map<string, PackageManager> {
    return new Map(api.getRegisteredPackageManagersForTests().map(({ id, manager }) => [id, manager]));
}

async function runLifecycle(
    api: IntegrationTestApi,
    workspaceFolder: vscode.WorkspaceFolder,
    fixture: ActivePackageManagerFixture,
    profile: ActivePackageManagerProfile,
): Promise<void> {
    const manager = registeredManagers(api).get(fixture.id);
    assert.ok(manager, `Bootstrap (${profile.name}): live manager ${fixture.id} was not found`);

    const projectRoot = await fs.mkdtemp(path.join(workspaceFolder.uri.fsPath, '.pm-'));
    const projectUri = vscode.Uri.file(projectRoot);
    const project: PythonProject = { name: path.basename(projectRoot), uri: projectUri };
    const config = vscode.workspace.getConfiguration('python-envs', projectUri);
    const settings: SettingSnapshot<unknown>[] = [];
    let environment: PythonEnvironment | undefined;
    let projectAdded = false;

    let scenarioError: unknown;
    try {
        await setWorkspaceSetting(config, settings, 'defaultEnvManager', fixture.environmentManagerId);
        await setWorkspaceSetting(config, settings, 'defaultPackageManager', fixture.id);
        settings.push(snapshotWorkspaceSetting(config, 'pythonProjects'));

        await api.addPythonProject(project);
        projectAdded = true;

        const globalPythons = await api.getEnvironments('global');
        if (!globalPythons.some((candidate) => candidate.version.startsWith('3.'))) {
            throw new PrerequisiteUnavailable(`Bootstrap (${profile.name}): no global Python 3 installation is available`);
        }

        environment = await api.createEnvironment(projectUri, { quickCreate: true });
        if (!environment && fixture.environmentManagerId === 'ms-python.python:venv') {
            // Main can finish creating the Venv on disk before returning its item; recover it through public discovery.
            await api.refreshEnvironments(projectUri);
            environment = await findEnvironmentInside(projectRoot, await api.getEnvironments(projectUri));
        }
        if (!environment && fixture.environmentManagerId === 'ms-python.python:conda') {
            const condaVersion = await manager.getVersion?.(globalPythons[0]);
            if (!condaVersion) {
                throw new PrerequisiteUnavailable(`Bootstrap (${profile.name}): Conda is not available`);
            }
        }
        assert.ok(
            environment,
            `Bootstrap (${profile.name}): ${fixture.environmentManagerId} did not create a disposable environment`,
        );
        assert.strictEqual(
            environment.envId.managerId,
            fixture.environmentManagerId,
            `Bootstrap (${profile.name}): environment was created by the wrong manager`,
        );
        await assertOwnedEnvironment(projectRoot, environment, profile.name);
        if (/(?:alpha|beta|rc|dev)|\d[ab]\d/i.test(environment.version)) {
            throw new PrerequisiteUnavailable(
                `Bootstrap (${profile.name}): quick create selected pre-release Python ${environment.version}`,
            );
        }

        if (profile.alwaysUseUv !== undefined) {
            assert.strictEqual(
                config.get<boolean>('alwaysUseUv'),
                profile.alwaysUseUv,
                `Bootstrap (${profile.name}): test runner did not configure the expected Pip execution path`,
            );
        }

        await exerciseManager(manager, fixture, profile, environment);
    } catch (error) {
        scenarioError = error;
    } finally {
        const cleanupErrors: unknown[] = [];
        if (environment) {
            try {
                await cleanupEnvironment(api, fixture, profile, projectRoot, environment);
            } catch (error) {
                cleanupErrors.push(error);
            }
        }
        if (projectAdded) {
            try {
                await api.setEnvironment(projectUri, undefined);
            } catch (error) {
                cleanupErrors.push(error);
            }
            try {
                api.removePythonProject(project);
            } catch (error) {
                cleanupErrors.push(error);
            }
        }
        for (const setting of settings.reverse()) {
            try {
                await config.update(setting.key, setting.value, setting.target);
            } catch (error) {
                cleanupErrors.push(error);
            }
        }
        try {
            await removeDirectoryWithRetries(projectRoot);
        } catch (error) {
            cleanupErrors.push(error);
        }

        if (scenarioError) {
            if (scenarioError instanceof Error && cleanupErrors.length > 0) {
                scenarioError.message += `; cleanup also failed: ${cleanupErrors.map(String).join('; ')}`;
            }
            throw scenarioError;
        }
        if (cleanupErrors.length > 0) {
            throw new Error(
                `Cleanup (${profile.name}): one or more cleanup operations failed: ${cleanupErrors.map(String).join('; ')}`,
            );
        }
    }
}

async function exerciseManager(
    manager: PackageManager,
    fixture: ActivePackageManagerFixture,
    profile: ActivePackageManagerProfile,
    environment: PythonEnvironment,
): Promise<void> {
    await assertVersionCapability(manager, fixture.capabilities.version, environment, profile.name);
    let installSpec = fixture.packageName;
    let pinnedVersion: string | undefined;

    if (profile.availableVersions === 'required') {
        const getVersions = manager.getPackageAvailableVersions;
        assert.ok(getVersions, `Available versions (${profile.name}): capability is declared required but missing`);
        const versions = await getVersions.call(manager, environment, fixture.packageName);
        assert.ok(versions && versions.length > 0, `Available versions (${profile.name}): no versions were returned`);
        pinnedVersion = versions[0].public;
        installSpec = formatInstallSpec(manager, fixture, pinnedVersion, profile.name);
    } else {
        assertCapabilityDeclaration(profile.availableVersions, `Available versions (${profile.name})`);
    }

    assertFormatCapability(manager, fixture, profile.name);

    const baseline = await manager.getPackages(environment, { skipCache: true });
    assert.ok(Array.isArray(baseline), `Baseline list (${profile.name}): manager returned undefined`);
    const baselineNames = new Set(baseline.map((pkg) => normalizeName(pkg.name)));
    assert.ok(
        !baselineNames.has(normalizeName(fixture.packageName)),
        `Baseline list (${profile.name}): ${fixture.packageName} was already installed in the disposable environment`,
    );

    let installed = false;
    try {
        await manager.manage(environment, { install: [installSpec] });
        installed = true;

        const refreshed = await manager.refresh(environment);
        assert.ok(Array.isArray(refreshed), `Post-install refresh (${profile.name}): manager returned undefined`);
        const afterInstall = await manager.getPackages(environment, { skipCache: true });
        assert.ok(Array.isArray(afterInstall), `Post-install list (${profile.name}): manager returned undefined`);
        const installedPackage = findPackage(afterInstall, fixture.packageName);
        assert.ok(
            installedPackage,
            `Post-install list (${profile.name}): ${installSpec} was not installed; found ${afterInstall
                .map((pkg) => `${pkg.name}==${pkg.version ?? 'unknown'}`)
                .join(', ')}`,
        );
        assert.strictEqual(
            installedPackage.pkgId.managerId,
            fixture.id,
            `Post-install list (${profile.name}): package was attributed to the wrong manager`,
        );
        if (pinnedVersion) {
            assert.strictEqual(
                installedPackage.version,
                pinnedVersion,
                `Post-install list (${profile.name}): installed version does not match the selected version`,
            );
        }

        await assertDirectPackage(manager, fixture, profile.name, environment, true);

        await manager.manage(environment, { uninstall: [fixture.packageName] });
        installed = false;

        const afterUninstallRefresh = await manager.refresh(environment);
        assert.ok(
            Array.isArray(afterUninstallRefresh),
            `Post-uninstall refresh (${profile.name}): manager returned undefined`,
        );
        const afterUninstall = await manager.getPackages(environment, { skipCache: true });
        assert.ok(Array.isArray(afterUninstall), `Post-uninstall list (${profile.name}): manager returned undefined`);
        assert.ok(
            !findPackage(afterUninstall, fixture.packageName),
            `Post-uninstall list (${profile.name}): ${fixture.packageName} is still installed`,
        );
        await assertDirectPackage(manager, fixture, profile.name, environment, false);
    } catch (error) {
        let cleanupError: unknown;
        if (installed) {
            try {
                await manager.manage(environment, { uninstall: [fixture.packageName] });
                await manager.getPackages(environment, { skipCache: true });
            } catch (caught) {
                cleanupError = caught;
            }
        }
        if (error instanceof Error && cleanupError) {
            error.message += `; package cleanup also failed: ${String(cleanupError)}`;
        }
        throw error;
    }
}

async function assertVersionCapability(
    manager: PackageManager,
    expectation: CapabilityExpectation,
    environment: PythonEnvironment,
    profileName: string,
): Promise<void> {
    if (expectation === 'required') {
        const getVersion = manager.getVersion;
        assert.ok(getVersion, `Manager version (${profileName}): capability is declared required but missing`);
        const version = await getVersion.call(manager, environment);
        assert.ok(version, `Manager version (${profileName}): required capability returned undefined`);
        return;
    }
    if (expectation === 'unsupported') {
        assert.strictEqual(
            manager.getVersion,
            undefined,
            `Manager version (${profileName}): capability is declared unsupported but implemented`,
        );
        return;
    }
    assertCapabilityDeclaration(expectation, `Manager version (${profileName})`);
}

function assertFormatCapability(
    manager: PackageManager,
    fixture: ActivePackageManagerFixture,
    profileName: string,
): void {
    const expectation = fixture.capabilities.formatInstallSpec;
    if (expectation === 'required') {
        assert.ok(
            manager.formatInstallSpec,
            `Install spec (${profileName}): capability is declared required but missing`,
        );
        assert.strictEqual(
            manager.formatInstallSpec(fixture.packageName, '1.2.3'),
            `${fixture.packageName}=1.2.3`,
            `Install spec (${profileName}): manager returned the wrong syntax`,
        );
        return;
    }
    if (expectation === 'unsupported') {
        assert.strictEqual(
            manager.formatInstallSpec,
            undefined,
            `Install spec (${profileName}): fixture says unsupported but the manager now implements it`,
        );
        return;
    }
    assertCapabilityDeclaration(expectation, `Install spec (${profileName})`);
}

function formatInstallSpec(
    manager: PackageManager,
    fixture: ActivePackageManagerFixture,
    version: string,
    profileName: string,
): string {
    if (fixture.capabilities.formatInstallSpec === 'required') {
        assert.ok(manager.formatInstallSpec, `Install spec (${profileName}): required formatter is missing`);
        return manager.formatInstallSpec(fixture.packageName, version);
    }
    return `${fixture.packageName}==${version}`;
}

async function assertDirectPackage(
    manager: PackageManager,
    fixture: ActivePackageManagerFixture,
    profileName: string,
    environment: PythonEnvironment,
    expectedPresent: boolean,
): Promise<void> {
    const expectation = fixture.capabilities.directPackageNames;
    if (expectation === 'required') {
        const getDirectNames = manager.getDirectPackageNames;
        assert.ok(getDirectNames, `Direct packages (${profileName}): capability is declared required but missing`);
        const names = await getDirectNames.call(manager, environment);
        assert.ok(names, `Direct packages (${profileName}): required capability returned undefined`);
        assert.strictEqual(
            [...names].map(normalizeName).includes(normalizeName(fixture.packageName)),
            expectedPresent,
            `Direct packages (${profileName}): ${fixture.packageName} presence was incorrect after ${
                expectedPresent ? 'install' : 'uninstall'
            }`,
        );
        return;
    }
    if (expectation === 'unsupported') {
        assert.strictEqual(
            manager.getDirectPackageNames,
            undefined,
            `Direct packages (${profileName}): fixture says unsupported but the manager now implements it`,
        );
        return;
    }
    assertCapabilityDeclaration(expectation, `Direct packages (${profileName})`);
}

function assertCapabilityDeclaration(expectation: CapabilityExpectation, phase: string): void {
    assert.notStrictEqual(expectation, 'required', `${phase}: required capability was not exercised`);
    if (typeof expectation === 'object') {
        assert.ok(expectation.deferred.length > 0, `${phase}: deferred capability requires a reason`);
    }
}

function findPackage(packages: readonly Package[], name: string): Package | undefined {
    const normalized = normalizeName(name);
    return packages.find((pkg) => normalizeName(pkg.name) === normalized);
}

async function findEnvironmentInside(
    projectRoot: string,
    environments: PythonEnvironment[],
): Promise<PythonEnvironment | undefined> {
    const resolvedProjectRoot = await fs.realpath(projectRoot);
    for (const environment of environments) {
        const resolvedPrefix = await fs.realpath(environment.sysPrefix);
        const relative = path.relative(resolvedProjectRoot, resolvedPrefix);
        if (relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
            return environment;
        }
    }
    return undefined;
}

function normalizeName(name: string): string {
    return name.toLowerCase().replace(/[-_.]+/g, '-');
}

function snapshotWorkspaceSetting<T>(
    config: vscode.WorkspaceConfiguration,
    key: string,
): SettingSnapshot<T> {
    const inspection = config.inspect<T>(key);
    assert.ok(inspection, `Settings setup: ${key} is not registered`);
    return { key, value: inspection.workspaceValue, target: vscode.ConfigurationTarget.Workspace };
}

async function setWorkspaceSetting<T>(
    config: vscode.WorkspaceConfiguration,
    settings: SettingSnapshot<unknown>[],
    key: string,
    value: T,
): Promise<void> {
    const snapshot = snapshotWorkspaceSetting<T>(config, key);
    settings.push(snapshot);
    await config.update(key, value, snapshot.target);
    assert.deepStrictEqual(config.inspect<T>(key)?.workspaceValue, value, `Settings setup: ${key} was not applied`);
}

async function assertOwnedEnvironment(
    projectRoot: string,
    environment: PythonEnvironment,
    profileName: string,
): Promise<void> {
    const resolvedProjectRoot = await fs.realpath(projectRoot);
    const resolvedEnvironmentRoot = await fs.realpath(environment.sysPrefix);
    const relative = path.relative(resolvedProjectRoot, resolvedEnvironmentRoot);
    assert.ok(
        relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
        `Bootstrap (${profileName}): environment root is not inside the disposable project`,
    );
}

async function removeDirectoryWithRetries(directory: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
            await fs.rm(directory, { recursive: true, force: true });
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }
    throw lastError;
}

async function cleanupEnvironment(
    api: IntegrationTestApi,
    fixture: ActivePackageManagerFixture,
    profile: ActivePackageManagerProfile,
    projectRoot: string,
    environment: PythonEnvironment,
): Promise<void> {
    await assertOwnedEnvironment(projectRoot, environment, profile.name);
    if (fixture.environmentManagerId === 'ms-python.python:conda') {
        await api.removeEnvironment(environment);
        return;
    }

    const environmentRoot = environment.sysPrefix;
    assert.ok(
        path.basename(environmentRoot).startsWith('.venv'),
        `Cleanup (${profile.name}): refusing to delete unexpected Venv root ${environmentRoot}`,
    );
    await removeDirectoryWithRetries(environmentRoot);
    await api.refreshEnvironments(projectRoot ? vscode.Uri.file(projectRoot) : undefined);
}
