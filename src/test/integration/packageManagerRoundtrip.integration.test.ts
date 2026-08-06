// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Integration Test: Package Manager Roundtrip
 *
 * PURPOSE:
 * Verify that every discovered package manager performs a full package lifecycle
 * correctly, using only the public extension API. The test is parametrized over
 * the package managers backing the discovered environments, so new managers are
 * covered automatically without adding manager-specific code.
 *
 * ROUNDTRIP (per manager, all via the public API):
 *   1. list packages           -> getPackages (baseline; test package absent)
 *   2. install test package    -> managePackages({ install })
 *   3. refresh + list           -> refreshPackages (enriched, test package now present)
 *   4. direct vs transitive     -> installed package is direct; its deps are transitive
 *   4b. available versions      -> getPackageAvailableVersions (when supported)
 *   5. uninstall test package  -> managePackages({ uninstall })
 *   6. list again              -> getPackages (test package absent again)
 *
 * NOTES:
 *   - The test package (flask) is chosen because it is available from every common
 *     manager's default sources (PyPI for pip/uv/poetry/pipenv, and conda's default
 *     `main` channel for conda) and pulls in real transitive dependencies (jinja2,
 *     werkzeug, click, ...). That lets the roundtrip exercise a genuine install on
 *     every manager AND verify the direct-vs-transitive classification.
 *   - "Available versions" is exercised via getPackageAvailableVersions when the
 *     running PythonEnvironmentApi surfaces it. That getter was added to the public
 *     API; the call is capability-guarded so this test compiles and runs regardless
 *     of whether the active API build includes it, and gracefully skips the check
 *     for managers that resolve to `undefined` (no version listing support).
 *   - Transitive classification comes from Package.isTransitive, which is populated by
 *     the enriched refreshPackages result (getPackages({skipCache}) re-lists WITHOUT
 *     enrichment). Managers that implement direct-name detection (pip/uv/poetry) mark
 *     dependencies isTransitive=true; managers that don't (conda) leave it undefined,
 *     so the transitive-dependency assertion is conditional on the manager classifying it.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { Package, PythonEnvironment, PythonEnvironmentApi } from '../../api';
import { CONDA_MANAGER_ID, PYTHON_EXTENSION_ID, VENV_MANAGER_ID } from '../../common/constants';
import { normalizePackageName } from '../../managers/builtin/utils';
import { ENVS_EXTENSION_ID } from '../constants';
import { waitForCondition } from '../testUtils';

/**
 * Package used for the install/uninstall roundtrip. flask is available from every
 * common manager's default source (PyPI and conda's default `main` channel) and pulls
 * in transitive dependencies, so the roundtrip can verify both installation and the
 * direct-vs-transitive classification on every manager.
 */
const TEST_PACKAGE = 'flask';

/** True when a package with the given (normalized) name is in the list. */
function hasPackage(packages: Package[] | undefined, name: string): boolean {
    const target = normalizePackageName(name);
    return (packages ?? []).some((p) => normalizePackageName(p.name) === target);
}

/**
 * Optional API capability: some API builds surface available-version listing.
 * Cast through this shape so the test compiles whether or not the running API
 * exposes getPackageAvailableVersions.
 */
type AvailableVersionsCapable = {
    getPackageAvailableVersions?: (
        environment: PythonEnvironment,
        packageName: string,
    ) => Promise<unknown[] | undefined>;
};

/**
 * Runs the full lifecycle roundtrip for a single environment/manager. Throws (via
 * assertion) on any failure; returns normally when the full lifecycle succeeded.
 */
