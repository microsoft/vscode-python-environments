// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Smoke Test: Extension Activation
 *
 * PURPOSE:
 * Verify that the extension activates successfully in a real VS Code environment.
 * This is the most basic smoke test - if this fails, nothing else will work.
 *
 * WHAT THIS TESTS:
 * 1. Extension can be found and loaded by VS Code
 * 2. Extension activates without throwing errors
 * 3. Extension API is exported and accessible
 *
 * HOW TO RUN:
 * Option 1: VS Code - Use "Smoke Tests" launch configuration
 * Option 2: Terminal - npm run smoke-test
 *
 * HOW TO DEBUG:
 * 1. Set breakpoints in this file or extension code
 * 2. Select "Smoke Tests" from the Debug dropdown
 * 3. Press F5 to start debugging
 *
 * FLAKINESS PREVENTION:
 * - Uses waitForCondition() instead of arbitrary sleep()
 * - Has a generous timeout (60 seconds) for slow CI machines
 * - Retries once on failure (configured in the runner)
 * - Tests are independent - no shared state between tests
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { ENVS_EXTENSION_ID, MAX_EXTENSION_ACTIVATION_TIME } from '../constants';
import { waitForCondition } from '../testUtils';

suite('Smoke: Extension Activation', function () {
    // Smoke tests need longer timeouts - VS Code startup can be slow
    this.timeout(MAX_EXTENSION_ACTIVATION_TIME);

    /**
     * Test: Extension is installed and VS Code can find it
     *
     * WHY THIS MATTERS:
     * If VS Code can't find the extension, there's a packaging or
     * installation problem. This catches broken builds early.
     *
     * ASSERTION STRATEGY:
     * We use assert.ok() with a descriptive message. If the extension
     * isn't found, the test fails immediately with clear feedback.
     */
    test('Extension is installed', function () {
        const extension = vscode.extensions.getExtension(ENVS_EXTENSION_ID);

        // Specific assertion: Extension must exist
        // If undefined, there's a packaging problem
        assert.ok(
            extension !== undefined,
            `Extension ${ENVS_EXTENSION_ID} is not installed. ` +
                'Check that the extension ID matches package.json and the build ran successfully.',
        );
    });

    /**
     * Test: Extension activates successfully
     *
     * WHY THIS MATTERS:
     * Extension activation runs significant initialization code.
     * If activation fails, the extension is broken and all features
     * will be unavailable.
     *
     * ASSERTION STRATEGY:
     * 1. First verify extension exists (prerequisite)
     * 2. Trigger activation if not already active
     * 3. Wait for activation to complete (with timeout)
     * 4. Verify no errors occurred
     *
     * FLAKINESS PREVENTION:
     * - Use waitForCondition() instead of sleep
     * - Check isActive property, not just await activate()
     * - Give generous timeout for CI environments
     */
    test('Extension activates without errors', async function () {
        const extension = vscode.extensions.getExtension(ENVS_EXTENSION_ID);

        // Prerequisite check
        assert.ok(extension !== undefined, `Extension ${ENVS_EXTENSION_ID} not found`);

        // If already active, we're done
        if (extension.isActive) {
            return;
        }

        // Activate the extension
        // This can take time on first activation as it:
        // - Discovers Python environments
        // - Initializes managers
        // - Sets up views
        try {
            await extension.activate();
        } catch (error) {
            // Activation threw an error - test fails
            assert.fail(
                `Extension activation threw an error: ${error instanceof Error ? error.message : String(error)}`,
            );
        }

        // Wait for activation to complete
        // The activate() promise resolves when activation starts, but
        // isActive becomes true when activation finishes
        await waitForCondition(
            () => extension.isActive,
            30_000, // 30 second timeout
            'Extension did not become active after activation',
        );

        // Final verification
        assert.strictEqual(extension.isActive, true, 'Extension should be active after activation completes');
    });

    /**
     * Test: Extension exports its API
     *
     * WHY THIS MATTERS:
     * Other extensions depend on our API. If the API isn't exported,
     * integrations will fail silently.
     *
     * ASSERTION STRATEGY:
     * - Verify exports is not undefined
     * - Verify exports is not null
     * - Optionally verify expected API shape (commented out - enable when API stabilizes)
     */
    test('Extension exports API', async function () {
        const extension = vscode.extensions.getExtension(ENVS_EXTENSION_ID);
        assert.ok(extension !== undefined, `Extension ${ENVS_EXTENSION_ID} not found`);

        // Ensure extension is active first
        if (!extension.isActive) {
            await extension.activate();
            await waitForCondition(() => extension.isActive, 30_000, 'Extension did not activate');
        }

        // Verify API is exported
        const api = extension.exports;

        assert.ok(
            api !== undefined,
            'Extension exports should not be undefined. ' +
                'Check that extension.ts returns an API object from activate().',
        );

        assert.ok(
            api !== null,
            'Extension exports should not be null. ' + 'Check that extension.ts returns a valid API object.',
        );

        // Optional: Verify API shape
        // Uncomment and customize when your API is stable
        // assert.ok(typeof api.getEnvironments === 'function', 'API should have getEnvironments()');
    });

    /**
     * Test: Extension commands are registered
     *
     * WHY THIS MATTERS:
     * Commands are the primary way users interact with the extension.
     * If commands aren't registered, the extension appears broken.
     *
     * ASSERTION STRATEGY:
     * - Get all registered commands from VS Code
     * - Check that our expected commands exist
     * - Use includes() for each command to get specific feedback
     */
    test('Extension commands are registered', async function () {
        const extension = vscode.extensions.getExtension(ENVS_EXTENSION_ID);
        assert.ok(extension !== undefined, `Extension ${ENVS_EXTENSION_ID} not found`);

        // Ensure extension is active
        if (!extension.isActive) {
            await extension.activate();
            await waitForCondition(() => extension.isActive, 30_000, 'Extension did not activate');
        }

        // Get all registered commands
        const allCommands = await vscode.commands.getCommands(true);

        // List of commands that MUST be registered
        // Add your critical commands here
        const requiredCommands = [
            'python-envs.set', // Set environment
            'python-envs.create', // Create environment
            'python-envs.refreshAllManagers', // Refresh managers
        ];

        for (const cmd of requiredCommands) {
            assert.ok(
                allCommands.includes(cmd),
                `Required command '${cmd}' is not registered. ` +
                    'Check that the command is defined in package.json and registered in extension.ts.',
            );
        }
    });
});
