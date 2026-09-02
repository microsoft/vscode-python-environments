// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { commands, Disposable, l10n, QuickPickItem, Uri, window } from 'vscode';
import { PythonEnvironment } from '../../api';
import { INLINE_SCRIPT_MANAGER_ID } from '../../common/constants';
import { InlineScriptRoutingRegistry } from '../../common/inlineScript/routingRegistry';
import { readInlineScriptMetadataFromFile } from '../../common/inlineScript/metadata';
import { traceError, traceInfo } from '../../common/logging';
import { showErrorMessage, showInformationMessage, showQuickPickWithButtons } from '../../common/window.apis';
import { asRelativePath, findFiles } from '../../common/workspace.apis';
import { EnvironmentManagers } from '../../internal.api';
import { registerInlineScriptCodeLens } from './codeLens';

/**
 * Hidden command invoked by the inline-script CodeLens to set up the environment for one script.
 * Intentionally not contributed in `package.json` while the feature is behind the internal flag.
 */
export const SETUP_INLINE_SCRIPT_ENV_COMMAND = 'python-envs.setupInlineScriptEnv';

/**
 * Hidden command that scans the workspace and sets up environments for the selected inline-script
 * files. Intentionally not contributed in `package.json` while the feature is behind the internal flag.
 */
export const SETUP_INLINE_SCRIPT_ENVS_COMMAND = 'python-envs.setupInlineScriptEnvs';

/** Upper bound on the number of `.py` files the bulk command scans. */
const MAX_INLINE_SCRIPT_FILES = 1000;

/** How many candidate files' PEP 723 headers are read concurrently during the bulk scan. */
const METADATA_READ_CONCURRENCY = 20;

/**
 * Create or reuse the inline-script environment for `scriptUri` and make it the file's environment.
 *
 * Reuses the pipeline built by earlier PEP 723 PRs:
 *  - `manager.create` builds or reuses the cached environment from the script's PEP 723 metadata
 *    (selecting or, with consent, installing a compatible base interpreter);
 *  - `setEnvironment` persists the association, registers the exact script project, and publishes the
 *    per-file environment change so routing picks up the inline environment.
 *
 * Returns the environment on success, or `undefined` when creation produced none (the manager has
 * already surfaced the reason — a declined install, no compatible Python, or a cancelled/failed
 * build — and emitted telemetry).
 */
export async function setUpInlineScriptEnvironment(
    scriptUri: Uri,
    em: EnvironmentManagers,
    routing: InlineScriptRoutingRegistry,
): Promise<PythonEnvironment | undefined> {
    const manager = em.getEnvironmentManager(INLINE_SCRIPT_MANAGER_ID);
    if (!manager) {
        traceError('Inline-script setup requested but the inline-script environment manager is not registered.');
        return undefined;
    }
    const metadataIdentityBeforeCreate = routing.getMetadataIdentity(scriptUri);
    const environment = await manager.create(scriptUri, undefined);
    if (!environment) {
        return undefined;
    }
    if (routing.getMetadataIdentity(scriptUri) !== metadataIdentityBeforeCreate) {
        // The script's saved metadata changed while the environment was being built, so this
        // environment was built for stale metadata. Skip associating it rather than overwrite a newer
        // setup; the current metadata's CodeLens stays so the user can run setup again.
        traceInfo(`Inline-script metadata for ${scriptUri.fsPath} changed during setup; skipping association.`);
        return undefined;
    }
    await em.setEnvironment(scriptUri, environment);
    return environment;
}

function setupInlineScriptEnvironmentHandler(
    em: EnvironmentManagers,
    routing: InlineScriptRoutingRegistry,
): (scriptUri?: Uri) => Promise<void> {
    return async (scriptUri?: Uri): Promise<void> => {
        const uri = scriptUri ?? window.activeTextEditor?.document.uri;
        if (!uri || uri.scheme !== 'file') {
            return;
        }
        if (!em.getEnvironmentManager(INLINE_SCRIPT_MANAGER_ID)) {
            showErrorMessage(l10n.t('The inline script environment manager is not available yet. Try again shortly.'));
            return;
        }
        try {
            await setUpInlineScriptEnvironment(uri, em, routing);
        } catch (error) {
            traceError(`Failed to set up the inline-script environment for ${uri.fsPath}:`, error);
            showErrorMessage(
                l10n.t(
                    'Failed to set up the environment for this script. See the Python Environments output for details.',
                ),
            );
        }
    };
}

