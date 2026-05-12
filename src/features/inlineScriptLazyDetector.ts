// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as path from 'path';
import { Disposable, TextDocument, Uri } from 'vscode';
import {
    InlineScriptMetadata,
    isInlineScriptMetadataEnabled,
    readInlineScriptMetadataFromFile,
} from '../common/inlineScriptMetadata';
import { traceInfo, traceVerbose, traceWarn } from '../common/logging';
import {
    getOpenTextDocuments,
    getWorkspaceFolder,
    onDidOpenTextDocument,
    onDidSaveTextDocument,
} from '../common/workspace.apis';
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
     *
     * After subscribing we also replay every document already open at
     * activation time. Our `onLanguage:python` activation event fires
     * AFTER VS Code has already opened any restored editors, so the
     * `onDidOpenTextDocument` for the file that triggered activation
     * (the most common case) is gone by the time we subscribe. The
     * replay closes that gap; the per-URI dedup in `handleDocument`
     * keeps it idempotent if a live event happens to arrive too.
     */
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
     *
     * After subscribing we also replay every document already open at
     * activation time. Our `onLanguage:python` activation event fires
     * AFTER VS Code has already opened any restored editors, so the
     * `onDidOpenTextDocument` for the file that triggered activation
     * (the most common case) is gone by the time we subscribe. The
     * replay is deferred via `setImmediate` so VS Code finishes any
     * in-flight document registration first; the per-URI dedup in
     * `handleDocument` keeps it idempotent if a live event happens to
     * arrive too.
     */
    public activate(): void {
        this.subscriptions.push(
            onDidOpenTextDocument((doc) => this.handleDocument(doc, 'open')),
            onDidSaveTextDocument((doc) => this.handleDocument(doc, 'save')),
        );
        // Defer the catch-up pass so we observe `workspace.textDocuments`
        // AFTER VS Code finishes registering the document that triggered
        // our activation. Running the loop synchronously here can race
        // against VS Code's own initialization on `onLanguage:*` activation.
        const handle = setImmediate(() => {
            const openDocs = getOpenTextDocuments();
            traceInfo(
                `inlineScriptLazyDetector: activate() saw ${openDocs.length} open document(s): ` +
                    openDocs.map((d) => `[${d.languageId}:${d.uri.scheme}]${d.uri.toString()}`).join(', '),
            );
            for (const doc of openDocs) {
                void this.handleDocument(doc, 'open');
            }
        });
        this.subscriptions.push(new Disposable(() => clearImmediate(handle)));
    }

    public dispose(): void {
        this.subscriptions.forEach((s) => s.dispose());
        this.subscriptions.length = 0;
        this.inFlight.clear();
    }

    private async handleDocument(doc: TextDocument, trigger: 'open' | 'save'): Promise<void> {
        const uri = doc.uri;
        // Diagnostic: trace every event entering the detector so we
        // can see, at the default `Info` channel log level, whether
        // open/save events are reaching us at all.
        traceInfo(`inlineScriptLazyDetector: event received (${trigger}) ${uri.toString()}`);
        if (!shouldHandleUri(uri)) {
            traceInfo(
                `inlineScriptLazyDetector: skipped (${trigger}) ${uri.toString()} ` +
                    `(scheme='${uri.scheme}', extname='${path.extname(uri.fsPath).toLowerCase()}', ` +
                    `inWorkspace=${getWorkspaceFolder(uri) !== undefined})`,
            );
            return;
        }
        if (!isInlineScriptMetadataEnabled(uri)) {
            traceInfo(
                `inlineScriptLazyDetector: skipped (${trigger}) ${uri.fsPath} ` +
                    `(setting 'python-envs.useInlineScriptMetadata' is false)`,
            );
            return;
        }
        traceInfo(`inlineScriptLazyDetector: processing (${trigger}) ${uri.fsPath}`);
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

        // `projectManager.get()` does CONTAINMENT matching — for a
        // script inside a workspace folder it returns the folder
        // project, not undefined. That is the wrong answer here: a
        // script project is distinct from the folder that contains
        // it. Filter the result down to an exact-URI match before
        // deciding whether this file is already registered.
        const candidate = this.projectManager.get(uri);
        const existing = candidate !== undefined && candidate.uri.toString() === uri.toString() ? candidate : undefined;

        if (metadata === undefined) {
            // No (valid) block in the file. If it was previously
            // registered as a script project we keep it — the user
            // explicitly added it once, and yanking the project on a
            // passing edit would be surprising. We only clear the
            // cached metadata so downstream consumers don't act on
            // stale data.
            traceInfo(`inlineScriptLazyDetector: no metadata block in ${uri.fsPath} (${trigger})`);
            if (existing instanceof PythonProjectsImpl && existing.inlineScriptMetadata !== undefined) {
                existing.inlineScriptMetadata = undefined;
                traceInfo(`inlineScriptLazyDetector: cleared cached metadata for ${uri.fsPath} (${trigger}: no block)`);
            }
            return;
        }

        if (existing instanceof PythonProjectsImpl) {
            // Already a project — just refresh the cached metadata
            // (it may have changed on save; downstream code, e.g.
            // `getProjectInstallable`, is also free to re-read).
            existing.inlineScriptMetadata = metadata;
            traceInfo(`inlineScriptLazyDetector: refreshed metadata for ${uri.fsPath} (${trigger}: already a project)`);
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
            traceInfo(`inlineScriptLazyDetector: registered ${uri.fsPath} as a project (${trigger})`);
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
