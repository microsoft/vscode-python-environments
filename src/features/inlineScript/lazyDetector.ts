// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as path from 'path';
import { Disposable, TextDocument, TextDocumentChangeEvent, TextDocumentContentChangeEvent, Uri } from 'vscode';
import { readInlineScriptMetadataFromFile } from '../../common/inlineScript/metadata';
import { getInlineScriptRoutingKey, InlineScriptRoutingRegistry } from '../../common/inlineScript/routingRegistry';
import { traceVerbose, traceWarn } from '../../common/logging';
import { EventNames } from '../../common/telemetry/constants';
import { sendTelemetryEvent } from '../../common/telemetry/sender';
import {
    getOpenTextDocuments,
    getWorkspaceFolder,
    onDidDeleteFiles,
    onDidChangeTextDocument,
    onDidOpenTextDocument,
    onDidRenameFiles,
    onDidSaveTextDocument,
} from '../../common/workspace.apis';

/**
 * Silent on-open / on-save detector for `.py` files that declare
 * inline script metadata (PEP 723). The detector parses the head of
 * every eligible `.py` file the user opens or saves and emits two
 * anonymized telemetry events:
 *
 *  - `inlineScript.detected` once per (URI, session) the first time a
 *    valid `# /// script` block is observed. This is the denominator
 *    for the "how many users actually see inline script files" question.
 *  - `inlineScript.edited` once per (URI, session) the first time a
 *    previously-detected file receives a real text edit. Together
 *    with `inlineScript.detected` this distinguishes viewers from editors.
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
    // In-flight reads keyed by `uri.toString()` so rapid open events
    // don't double-process the same file.
    private readonly inFlight = new Map<string, Promise<void>>();
    // Routing reads have a generation per URI. A save that arrives while
    // an older read is in flight advances its generation and queues a
    // post-save read, preventing the stale read from publishing metadata.
    private readonly routingReadGenerations = new Map<string, number>();
    // URIs (as `uri.toString()`) for which we have already emitted
    // `inlineScript.detected` in this session. Used to dedup the detection
    // event across repeat opens/saves and to gate `inlineScript.edited` so
    // the latter only fires for files we already counted as detected.
    private readonly detectedUris = new Set<string>();
    // URIs for which we have already emitted `inlineScript.edited` in this
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

    constructor(private readonly routingRegistry?: InlineScriptRoutingRegistry) {}

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
        if (this.routingRegistry) {
            this.subscriptions.push(
                onDidDeleteFiles((e) => e.files.forEach((uri) => this.clearRouteability(uri))),
                onDidRenameFiles((e) => e.files.forEach((file) => this.clearRouteability(file.oldUri))),
            );
        }
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
        const openDocs = getOpenTextDocuments().filter((d) => this.shouldTrackUri(d.uri));
        const candidateDescription = this.routingRegistry ? 'candidate local .py' : 'candidate .py';
        if (openDocs.length === 0) {
            traceVerbose(`inlineScriptLazyDetector: ${source} replay found no ${candidateDescription} documents`);
            return;
        }
        traceVerbose(
            `inlineScriptLazyDetector: ${source} replay over ${openDocs.length} ${candidateDescription} document(s): ` +
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
        this.routingReadGenerations.clear();
    }

    private async handleDocument(doc: TextDocument, trigger: 'open' | 'save'): Promise<void> {
        const uri = doc.uri;
        // Diagnostic: trace every event entering the detector. This
        // is high-frequency (fires on every keystroke-triggered save
        // and on every editor open) so it stays at `traceVerbose` —
        // the `Trace` log level — to avoid flooding the default
        // `Info` channel.
        traceVerbose(`inlineScriptLazyDetector: event received (${trigger}) ${uri.toString()}`);
        if (!this.shouldTrackUri(uri)) {
            traceVerbose(
                `inlineScriptLazyDetector: skipped (${trigger}) ${uri.toString()} ` +
                    `(scheme='${uri.scheme}', extname='${path.extname(uri.fsPath).toLowerCase()}', ` +
                    `inWorkspace=${getWorkspaceFolder(uri) !== undefined})`,
            );
            return;
        }
        if (this.routingRegistry && trigger === 'open' && doc.isDirty) {
            traceVerbose(`inlineScriptLazyDetector: withholding dirty document metadata for ${uri.toString()}`);
            this.clearRouteability(uri);
            return;
        }
        const key = uri.toString();
        const existing = this.inFlight.get(key);
        if (existing) {
            if (this.routingRegistry && trigger === 'save') {
                const routingGeneration = this.advanceRoutingReadGeneration(key);
                const work = existing.then(() =>
                    this.processOnce(uri, trigger, shouldHandleUri(uri), routingGeneration),
                );
                this.trackInFlight(key, work, routingGeneration);
                await work;
                return;
            }
            // Coalesce repeated open events, and all events in telemetry-only
            // mode, where there is no routing state to become stale.
            await existing;
            return;
        }
        const routingGeneration = this.routingRegistry ? this.currentRoutingReadGeneration(key) : undefined;
        const work = this.processOnce(uri, trigger, shouldHandleUri(uri), routingGeneration);
        this.trackInFlight(key, work, routingGeneration);
        await work;
    }

    private async processOnce(
        uri: Uri,
        trigger: 'open' | 'save',
        shouldEmitTelemetry: boolean,
        routingGeneration?: number,
    ): Promise<void> {
        try {
            const metadata = await readInlineScriptMetadataFromFile(uri);
            if (this.disposed) {
                return;
            }
            if (this.routingRegistry) {
                if (this.routingReadGenerations.get(uri.toString()) === routingGeneration) {
                    this.routingRegistry.setMetadata(uri, metadata);
                }
                if (!shouldEmitTelemetry || metadata === undefined) {
                    return;
                }
            } else if (metadata === undefined) {
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
                EventNames.INLINE_SCRIPT_DETECTED,
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
     * Emit `inlineScript.edited` the first time a previously-detected URI
     * receives a real content change. The handler is hot (fires on
     * every keystroke in every text document workspace-wide) so it
     * bails out as cheaply as possible for the common case where the
     * file is not a tracked inline script.
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
        if (this.routingRegistry) {
            const metadata = this.routingRegistry.getMetadata(e.document.uri);
            if (
                metadata &&
                this.contentChangesMayAffectMetadata(
                    e.contentChanges,
                    metadata.sourceRange?.end ?? metadata.range.end,
                )
            ) {
                this.clearRouteability(e.document.uri);
            }
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
        sendTelemetryEvent(EventNames.INLINE_SCRIPT_EDITED, duration);
    }

    private contentChangesMayAffectMetadata(
        changes: readonly TextDocumentContentChangeEvent[],
        metadataEnd: number,
    ): boolean {
        return changes.some((change) => change.rangeOffset < metadataEnd);
    }

    private clearRouteability(uri: Uri): void {
        if (!this.routingRegistry || !shouldTrackRoutingUri(uri)) {
            return;
        }
        this.routingRegistry.clearMetadata(uri);
        this.routingRegistry.setValidatedAssociation(uri, false);
    }

    private currentRoutingReadGeneration(key: string): number {
        const current = this.routingReadGenerations.get(key);
        if (current !== undefined) {
            return current;
        }
        this.routingReadGenerations.set(key, 0);
        return 0;
    }

    private advanceRoutingReadGeneration(key: string): number {
        const next = this.currentRoutingReadGeneration(key) + 1;
        this.routingReadGenerations.set(key, next);
        return next;
    }

    private trackInFlight(key: string, work: Promise<void>, routingGeneration: number | undefined): void {
        this.inFlight.set(key, work);
        void work.then(
            () => this.clearInFlight(key, work, routingGeneration),
            () => this.clearInFlight(key, work, routingGeneration),
        );
    }

    private clearInFlight(key: string, work: Promise<void>, routingGeneration: number | undefined): void {
        if (this.inFlight.get(key) !== work) {
            return;
        }
        this.inFlight.delete(key);
        if (routingGeneration !== undefined && this.routingReadGenerations.get(key) === routingGeneration) {
            this.routingReadGenerations.delete(key);
        }
    }

    private shouldTrackUri(uri: Uri): boolean {
        return this.routingRegistry ? shouldTrackRoutingUri(uri) : shouldHandleUri(uri);
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

function shouldTrackRoutingUri(uri: Uri): boolean {
    return getInlineScriptRoutingKey(uri) !== undefined;
}