interface InlineScriptQuickPickItem extends QuickPickItem {
    readonly uri: Uri;
    readonly configured: boolean;
}

export async function setUpInlineScriptEnvironmentsInWorkspace(
    em: EnvironmentManagers,
    routing: InlineScriptRoutingRegistry,
): Promise<void> {
    if (!em.getEnvironmentManager(INLINE_SCRIPT_MANAGER_ID)) {
        showErrorMessage(l10n.t('The inline script environment manager is not available yet. Try again shortly.'));
        return;
    }
    const files = await findFiles('**/*.py', '{**/.venv/**,**/node_modules/**}', MAX_INLINE_SCRIPT_FILES);
    if (!files || files.length === 0) {
        showInformationMessage(l10n.t('No Python files were found in the workspace.'));
        return;
    }
    const candidates = await filterInlineScriptFiles(files);
    if (candidates.length === 0) {
        showInformationMessage(
            l10n.t('No Python files with PEP 723 inline script metadata were found in the workspace.'),
        );
        return;
    }
    const items: InlineScriptQuickPickItem[] = candidates
        .map((uri) => {
            const configured = routing.shouldRoute(uri);
            return {
                label: asRelativePath(uri),
                description: configured ? l10n.t('environment already set up') : undefined,
                uri,
                configured,
            };
        })
        .sort((a, b) => a.label.localeCompare(b.label));
    // Pre-select only scripts that do not already have a validated inline environment, so that
    // accepting the picker never silently rebuilds or replaces an already-configured script's
    // environment (which could otherwise move it onto a newer base interpreter).
    const preselected = items.filter((item) => !item.configured);
    const selection = await showQuickPickWithButtons(items, {
        canPickMany: true,
        ignoreFocusOut: true,
        title: l10n.t('Set Up Environments for Inline Script Files'),
        placeHolder: l10n.t('Select the scripts to set up environments for'),
        selected: preselected,
    });
    const picks = Array.isArray(selection) ? selection : selection ? [selection] : [];
    if (picks.length === 0) {
        return;
    }
    let succeeded = 0;
    for (const pick of picks) {
        try {
            if (await setUpInlineScriptEnvironment(pick.uri, em, routing)) {
                succeeded += 1;
            }
        } catch (error) {
            traceError(`Failed to set up the inline-script environment for ${pick.uri.fsPath}:`, error);
        }
    }
    traceInfo(`Inline-script bulk setup: created or reused ${succeeded} of ${picks.length} environment(s).`);
    showInformationMessage(l10n.t('Set up {0} of {1} selected inline script environment(s).', succeeded, picks.length));
}

/**
 * Read the head of each candidate file (bounded concurrency) and keep only those that declare a
 * PEP 723 `# /// script` block.
 */
async function filterInlineScriptFiles(files: readonly Uri[]): Promise<Uri[]> {
    const candidates: Uri[] = [];
    for (let index = 0; index < files.length; index += METADATA_READ_CONCURRENCY) {
        const chunk = files.slice(index, index + METADATA_READ_CONCURRENCY);
        const results = await Promise.all(
            chunk.map(async (uri) => ((await readInlineScriptMetadataFromFile(uri)) ? uri : undefined)),
        );
        for (const uri of results) {
            if (uri) {
                candidates.push(uri);
            }
        }
    }
    return candidates;
}

/**
 * Register the inline-script user-facing surfaces (the CodeLens and its setup commands). Only called
 * when the PEP 723 inline-script feature flag is enabled; the commands are intentionally hidden from
 * `package.json` for now.
 */
export function registerInlineScriptUx(em: EnvironmentManagers, routing: InlineScriptRoutingRegistry): Disposable[] {
    return [
        registerInlineScriptCodeLens(routing, SETUP_INLINE_SCRIPT_ENV_COMMAND),
        commands.registerCommand(SETUP_INLINE_SCRIPT_ENV_COMMAND, setupInlineScriptEnvironmentHandler(em, routing)),
        commands.registerCommand(SETUP_INLINE_SCRIPT_ENVS_COMMAND, () =>
            setUpInlineScriptEnvironmentsInWorkspace(em, routing),
        ),
    ];
}
