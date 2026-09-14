// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import {
    Diagnostic,
    DiagnosticCollection,
    DiagnosticSeverity,
    Disposable,
    languages,
    Range,
    TextDocument,
    Uri,
} from 'vscode';
import {
    InlineScriptMetadataProblem,
    parseInlineScriptMetadata,
    sliceHeaderBytes,
} from '../../common/inlineScript/metadata';
import { getInlineScriptRoutingKey } from '../../common/inlineScript/routingRegistry';
import { InlineScriptStrings } from '../../common/localize';
import { traceVerbose } from '../../common/logging';
import { createSimpleDebounce, SimpleDebounce } from '../../common/utils/debounce';
import { isSameOrParentPath } from '../../common/utils/pathUtils';
import {
    getOpenTextDocuments,
    onDidChangeTextDocument,
    onDidCloseTextDocument,
    onDidDeleteFiles,
    onDidOpenTextDocument,
    onDidRenameFiles,
    onDidSaveTextDocument,
} from '../../common/workspace.apis';

const VALIDATION_DEBOUNCE_MS = 300;

const DIAGNOSTIC_COLLECTION_NAME = 'python-envs-inline-script';

/** Publishes diagnostics for malformed PEP 723 inline script metadata, validating the live buffer. */
export class InlineScriptDiagnosticsPublisher implements Disposable {
    private readonly subscriptions: Disposable[] = [];
    // `createSimpleDebounce` owns one timer, so a shared instance would let
    // edits in one file cancel another's pending validation.
    private readonly pending = new Map<string, { debounce: SimpleDebounce; document: TextDocument }>();
    private readonly published = new Map<string, Uri>();
    private disposed = false;

    constructor(private readonly collection: DiagnosticCollection) {}

    /** Documents open at activation are replayed via `setImmediate`, because `onLanguage:python` fires after editors are restored. */
    public activate(): void {
        this.subscriptions.push(
            onDidOpenTextDocument((doc) => this.validate(doc)),
            onDidSaveTextDocument((doc) => this.validate(doc)),
            onDidChangeTextDocument((e) => this.scheduleValidation(e.document)),
            onDidCloseTextDocument((doc) => this.clear(doc.uri)),
            onDidDeleteFiles((e) => e.files.forEach((uri) => this.clearTree(uri))),
            onDidRenameFiles((e) =>
                e.files.forEach((file) => {
                    this.clearTree(file.oldUri);
                    this.revalidateIfOpen(file.newUri);
                }),
            ),
        );
        const handle = setImmediate(() => this.replayOpenDocuments());
        this.subscriptions.push(new Disposable(() => clearImmediate(handle)));
    }

    public dispose(): void {
        this.disposed = true;
        this.subscriptions.forEach((s) => s.dispose());
        this.subscriptions.length = 0;
        this.pending.forEach((entry) => entry.debounce.dispose());
        this.pending.clear();
        this.published.clear();
        this.collection.dispose();
    }

    private replayOpenDocuments(): void {
        if (this.disposed) {
            return;
        }
        const docs = getOpenTextDocuments().filter((doc) => shouldValidateUri(doc.uri));
        traceVerbose(`inlineScriptDiagnostics: activation replay over ${docs.length} candidate .py document(s)`);
        for (const doc of docs) {
            this.validate(doc);
        }
    }

    private scheduleValidation(document: TextDocument): void {
        if (this.disposed || !shouldValidateUri(document.uri)) {
            return;
        }
        const key = document.uri.toString();
        const existing = this.pending.get(key);
        if (existing) {
            existing.document = document;
            existing.debounce.trigger();
            return;
        }
        const entry = {
            document,
            debounce: createSimpleDebounce(VALIDATION_DEBOUNCE_MS, () => {
                const queued = this.pending.get(key);
                this.pending.delete(key);
                if (queued) {
                    this.validate(queued.document);
                }
            }),
        };
        this.pending.set(key, entry);
        entry.debounce.trigger();
    }

    private validate(document: TextDocument): void {
        if (this.disposed || !shouldValidateUri(document.uri)) {
            return;
        }
        this.cancelPending(document.uri);

        const uri = document.uri;
        const result = parseInlineScriptMetadata(sliceHeaderBytes(document.getText()), uri.fsPath);
        const problems = result.kind === 'none' ? [] : result.problems;
        if (problems.length === 0) {
            this.clear(uri);
            return;
        }

        const diagnostics = problems.map((problem) => toDiagnostic(document, problem));
        this.collection.set(uri, diagnostics);
        this.published.set(uri.toString(), uri);
        traceVerbose(
            `inlineScriptDiagnostics: published ${diagnostics.length} problem(s) for ${uri.fsPath}: ` +
                problems.map((p) => p.code).join(', '),
        );
    }

    private revalidateIfOpen(uri: Uri): void {
        if (this.disposed || !shouldValidateUri(uri)) {
            return;
        }
        const key = uri.toString();
        const doc = getOpenTextDocuments().find((d) => d.uri.toString() === key);
        if (doc) {
            this.validate(doc);
        }
    }

    private clear(uri: Uri): void {
        this.cancelPending(uri);
        const key = uri.toString();
        if (this.published.delete(key)) {
            this.collection.delete(uri);
        }
    }

    private clearTree(uri: Uri): void {
        this.clear(uri);
        if (uri.scheme !== 'file') {
            return;
        }
        for (const published of Array.from(this.published.values())) {
            if (published.scheme === 'file' && isSameOrParentPath(uri.fsPath, published.fsPath)) {
                this.clear(published);
            }
        }
    }

    private cancelPending(uri: Uri): void {
        const key = uri.toString();
        const entry = this.pending.get(key);
        if (entry) {
            entry.debounce.dispose();
            this.pending.delete(key);
        }
    }
}

/** Whether inline script metadata is meaningful for `uri` — a local `.py` file. */
export function shouldValidateUri(uri: Uri): boolean {
    return getInlineScriptRoutingKey(uri) !== undefined;
}

function toDiagnostic(document: TextDocument, problem: InlineScriptMetadataProblem): Diagnostic {
    const range = new Range(
        document.positionAt(problem.sourceRange.start),
        document.positionAt(problem.sourceRange.end),
    );
    const diagnostic = new Diagnostic(range, messageFor(problem), severityFor(problem));
    diagnostic.source = InlineScriptStrings.diagnosticSource;
    diagnostic.code = problem.code;
    return diagnostic;
}

function messageFor(problem: InlineScriptMetadataProblem): string {
    switch (problem.code) {
        case 'unterminated-block':
            return InlineScriptStrings.unterminatedBlock;
        case 'multiple-blocks':
            return InlineScriptStrings.multipleBlocks;
        case 'invalid-content-line':
            return InlineScriptStrings.invalidContentLine(problem.detail ?? '');
        case 'invalid-block-marker':
            return InlineScriptStrings.invalidBlockMarker(problem.detail ?? '');
        case 'invalid-toml':
            return InlineScriptStrings.invalidToml(problem.detail ?? '');
        case 'invalid-field-type':
            return InlineScriptStrings.invalidFieldType(problem.detail ?? '');
        default:
            return InlineScriptStrings.unterminatedBlock;
    }
}

function severityFor(problem: InlineScriptMetadataProblem): DiagnosticSeverity {
    return problem.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error;
}

export function registerInlineScriptDiagnostics(): Disposable {
    const publisher = new InlineScriptDiagnosticsPublisher(
        languages.createDiagnosticCollection(DIAGNOSTIC_COLLECTION_NAME),
    );
    publisher.activate();
    return publisher;
}
