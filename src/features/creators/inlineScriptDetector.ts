// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as path from 'path';
import { Uri } from 'vscode';
import { PythonProject, PythonProjectCreator, PythonProjectCreatorOptions } from '../../api';
import {
    InlineScriptMetadata,
    isInlineScriptMetadataEnabled,
    readInlineScriptMetadataFromFile,
} from '../../common/inlineScriptMetadata';
import { InlineScriptStrings } from '../../common/localize';
import { traceInfo, traceVerbose } from '../../common/logging';
import { showInformationMessage, showQuickPickWithButtons } from '../../common/window.apis';
import { findFiles, getWorkspaceFolders } from '../../common/workspace.apis';
import { PythonProjectManager, PythonProjectsImpl } from '../../internal.api';

/**
 * Hard cap on how many `.py` files the opt-in workspace-scan creator
 * will inspect. Per design principle §3.10 this is intentionally a
 * code constant rather than a user-facing setting while the feature
 * is experimental.
 */
export const MAX_SCRIPTS_TO_SCAN = 500;

/**
 * Glob pattern for the `.py` files we consider. The exclusion glob
 * mirrors the existing pip-installable scan in `pipUtils.ts` plus a
 * handful of additional caches that tend to contain large numbers of
 * `.py` files we never want to inspect (mypy/pytest caches and the
 * special `__pypackages__` PEP 582 directory).
 */
const SCRIPT_INCLUDE = '**/*.py';
const SCRIPT_EXCLUDE =
    '**/{.venv*,.git,.nox,.tox,.conda,site-packages,__pypackages__,node_modules,.mypy_cache,.pytest_cache}/**';

/** Maximum number of header reads to run in parallel. */
const SCAN_CONCURRENCY = 8;

/**
 * Opt-in `PythonProjectCreator` that scans the open workspace folders
 * for `.py` files which declare inline script metadata (PEP 723) and
 * offers any newly-found scripts as Python projects.
 *
 * This is the SECONDARY discovery path. The primary path is the lazy
 * detector in `src/features/inlineScriptLazyDetector.ts`, which picks
 * up scripts as the user opens or saves them. This creator is for
 * users who want bulk discovery on demand (for example, when they
 * first turn the experimental setting on in a workspace that already
 * contains many scripts).
 */
export class InlineScriptDetector implements PythonProjectCreator {
    public readonly name = 'inlineScriptDetector';
    public readonly displayName = InlineScriptStrings.detectorDisplayName;
    public readonly description = InlineScriptStrings.detectorDescription;

    constructor(private readonly pm: PythonProjectManager) {}

