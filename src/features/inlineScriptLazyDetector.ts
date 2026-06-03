// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as path from 'path';
import { Disposable, TextDocument, TextDocumentChangeEvent, Uri } from 'vscode';
import { readInlineScriptMetadataFromFile } from '../common/inlineScriptMetadata';
import { traceVerbose, traceWarn } from '../common/logging';
import { EventNames } from '../common/telemetry/constants';
import { sendTelemetryEvent } from '../common/telemetry/sender';
import {
    getOpenTextDocuments,
    getWorkspaceFolder,
    onDidChangeTextDocument,
    onDidOpenTextDocument,
    onDidSaveTextDocument,
} from '../common/workspace.apis';

/**
 * Silent on-open / on-save detector for `.py` files that declare
 * inline script metadata (PEP 723). The detector parses the head of
 * every eligible `.py` file the user opens or saves and emits two
 * anonymized telemetry events:
 *
 *  - `PEP723.DETECTED` once per (URI, session) the first time a
 *    valid `# /// script` block is observed. This is the denominator
 *    for the "how many users actually see PEP 723 files" question.
 *  - `PEP723.EDITED` once per (URI, session) the first time a
 *    previously-detected file receives a real text edit. Together
 *    with `DETECTED` this distinguishes viewers from editors.
 *
 * No URIs, file paths, or file content are sent. The detector does
 * not register projects, surface UI, or otherwise change extension
 * behavior; it is a pure observer.
 *
 * Detection is cheap (≤ 8 KiB read + regex + TOML parse) and runs
 * only on files the user has already shown intent in.
 */
export class InlineScriptLazyDetector implements Disposable {
    private readonly subscriptions: Disposable[] = [];
    // In-flight reads keyed by `uri.toString()` so rapid open+save
    // doesn't double-process the same file.
    private readonly inFlight = new Map<string, Promise<void>>();
    // URIs (as `uri.toString()`) for which we have already emitted
    // `PEP723.DETECTED` in this session. Used to dedup the detection
    // event across repeat opens/saves and to gate `PEP723.EDITED` so
    // the latter only fires for files we already counted as detected.
    private readonly detectedUris = new Set<string>();
    // URIs for which we have already emitted `PEP723.EDITED` in this
    // session. Each detected file emits at most one edited event.
    private readonly editedUris = new Set<string>();
    // Wall-clock ms (from `Date.now`) at which each URI's detection
    // event fired. Used to compute the `duration` measure on the
    // first-edit event.
    private readonly detectionAtMs = new Map<string, number>();
    // Flips to `true` in `dispose()`. Guards async continuations
    // inside `processOnce` so an in-flight read that completes after
    // disposal does not emit telemetry on a detector the host has
    // already torn down.
    private disposed = false;

    /**
     * Subscribe to workspace text-document events. Safe to call once
     * during extension activation.
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
            onDidChangeTextDocument((e) => this.handleChange(e)),
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
     * for the deferred activation catch-up. The per-URI dedup in
     * `handleDocument` keeps this safe to call repeatedly.
     */
    private replayOpenDocuments(source: 'activate'): void {
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
        this.disposed = true;
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
        // `Info` channel.
        traceVerbose(`inlineScriptLazyDetector: event received (${trigger}) ${uri.toString()}`);
        if (!shouldHandleUri(uri)) {
            traceVerbose(
                `inlineScriptLazyDetector: skipped (${trigger}) ${uri.toString()} ` +
                    `(scheme='${uri.scheme}', extname='${path.extname(uri.fsPath).toLowerCase()}', ` +
                    `inWorkspace=${getWorkspaceFolder(uri) !== undefined})`,
            );
            return;
        }
        const key = uri.toString();
        const existing = this.inFlight.get(key);
        if (existing) {
            // Coalesce repeated open/save events for the same URI.
            // We only parse for observation (telemetry), so the most
            // recent in-flight read is good enough; there is no
            // cached state downstream that could go stale.
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
        try {
            const metadata = await readInlineScriptMetadataFromFile(uri);
            if (this.disposed) {
                return;
            }
            if (metadata === undefined) {
                return;
            }
            const key = uri.toString();
            if (this.detectedUris.has(key)) {
                // Already counted this file in the current session.
                // Subsequent opens/saves of the same URI are silent.
                return;
            }
            this.detectedUris.add(key);
            this.detectionAtMs.set(key, Date.now());
            traceVerbose(`inlineScriptLazyDetector: detected inline script metadata in ${uri.fsPath} (${trigger})`);
            sendTelemetryEvent(
                EventNames.PEP723_DETECTED,
                { dependencyCount: metadata.dependencies?.length ?? 0 },
                {
                    trigger,
                    hasRequiresPython: metadata.requiresPython !== undefined,
                },
            );
        } catch (err) {
            // `readInlineScriptMetadataFromFile` already swallows I/O
            // errors internally. This catch is a defensive net for
            // unexpected synchronous throws (e.g. malformed URI).
            traceWarn(`inlineScriptLazyDetector: unexpected error while reading ${uri.fsPath}:`, err);
        }
    }

    /**
     * Emit `PEP723.EDITED` the first time a previously-detected URI
     * receives a real content change. The handler is hot (fires on
     * every keystroke in every text document workspace-wide) so it
     * bails out as cheaply as possible for the common case where the
     * file is not a tracked PEP 723 script.
     */
    private handleChange(e: TextDocumentChangeEvent): void {
        if (this.disposed) {
            return;
        }
        // `onDidChangeTextDocument` can fire with empty `contentChanges`
        // (e.g. dirty-state toggles); skip those — they aren't user edits.
        if (e.contentChanges.length === 0) {
            return;
        }
        const key = e.document.uri.toString();
        if (!this.detectedUris.has(key)) {
            return;
        }
        if (this.editedUris.has(key)) {
            return;
        }
        this.editedUris.add(key);
        const detectedAt = this.detectionAtMs.get(key);
        const duration = detectedAt !== undefined ? Date.now() - detectedAt : 0;
        traceVerbose(
            `inlineScriptLazyDetector: first edit observed on ${e.document.uri.fsPath} (${duration}ms after detection)`,
        );
        sendTelemetryEvent(EventNames.PEP723_EDITED, duration);
    }
}

/**
 * Cheap, side-effect-free gate for which URIs the lazy detector
 * should look at. Filters out non-file schemes, non-`.py`
 * extensions, and files that are not inside an open workspace
 * folder. Exported for test access.
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
