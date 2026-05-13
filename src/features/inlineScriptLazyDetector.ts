// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as path from 'path';
import { Disposable, TextDocument, Uri } from 'vscode';
import {
    INLINE_SCRIPT_METADATA_SETTING,
    InlineScriptMetadata,
    isInlineScriptMetadataEnabled,
    readInlineScriptMetadataFromFile,
} from '../common/inlineScriptMetadata';
import { traceInfo, traceVerbose, traceWarn } from '../common/logging';
import {
    getOpenTextDocuments,
    getWorkspaceFolder,
    onDidChangeConfiguration,
    onDidOpenTextDocument,
    onDidSaveTextDocument,
} from '../common/workspace.apis';
import { PythonProjectManager, PythonProjectsImpl } from '../internal.api';

/**
 * Fully-qualified configuration key for the experimental setting that
 * gates the inline-script-metadata feature. Re-exported from
 * `../common/inlineScriptMetadata` so the `onDidChangeConfiguration`
 * filter and the accessor `isInlineScriptMetadataEnabled` are
 * guaranteed to refer to the same setting.
 */
const SETTING_FQN = INLINE_SCRIPT_METADATA_SETTING;

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
     * replay is deferred via `setImmediate` so VS Code finishes any
     * in-flight document registration first; the per-URI dedup in
     * `handleDocument` keeps it idempotent if a live event happens to
     * arrive too.
     */
    public activate(): void {
        this.subscriptions.push(
            onDidOpenTextDocument((doc) => this.handleDocument(doc, 'open')),
            onDidSaveTextDocument((doc) => this.handleDocument(doc, 'save')),
            // When the user toggles `python-envs.useInlineScriptMetadata`
            // we replay the catch-up pass so already-open `.py` files
            // get inspected without requiring a window reload or a
            // manual save. The per-event gate inside `handleDocument`
            // makes the off→still-off and on→still-on cases free; the
            // useful case is off→on, where we discover scripts the
            // user has had open all along.
            onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration(SETTING_FQN)) {
                    this.replayOpenDocuments('config-change');
                }
            }),
        );
        // Defer the catch-up pass so we observe `workspace.textDocuments`
        // AFTER VS Code finishes registering the document that triggered
        // our activation. Running the loop synchronously here can race
        // against VS Code's own initialization on `onLanguage:*` activation.
        const handle = setImmediate(() => this.replayOpenDocuments('activate'));
        this.subscriptions.push(new Disposable(() => clearImmediate(handle)));
    }

    /**
     * Walk every currently-open text document and run it through
     * `handleDocument` as if a synthetic `open` event had fired. Used
     * both for the deferred activation catch-up and for the
     * setting-toggle replay. The per-URI dedup in `handleDocument`
     * keeps this safe to call repeatedly.
     */
    private replayOpenDocuments(source: 'activate' | 'config-change'): void {
        // Restrict the replay to documents that the per-event handler
        // would actually look at. This keeps the activation log
        // proportional to the work the detector will do — on an
        // editor with many tabs open we would otherwise dump every
        // URI just to throw most of them away inside
        // `handleDocument`.
        const openDocs = getOpenTextDocuments().filter((d) => shouldHandleUri(d.uri));
        if (openDocs.length === 0) {
            traceVerbose(`inlineScriptLazyDetector: ${source} replay found no candidate .py documents`);
            return;
        }
        traceVerbose(
            `inlineScriptLazyDetector: ${source} replay over ${openDocs.length} candidate .py document(s): ` +
                openDocs.map((d) => d.uri.fsPath).join(', '),
        );
        for (const doc of openDocs) {
            void this.handleDocument(doc, 'open');
        }
    }

    public dispose(): void {
        this.subscriptions.forEach((s) => s.dispose());
        this.subscriptions.length = 0;
        this.inFlight.clear();
    }

    private async handleDocument(doc: TextDocument, trigger: 'open' | 'save'): Promise<void> {
        const uri = doc.uri;
        // Diagnostic: trace every event entering the detector. This
        // is high-frequency (fires on every keystroke-triggered save
        // and on every editor open) so it stays at `traceVerbose` —
        // the `Trace` log level — to avoid flooding the default
        // `Info` channel. First-time project registration is logged
        // at `traceInfo` further down.
        traceVerbose(`inlineScriptLazyDetector: event received (${trigger}) ${uri.toString()}`);
        if (!shouldHandleUri(uri)) {
            traceVerbose(
                `inlineScriptLazyDetector: skipped (${trigger}) ${uri.toString()} ` +
                    `(scheme='${uri.scheme}', extname='${path.extname(uri.fsPath).toLowerCase()}', ` +
                    `inWorkspace=${getWorkspaceFolder(uri) !== undefined})`,
            );
            return;
        }
        if (!isInlineScriptMetadataEnabled(uri)) {
            traceVerbose(
                `inlineScriptLazyDetector: skipped (${trigger}) ${uri.fsPath} ` +
                    `(setting 'python-envs.useInlineScriptMetadata' is false)`,
            );
            return;
        }
        traceVerbose(`inlineScriptLazyDetector: processing (${trigger}) ${uri.fsPath}`);
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
            traceVerbose(`inlineScriptLazyDetector: no metadata block in ${uri.fsPath} (${trigger})`);
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
