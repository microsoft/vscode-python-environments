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
import { findInlineScriptBlock } from '../../common/inlineScript/block';
import { getInlineScriptSourceHash, sliceHeaderBytes } from '../../common/inlineScript/metadata';
import { getInlineScriptRoutingKey, InlineScriptRoutingRegistry } from '../../common/inlineScript/routingRegistry';
import { InlineScriptStrings } from '../../common/localize';
import { shortenVersionString } from '../../managers/common/utils';

/**
 * Keep a CodeLens above the live inline block, including malformed or unsaved metadata.
 * Only an unchanged block backed by a validated environment displays the persistent ready label.
 * Text detection and hashing do not parse TOML or change saved-metadata routing.
 */
export class InlineScriptCodeLensProvider implements CodeLensProvider, Disposable {
    private readonly _onDidChangeCodeLenses = new EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
    private readonly subscriptions: Disposable[] = [];
    private disposed = false;

    constructor(
        private readonly routing: InlineScriptRoutingRegistry,
        private readonly setupCommand: string,
    ) {
        this.subscriptions.push(
            this.routing.onDidChangeRouteability(() => this._onDidChangeCodeLenses.fire()),
            this.routing.onDidChangeAvailability(() => this._onDidChangeCodeLenses.fire()),
            this.routing.onDidChangeEnvironmentVersion(() => this._onDidChangeCodeLenses.fire()),
            this.routing.onDidChangeMetadata((e) => {
                if (e.metadata !== undefined) {
                    this._onDidChangeCodeLenses.fire();
                }
            }),
        );
    }

    public provideCodeLenses(document: TextDocument, _token: CancellationToken): CodeLens[] {
        const uri = document.uri;
        if (this.disposed || !getInlineScriptRoutingKey(uri)) {
            return [];
        }
        const header = sliceHeaderBytes(document.getText());
        const block = findInlineScriptBlock(header);
        if (!block) {
            return [];
        }
        const position = document.positionAt(block.start);
        const range = new Range(position, position);
        const savedHash = this.routing.getMetadata(uri)?.sourceHash;
        if (
            this.routing.shouldRoute(uri) &&
            !this.routing.isEnvironmentUnavailable(uri) &&
            savedHash !== undefined &&
            savedHash === getInlineScriptSourceHash(header)
        ) {
            const version = this.routing.getEnvironmentVersion(uri);
            // An empty command id renders the title as plain, non-clickable text.
            return [
                new CodeLens(range, {
                    title: InlineScriptStrings.environmentReady(version ? shortenVersionString(version) : undefined),
                    command: '',
                }),
            ];
        }
        return [
            new CodeLens(range, {
                title: l10n.t('Set up environment for this script'),
                command: this.setupCommand,
                arguments: [uri],
            }),
        ];
    }

    public dispose(): void {
        this.disposed = true;
        this.subscriptions.forEach((s) => s.dispose());
        this.subscriptions.length = 0;
        this._onDidChangeCodeLenses.dispose();
    }
}

/**
 * Register the inline-script CodeLens provider for local `.py` files. Only called when the PEP 723
 * inline-script feature flag is enabled, so it is a no-op for everyone else.
 */
export function registerInlineScriptCodeLens(
    routing: InlineScriptRoutingRegistry,
    setupCommand: string,
): { readonly disposable: Disposable; readonly provider: InlineScriptCodeLensProvider } {
    const provider = new InlineScriptCodeLensProvider(routing, setupCommand);
    const registration = languages.registerCodeLensProvider({ scheme: 'file', language: 'python' }, provider);
    return {
        provider,
        disposable: new Disposable(() => {
            registration.dispose();
            provider.dispose();
        }),
    };
}
