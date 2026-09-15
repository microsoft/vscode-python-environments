// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import {
    CancellationToken,
    CodeAction,
    CodeActionContext,
    CodeActionKind,
    CodeActionProvider,
    Diagnostic,
    Disposable,
    languages,
    Range,
    TextDocument,
} from 'vscode';
import { readInlineScriptMetadata, sliceHeaderBytes } from '../../common/inlineScript/metadata';
import { getInlineScriptRoutingKey, InlineScriptRoutingRegistry } from '../../common/inlineScript/routingRegistry';
import { InlineScriptStrings } from '../../common/localize';
import { isInlineScriptsFeatureEnabled } from '../../helpers';

/**
 * Diagnostic codes meaning "this import did not resolve", lowercased for comparison.
 *
 * `reportMissingModuleSource` is included deliberately, unlike in Pylance's own
 * `isMissingImportDiagnostic`: a stub without source means the package is not installed, which
 * setting the script's environment up fixes.
 */
const UNRESOLVED_IMPORT_DIAGNOSTIC_CODES: ReadonlySet<string> = new Set([
    // Pyright / Pylance / basedpyright.
    'reportmissingimports',
    'reportmissingmodulesource',
    // Ty.
    'unresolved-import',
    'possibly-missing-import',
    // Pyrefly.
    'missing-import',
    'missing-source',
    'missing-source-for-stubs',
    // mypy, via ms-python.mypy-type-checker.
    'import-not-found',
    'import-untyped',
]);

function normalizeDiagnosticCode(code: Diagnostic['code']): string | undefined {
    if (code === undefined || code === null) {
        return undefined;
    }
    const value = typeof code === 'object' ? code.value : code;
    return typeof value === 'string' || typeof value === 'number' ? String(value).toLowerCase() : undefined;
}

/**
 * Whether `diagnostic` reports an import that could not be resolved. Matches on `code`, never on
 * `source`: Pyrefly-backed Pylance reports its source as the literal string `pylance + pyrefly`.
 */
export function isUnresolvedImportDiagnostic(diagnostic: Diagnostic): boolean {
    const code = normalizeDiagnosticCode(diagnostic.code);
    return code !== undefined && UNRESOLVED_IMPORT_DIAGNOSTIC_CODES.has(code);
}

/**
 * Offers "Set up this script's Python environment" as a quick fix on an unresolved import in a `.py`
 * file that declares a PEP 723 `# /// script` block and has no inline-script environment yet.
 *
 * Complements the CodeLens, which is hidden while the document is dirty — the moment a user has just
 * typed the import that does not resolve. This provider parses the in-memory buffer instead.
 *
 * `diagnostics` and `isPreferred` are both left unset: setup installs the block's declared
 * dependencies verbatim and may not resolve the import at all, so the action must not claim to fix
 * the diagnostic or pre-empt a real import fix.
 */
export class InlineScriptSetupCodeActionProvider implements CodeActionProvider {
    constructor(
        private readonly routing: InlineScriptRoutingRegistry,
        private readonly setupCommand: string,
    ) {}

    /** Gates run cheapest-first, and before any parsing: VS Code may call this on every cursor move. */
    public provideCodeActions(
        document: TextDocument,
        _range: Range,
        context: CodeActionContext,
        _token: CancellationToken,
    ): CodeAction[] {
        if (!isInlineScriptsFeatureEnabled()) {
            return [];
        }
        if (!context.diagnostics.some(isUnresolvedImportDiagnostic)) {
            return [];
        }
        const uri = document.uri;
        if (!getInlineScriptRoutingKey(uri)) {
            return [];
        }
        if (this.routing.shouldRoute(uri)) {
            return [];
        }
        if (!readInlineScriptMetadata(sliceHeaderBytes(document.getText()), uri.fsPath)) {
            return [];
        }
        const action = new CodeAction(InlineScriptStrings.setUpScriptEnvironment, CodeActionKind.QuickFix);
        action.command = {
            title: InlineScriptStrings.setUpScriptEnvironment,
            command: this.setupCommand,
            arguments: [uri],
        };
        return [action];
    }
}

/** Register the inline-script quick fix for local `.py` files. */
export function registerInlineScriptSetupCodeAction(
    routing: InlineScriptRoutingRegistry,
    setupCommand: string,
): Disposable {
    return languages.registerCodeActionsProvider(
        { scheme: 'file', language: 'python' },
        new InlineScriptSetupCodeActionProvider(routing, setupCommand),
        { providedCodeActionKinds: [CodeActionKind.QuickFix] },
    );
}
