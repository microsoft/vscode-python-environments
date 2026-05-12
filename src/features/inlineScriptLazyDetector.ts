// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as path from 'path';
import { Disposable, TextDocument, Uri } from 'vscode';
import {
    InlineScriptMetadata,
    isInlineScriptMetadataEnabled,
    readInlineScriptMetadataFromFile,
} from '../common/inlineScriptMetadata';
import { traceVerbose, traceWarn } from '../common/logging';
import { getWorkspaceFolder, onDidOpenTextDocument, onDidSaveTextDocument } from '../common/workspace.apis';
import { PythonProjectManager, PythonProjectsImpl } from '../internal.api';

/**
 * Lazy on-open / on-save detector for `.py` files that declare inline
 * script metadata (PEP 723). This is the PRIMARY detection path: when
 * the user opens or saves a `.py` script, we read the head of the
 * file, parse any `# /// script` block, and register the script as a
 * Python project so its environment and dependencies surface in the
 * rest of the extension.
 *
 * Detection is cheap (≤ 8 KiB read + regex + TOML parse) and runs
 * only on files the user has already shown intent in. Workspace-wide
 * scanning is the responsibility of the opt-in creator in
 * `src/features/creators/inlineScriptDetector.ts`.
 */
export class InlineScriptLazyDetector implements Disposable {
    private readonly subscriptions: Disposable[] = [];
    // In-flight reads keyed by `uri.toString()` so rapid open+save
    // doesn't double-process the same file.
    private readonly inFlight = new Map<string, Promise<void>>();

    constructor(private readonly projectManager: PythonProjectManager) {}

    /**
     * Subscribe to workspace text-document events. Safe to call once
     * during extension activation. The detector starts working
     * immediately; the experimental gate is re-checked on every event
     * so toggling the setting takes effect without a reload.
     *
     * Listeners return the promise from `handleDocument` rather than
     * void-ing it. VS Code's event bus does not await listener
     * promises (so production behaviour is unchanged — still
     * fire-and-forget), but returning the promise lets tests await
     * the work triggered by a synthetic open/save event.
     */
    public activate(): void {
        this.subscriptions.push(
            onDidOpenTextDocument((doc) => this.handleDocument(doc, 'open')),
            onDidSaveTextDocument((doc) => this.handleDocument(doc, 'save')),
        );
    }

    public dispose(): void {
        this.subscriptions.forEach((s) => s.dispose());
        this.subscriptions.length = 0;
        this.inFlight.clear();
    }

    private async handleDocument(doc: TextDocument, trigger: 'open' | 'save'): Promise<void> {
        const uri = doc.uri;
        if (!shouldHandleUri(uri)) {
            return;
        }
        if (!isInlineScriptMetadataEnabled(uri)) {
            return;
        }
        const key = uri.toString();
        const existing = this.inFlight.get(key);
        if (existing) {
            // A previous open/save is still in flight for the same
            // URI. Wait for it and skip; that read's result is
            // authoritative.
            await existing;
            return;
        }
        const work = this.processOnce(uri, trigger).finally(() => {
            this.inFlight.delete(key);
        });
        this.inFlight.set(key, work);
        await work;
    }

    private async processOnce(uri: Uri, trigger: 'open' | 'save'): Promise<void> {
        let metadata: InlineScriptMetadata | undefined;
        try {
            metadata = await readInlineScriptMetadataFromFile(uri);
        } catch (err) {
            // `readInlineScriptMetadataFromFile` already swallows I/O
            // errors internally. This catch is a defensive net for
            // unexpected synchronous throws (e.g. malformed URI).
            traceWarn(`inlineScriptLazyDetector: unexpected error while reading ${uri.fsPath}:`, err);
            return;
        }

        const existing = this.projectManager.get(uri);

        if (metadata === undefined) {
            // No (valid) block in the file. If it was previously
            // registered as a script project we keep it — the user
            // explicitly added it once, and yanking the project on a
            // passing edit would be surprising. We only clear the
            // cached metadata so downstream consumers don't act on
            // stale data.
            if (existing instanceof PythonProjectsImpl && existing.inlineScriptMetadata !== undefined) {
                existing.inlineScriptMetadata = undefined;
                traceVerbose(
                    `inlineScriptLazyDetector: cleared cached metadata for ${uri.fsPath} (${trigger}: no block)`,
                );
            }
            return;
        }

        if (existing instanceof PythonProjectsImpl) {
            // Already a project — just refresh the cached metadata
            // (it may have changed on save; downstream code, e.g.
            // `getProjectInstallable`, is also free to re-read).
            existing.inlineScriptMetadata = metadata;
            traceVerbose(
                `inlineScriptLazyDetector: refreshed metadata for ${uri.fsPath} (${trigger}: already a project)`,
            );
            return;
        }

        if (existing !== undefined) {
            // The URI is somehow already registered with a different
            // `PythonProject` implementation. Don't replace it.
            traceVerbose(`inlineScriptLazyDetector: ${uri.fsPath} is already a project (non-impl); skipping.`);
            return;
        }

        const project = new PythonProjectsImpl(path.basename(uri.fsPath), uri);
        project.inlineScriptMetadata = metadata;
        try {
            await this.projectManager.add(project);
            traceVerbose(`inlineScriptLazyDetector: registered ${uri.fsPath} as a project (${trigger})`);
        } catch (err) {
            traceWarn(`inlineScriptLazyDetector: failed to register ${uri.fsPath} as a project:`, err);
        }
    }
}

/**
 * Cheap, side-effect-free gate for which URIs the lazy detector
 * should look at. Filters out non-file schemes, non-`.py`
 * extensions, and files that are not inside an open workspace
 * folder. Exported for test access and for re-use by the opt-in
 * workspace-scan creator.
 */
export function shouldHandleUri(uri: Uri): boolean {
    if (uri.scheme !== 'file') {
        return false;
    }
    if (path.extname(uri.fsPath).toLowerCase() !== '.py') {
        return false;
    }
    if (getWorkspaceFolder(uri) === undefined) {
        return false;
    }
    return true;
}
