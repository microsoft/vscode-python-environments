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

const UNRESOLVED_IMPORT_DIAGNOSTIC_CODES: ReadonlySet<string> = new Set([
    // Pyright / Pylance / basedpyright.
    'reportmissingimports',
    'reportmissingmodulesource', // Stub found but no source: the package is not installed.
    // Ty.
    'unresolved-import',
    'possibly-missing-import',
    // Pyrefly.
    'missing-import',
    'missing-source',
    'missing-source-for-stubs',
    // mypy.
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

/** Whether `diagnostic` reports an unresolved import. Matches on `code` only, never on `source`. */
export function isUnresolvedImportDiagnostic(diagnostic: Diagnostic): boolean {
    const code = normalizeDiagnosticCode(diagnostic.code);
    return code !== undefined && UNRESOLVED_IMPORT_DIAGNOSTIC_CODES.has(code);
}

/**
 * Offers inline-script environment setup as a quick fix on an unresolved import, complementing the
 * CodeLens that is hidden while the document is dirty. `diagnostics` and `isPreferred` stay unset:
 * setup installs the block's declared dependencies verbatim and may not resolve the import at all.
 */
export class InlineScriptSetupCodeActionProvider implements CodeActionProvider {
    constructor(
        private readonly routing: InlineScriptRoutingRegistry,
        private readonly setupCommand: string,
    ) {}

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