async function runRoundtrip(api: PythonEnvironmentApi, env: PythonEnvironment, managerId: string): Promise<void> {
    const baseline = await api.getPackages(env, { skipCache: true });
    if (baseline === undefined) {
        // No usable package manager for this environment.
        return;
    }

    // Avoid clobbering a pre-existing install of the test package.
    assert.ok(
        !hasPackage(baseline, TEST_PACKAGE),
        `[${managerId}] ${TEST_PACKAGE} unexpectedly already installed; cannot run a clean roundtrip`,
    );

    let installed = false;
    try {
        // 2. Install.
        await api.managePackages(env, { install: [TEST_PACKAGE] });
        installed = true;

        // 3. Refresh and read the ENRICHED package list from the refresh result:
        // getPackages({skipCache}) re-lists without transitive enrichment, so the
        // refreshPackages return value is what carries Package.isTransitive.
        const afterInstall = (await api.refreshPackages(env)) ?? (await api.getPackages(env, { skipCache: true }));
        assert.ok(hasPackage(afterInstall, TEST_PACKAGE), `[${managerId}] ${TEST_PACKAGE} should be installed`);

        // 4. The installed package is a direct (non-transitive) dependency.
        const installedPkg = (afterInstall ?? []).find(
            (p) => normalizePackageName(p.name) === normalizePackageName(TEST_PACKAGE),
        );
        assert.notStrictEqual(
            installedPkg?.isTransitive,
            true,
            `[${managerId}] ${TEST_PACKAGE} should be reported as a direct (non-transitive) package`,
        );

        // 4a. Transitive-dependency detection. flask pulls in dependencies (jinja2,
        // werkzeug, ...). Managers that classify direct vs transitive (pip/uv/poetry)
        // mark those deps isTransitive=true; managers that don't (conda) leave it
        // undefined, so this assertion is conditional on the manager classifying at all.
        const classifiesTransitivity = (afterInstall ?? []).some((p) => p.isTransitive !== undefined);
        if (classifiesTransitivity) {
            assert.ok(
                (afterInstall ?? []).some((p) => p.isTransitive === true),
                `[${managerId}] expected at least one transitive dependency of ${TEST_PACKAGE} to be detected`,
            );
        }

        // 4b. Available versions (optional API capability). Only asserted when the
        // running API surfaces the getter and the manager supports version listing.
        const versionsApi = api as unknown as AvailableVersionsCapable;
        if (typeof versionsApi.getPackageAvailableVersions === 'function') {
            const versions = await versionsApi.getPackageAvailableVersions(env, TEST_PACKAGE);
            if (versions !== undefined) {
                assert.ok(
                    Array.isArray(versions) && versions.length > 0,
                    `[${managerId}] ${TEST_PACKAGE} should report at least one available version`,
                );
            }
        }

        // 5. Uninstall.
        await api.managePackages(env, { uninstall: [TEST_PACKAGE] });
        installed = false;

        // 6. List again -> absent.
        await api.refreshPackages(env);
        const afterUninstall = await api.getPackages(env, { skipCache: true });
        assert.ok(!hasPackage(afterUninstall, TEST_PACKAGE), `[${managerId}] ${TEST_PACKAGE} should be uninstalled`);
    } finally {
        // Best-effort cleanup so a mid-roundtrip failure never leaves the env dirty.
        if (installed) {
            try {
                await api.managePackages(env, { uninstall: [TEST_PACKAGE] });
            } catch {
                console.log(`[${managerId}] cleanup: failed to uninstall ${TEST_PACKAGE}`);
            }
        }
    }
}

suite('Integration: Package Manager Roundtrip', function () {
    this.timeout(300_000); // Install/uninstall across multiple managers can be slow (conda solving flask + deps).

    let api: PythonEnvironmentApi;

    suiteSetup(async function () {
        this.timeout(30_000);

        const extension = vscode.extensions.getExtension(ENVS_EXTENSION_ID);
        assert.ok(extension, `Extension ${ENVS_EXTENSION_ID} not found`);

        if (!extension.isActive) {
            await extension.activate();
            await waitForCondition(() => extension.isActive, 20_000, 'Extension did not activate');
        }

        api = extension.exports as PythonEnvironmentApi;
        assert.ok(api, 'API not available');
    });

    /**
     * Picks one representative environment per package manager, grouped by managerId.
     * Only returns isolated environments that are safe for an install/uninstall test.
     */
    async function getEnvironmentsByManager(): Promise<Map<string, PythonEnvironment>> {
        const environments = await api.getEnvironments('all');
        const byManager = new Map<string, PythonEnvironment>();
        const isolatedManagerIds = new Set([
            VENV_MANAGER_ID,
            `${PYTHON_EXTENSION_ID}:pipenv`,
            `${PYTHON_EXTENSION_ID}:poetry`,
        ]);

        for (const env of environments) {
            const managerId = env.envId.managerId;
            const isSafeToModify =
                isolatedManagerIds.has(managerId) ||
                (managerId === CONDA_MANAGER_ID && env.name.toLowerCase() !== 'base');
            if (isSafeToModify && !byManager.has(managerId)) {
                byManager.set(managerId, env);
            }
        }
        return byManager;
    }

    /**
     * Parametrized roundtrip: one assertion pass per discovered package manager.
     *
     * This is a single test that iterates managers (rather than a static list) so
     * that any future manager is exercised automatically once its environments are
     * discovered. Failures are aggregated and reported per manager.
     */
    test('install/list/direct/uninstall roundtrip for each package manager', async function () {
        const byManager = await getEnvironmentsByManager();

        if (byManager.size === 0) {
            console.log('No environments discovered; skipping package manager roundtrip');
            this.skip();
            return;
        }

        const failures: string[] = [];
        let exercised = 0;

        for (const [managerId, env] of byManager) {
            try {
                const before = await api.getPackages(env, { skipCache: true });
                if (before === undefined) {
                    console.log(`[${managerId}] no package manager available; skipping`);
                    continue;
                }
                if (hasPackage(before, TEST_PACKAGE)) {
                    console.log(`[${managerId}] ${TEST_PACKAGE} already present; skipping to avoid clobbering`);
                    continue;
                }

                await runRoundtrip(api, env, managerId);
                exercised++;
                console.log(`[${managerId}] roundtrip passed (${env.displayName})`);
            } catch (e) {
                failures.push(`[${managerId}] ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        assert.strictEqual(failures.length, 0, `Package manager roundtrip failures:\n${failures.join('\n')}`);

        if (exercised === 0) {
            console.log('No modifiable package managers were exercised; skipping');
            this.skip();
        }
    });
});
