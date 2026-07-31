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
 *   3. list again              -> getPackages (test package now present)
 *   4. list direct packages    -> getPackages filtered by !isTransitive
 *   5. uninstall test package  -> managePackages({ uninstall })
 *   6. list again              -> getPackages (test package absent again)
 *
 * NOTES:
 *   - "Available versions" is intentionally NOT exercised here: the exported
 *     PythonEnvironmentApi does not surface getPackageAvailableVersions (it lives
 *     only on the internal PackageManager interface), so it is unreachable from a
 *     public-API-only test.
 *   - Direct (non-transitive) packages are derived from Package.isTransitive,
 *     which IS part of the public API.
 *   - The test package (cowsay) is small and dependency-free so a successful
 *     install shows up as a direct package with no transitive fan-out.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { Package, PythonEnvironment, PythonEnvironmentApi } from '../../api';
import { normalizePackageName } from '../../managers/builtin/utils';
import { ENVS_EXTENSION_ID } from '../constants';
import { waitForCondition } from '../testUtils';

/** Small, dependency-free package used for the install/uninstall roundtrip. */
const TEST_PACKAGE = 'cowsay';

/** True when a package with the given (normalized) name is in the list. */
function hasPackage(packages: Package[] | undefined, name: string): boolean {
    const target = normalizePackageName(name);
    return (packages ?? []).some((p) => normalizePackageName(p.name) === target);
}

/**
 * Runs the full lifecycle roundtrip for a single environment/manager.
 * Returns undefined on success, or a human-readable skip reason.
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

        // 3. List again -> present.
        await api.refreshPackages(env);
        const afterInstall = await api.getPackages(env, { skipCache: true });
        assert.ok(hasPackage(afterInstall, TEST_PACKAGE), `[${managerId}] ${TEST_PACKAGE} should be installed`);

        // 4. Direct (non-transitive) packages should include the directly-installed package.
        const direct = (afterInstall ?? []).filter((p) => p.isTransitive !== true);
        assert.ok(
            hasPackage(direct, TEST_PACKAGE),
            `[${managerId}] ${TEST_PACKAGE} should be reported as a direct (non-transitive) package`,
        );

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
    this.timeout(180_000); // Install/uninstall across multiple managers can be slow.

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
     * Prefers virtual-environment-like envs, which are safe to install into.
     */
    async function getEnvironmentsByManager(): Promise<Map<string, PythonEnvironment>> {
        const environments = await api.getEnvironments('all');
        const byManager = new Map<string, PythonEnvironment>();

        const looksModifiable = (env: PythonEnvironment): boolean =>
            env.displayName.includes('venv') ||
            env.displayName.includes('.venv') ||
            env.envId.managerId.includes('venv');

        for (const env of environments) {
            const managerId = env.envId.managerId;
            const current = byManager.get(managerId);
            if (!current || (looksModifiable(env) && !looksModifiable(current))) {
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
