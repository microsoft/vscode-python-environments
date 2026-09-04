// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { commands, Disposable, l10n, QuickPickItem, Uri, window } from 'vscode';
import { PythonEnvironment } from '../../api';
import { INLINE_SCRIPT_MANAGER_ID } from '../../common/constants';
import { readInlineScriptMetadataFromFile } from '../../common/inlineScript/metadata';
import { InlineScriptRoutingRegistry } from '../../common/inlineScript/routingRegistry';
import { traceError, traceInfo } from '../../common/logging';
import { normalizePath } from '../../common/utils/pathUtils';
import {
    showErrorMessage,
    showInformationMessage,
    showQuickPickWithButtons,
    showWarningMessage,
} from '../../common/window.apis';
import { asRelativePath, findFiles, getOpenTextDocuments } from '../../common/workspace.apis';
import { EnvironmentManagers } from '../../internal.api';
import { registerInlineScriptCodeLens } from './codeLens';

/**
 * Hidden command invoked by the inline-script CodeLens to set up the environment for one script.
 * Intentionally not contributed in `package.json` while the feature is behind the internal flag.
 */
export const SETUP_INLINE_SCRIPT_ENV_COMMAND = 'python-envs.setupInlineScriptEnv';

/**
 * Command that scans the workspace and sets up environments for the selected inline-script files.
 * Contributed in `package.json` but only shown in the Command Palette while the inline-scripts
 * feature flag is enabled (gated by the `pythonEnvsInlineScriptsEnabled` context key).
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
 * Returns the environment on success, or `undefined` when creation produced none. Failures and
 * benign skips are recorded on the routing registry for the interactive setup command to surface or
 * suppress; see {@link InlineScriptRoutingRegistry.takeSetupOutcome}.
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
    await seedRoutingMetadataForClosedScript(scriptUri, routing);
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
        routing.noteSetupOutcome(scriptUri, { kind: 'skipped' });
        return undefined;
    }
    await em.setEnvironment(scriptUri, environment);
    return environment;
}

async function seedRoutingMetadataForClosedScript(scriptUri: Uri, routing: InlineScriptRoutingRegistry): Promise<void> {
    if (routing.getMetadata(scriptUri)) {
        return;
    }
    const scriptPath = normalizePath(scriptUri.fsPath);
    const isOpen = getOpenTextDocuments().some(
        (document) => document.uri.scheme === 'file' && normalizePath(document.uri.fsPath) === scriptPath,
    );
    if (isOpen) {
        return;
    }
    const metadata = await readInlineScriptMetadataFromFile(scriptUri);
    if (metadata && !routing.getMetadata(scriptUri)) {
        routing.setMetadata(scriptUri, metadata);
    }
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
            const environment = await setUpInlineScriptEnvironment(uri, em, routing);
            if (!environment) {
                notifyInlineScriptSetupOutcome(uri, routing);
            }
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

function notifyInlineScriptSetupOutcome(uri: Uri, routing: InlineScriptRoutingRegistry): void {
    const outcome = routing.takeSetupOutcome(uri);
    if (outcome?.kind === 'skipped') {
        // Env built but intentionally not associated (metadata changed mid-setup); stay silent.
        return;
    }
    if (outcome?.kind === 'failed') {
        if (outcome.category === 'compatible-python-declined') {
            // User declined the install prompt; don't nag.
            return;
        }
        if (outcome.category === 'no-compatible-python') {
            showWarningMessage(buildNoCompatiblePythonMessage(outcome.requiresPython));
            return;
        }
    }
    showErrorMessage(
        l10n.t('Failed to set up the environment for this script. See the Python Environments output for details.'),
    );
}

/**
 * "No compatible Python" message. Calls out an exact two-segment pin like `==3.11` (PEP 440 =
 * exactly 3.11.0, often not installable) so the user understands why nothing matched.
 */
function buildNoCompatiblePythonMessage(requiresPython?: string): string {
    const spec = requiresPython?.trim();
    if (!spec) {
        return l10n.t(
            'No compatible Python could be found or installed for this script. Install a Python 3 interpreter, then try again. See the Python Environments output for details.',
        );
    }
    const exactMinor = /^==\s*(\d+\.\d+)\s*$/.exec(spec);
    if (exactMinor) {
        const minor = exactMinor[1];
        return l10n.t(
            'No compatible Python matches this script\'s requires-python "{0}". "{0}" requires exactly {1}.0, which may not be available to install.',
            spec,
            minor,
        );
    }
    return l10n.t(
        'No compatible Python was found or could be installed for requires-python "{0}". Try a broader version specifier. See the Python Environments output for details.',
        spec,
    );
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
 * when the PEP 723 inline-script feature flag is enabled. The single-file setup command is invoked by
 * the CodeLens and stays out of `package.json`; the bulk command is palette-gated behind the flag.
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
