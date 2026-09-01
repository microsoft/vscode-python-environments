// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import {
    CancellationToken,
    CodeLens,
    CodeLensProvider,
    Disposable,
    EventEmitter,
    l10n,
    languages,
    Range,
    TextDocument,
} from 'vscode';
import { InlineScriptRoutingRegistry } from '../../common/inlineScript/routingRegistry';

/**
 * Shows a single "Set up environment for this script" CodeLens above a `.py` file's PEP 723
 * `# /// script` block, but only when the file has saved inline metadata that is not currently
 * backed by a validated inline-script environment.
 *
 * The provider is a pure observer of {@link InlineScriptRoutingRegistry}:
 *  - `getMetadata` returns the last saved metadata (the detector clears it while the metadata
 *    region is dirty), so the lens tracks *saved* metadata and disappears while it is being edited.
 *  - `shouldRoute` is true once a validated association matching the current metadata exists, so the
 *    lens hides after setup and reappears if a metadata change later invalidates that association.
 */
export class InlineScriptCodeLensProvider implements CodeLensProvider, Disposable {
    private readonly _onDidChangeCodeLenses = new EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
    private readonly subscriptions: Disposable[] = [];

    constructor(
        private readonly routing: InlineScriptRoutingRegistry,
        private readonly setupCommand: string,
    ) {
        this.subscriptions.push(
            this.routing.onDidChangeRouteability(() => this._onDidChangeCodeLenses.fire()),
            // Only metadata arriving or changing can add/replace a lens; a scan that finds no metadata
            // (the common case for ordinary .py files) needs no refresh. Hiding a lens for an
            // edited/removed block is handled by VS Code re-querying on the document change itself.
            this.routing.onDidChangeMetadata((e) => {
                if (e.metadata !== undefined) {
                    this._onDidChangeCodeLenses.fire();
                }
            }),
        );
    }

    public provideCodeLenses(document: TextDocument, _token: CancellationToken): CodeLens[] {
        if (document.isDirty) {
            // The association is validated against the saved file (the manager refuses to validate a
            // dirty document), so only offer setup for a clean document. This also avoids anchoring the
            // lens at a stale offset if the block moved on an unsaved edit.
            return [];
        }
        const uri = document.uri;
        const metadata = this.routing.getMetadata(uri);
        if (!metadata) {
            // No saved PEP 723 metadata (or it is currently being edited).
            return [];
        }
        if (this.routing.shouldRoute(uri)) {
            // A validated inline-script environment matching the current metadata already exists.
            return [];
        }
        const offset = metadata.sourceRange?.start ?? metadata.range.start;
        const position = document.positionAt(offset);
        const range = new Range(position, position);
        return [
            new CodeLens(range, {
                title: l10n.t('Set up environment for this script'),
                command: this.setupCommand,
                arguments: [uri],
            }),
        ];
    }

    public dispose(): void {
        this.subscriptions.forEach((s) => s.dispose());
        this.subscriptions.length = 0;
        this._onDidChangeCodeLenses.dispose();
    }
}

/**
 * Register the inline-script CodeLens provider for local `.py` files. Only called when the PEP 723
 * inline-script feature flag is enabled, so it is a no-op for everyone else.
 */
export function registerInlineScriptCodeLens(routing: InlineScriptRoutingRegistry, setupCommand: string): Disposable {
    const provider = new InlineScriptCodeLensProvider(routing, setupCommand);
    const registration = languages.registerCodeLensProvider({ scheme: 'file', language: 'python' }, provider);
    return new Disposable(() => {
        registration.dispose();
        provider.dispose();
    });
}