    public async create(_options?: PythonProjectCreatorOptions): Promise<PythonProject[] | undefined> {
        // The feature is gated behind the experimental setting, which
        // is `resource`-scoped — so in a multi-root workspace it may
        // be on in some folders and off in others. Bail early only if
        // it is off everywhere (no folder has it enabled, and the
        // window-level fallback is also off). Per-folder filtering of
        // discovered candidates happens further down.
        if (!isAnyFolderEnabled()) {
            setImmediate(() => {
                showInformationMessage(InlineScriptStrings.noScriptsFound);
            });
            return undefined;
        }

        const candidates = await findFiles(SCRIPT_INCLUDE, SCRIPT_EXCLUDE, MAX_SCRIPTS_TO_SCAN);
        if (!candidates || candidates.length === 0) {
            setImmediate(() => {
                showInformationMessage(InlineScriptStrings.noScriptsFound);
            });
            return undefined;
        }

        // Filter out:
        //  (a) candidates inside a workspace folder where the user has
        //      disabled the feature (resource-scoped setting), and
        //  (b) scripts that are already registered as a project with
        //      the exact same URI. Folder-scoped projects that happen
        //      to contain this script are intentionally NOT filtered
        //      out: a `.py` file with inline metadata is its own
        //      project and sits alongside its enclosing folder
        //      project.
        //
        // URI identity uses `uri.toString()` to match the equality
        // check used by `InlineScriptLazyDetector` — keeping the two
        // detectors agreed on what "the same project" means avoids
        // Windows drive-letter / trailing-separator divergence that a
        // raw `path.normalize` comparison can produce.
        const fresh = candidates.filter((uri) => {
            if (!isInlineScriptMetadataEnabled(uri)) {
                return false;
            }
            const existing = this.pm.get(uri);
            if (!existing) {
                return true;
            }
            return existing.uri.toString() !== uri.toString();
        });
        if (fresh.length === 0) {
            traceInfo(
                `InlineScriptDetector: no fresh candidates after filtering ${candidates.length} .py file(s) ` +
                    `(disabled folders or already-registered).`,
            );
            setImmediate(() => {
                showInformationMessage(InlineScriptStrings.noScriptsFound);
            });
            return undefined;
        }

        // Read headers in bounded parallel batches. Each read is at
        // most `MAX_HEADER_BYTES` (8 KiB) so the total I/O at the cap
        // (500 files × 8 KiB ≈ 4 MiB) is small.
        const withMetadata = await scanForInlineScripts(fresh);
        if (withMetadata.length === 0) {
            traceInfo(`InlineScriptDetector: scanned ${fresh.length} .py files, none declared inline metadata.`);
            setImmediate(() => {
                showInformationMessage(InlineScriptStrings.noScriptsFound);
            });
            return undefined;
        }

        const items = withMetadata
            .map(({ uri }) => ({
                label: path.basename(uri.fsPath),
                description: uri.fsPath,
                uri,
            }))
            .sort((a, b) => a.label.localeCompare(b.label));

        const selected = await showQuickPickWithButtons(items, {
            canPickMany: true,
            ignoreFocusOut: true,
            placeHolder: InlineScriptStrings.selectScripts,
            showBackButton: true,
        });

        let chosen: typeof items;
        if (Array.isArray(selected)) {
            chosen = selected as typeof items;
        } else if (selected) {
            chosen = [selected as (typeof items)[number]];
        } else {
            // User cancelled the picker.
            return undefined;
        }
        if (chosen.length === 0) {
            return undefined;
        }

        // Re-associate each chosen URI back to its metadata so we can
        // cache it on the project. We do this rather than re-reading
        // the file so a save between scan and pick can't change what
        // the user just confirmed.
        const metadataByUri = new Map(withMetadata.map((r) => [r.uri.toString(), r.metadata]));
        const projects: PythonProject[] = chosen.map((c) => {
            const proj = new PythonProjectsImpl(path.basename(c.uri.fsPath), c.uri);
            proj.inlineScriptMetadata = metadataByUri.get(c.uri.toString());
            return proj;
        });
        await this.pm.add(projects);
        return projects;
    }
}

/**
 * Returns `true` when the inline-script-metadata feature is enabled
 * in at least one open workspace folder (or, if no folders are open,
 * at the window / user level). The setting is `resource`-scoped, so a
 * window-level read alone would miss folder-only opt-ins in a
 * multi-root workspace.
 */
function isAnyFolderEnabled(): boolean {
    const folders = getWorkspaceFolders() ?? [];
    if (folders.length === 0) {
        return isInlineScriptMetadataEnabled();
    }
    return folders.some((f) => isInlineScriptMetadataEnabled(f.uri));
}

/**
 * Read inline script metadata from each URI in `uris` with bounded
 * parallelism, returning only the URIs whose `.py` file declared a
 * well-formed `# /// script` block. Exported for unit-test use.
 */
export async function scanForInlineScripts(
    uris: readonly Uri[],
): Promise<Array<{ uri: Uri; metadata: InlineScriptMetadata }>> {
    const results: Array<{ uri: Uri; metadata: InlineScriptMetadata }> = [];
    let cursor = 0;

    const worker = async (): Promise<void> => {
        for (;;) {
            const index = cursor;
            cursor += 1;
            if (index >= uris.length) {
                return;
            }
            const uri = uris[index];
            try {
                const metadata = await readInlineScriptMetadataFromFile(uri);
                if (metadata !== undefined) {
                    results.push({ uri, metadata });
                }
            } catch (err) {
                traceVerbose(`InlineScriptDetector: failed to read ${uri.fsPath}:`, err);
            }
        }
    };

    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(SCAN_CONCURRENCY, uris.length); i++) {
        workers.push(worker());
    }
    await Promise.all(workers);
    return results;
}
