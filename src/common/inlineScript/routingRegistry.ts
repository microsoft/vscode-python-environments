// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as path from 'path';
import { Disposable, Event, EventEmitter, Uri } from 'vscode';
import { normalizeDependency } from './cacheKey';
import { InlineScriptMetadata } from './metadata';
import { normalizePath } from '../utils/pathUtils';

export interface InlineScriptRouteabilityChangeEvent {
    readonly uri: Uri;
    readonly previousRouteable: boolean;
    readonly routeable: boolean;
}

export interface InlineScriptMetadataChangeEvent {
    readonly uri: Uri;
    readonly metadata: InlineScriptMetadata | undefined;
    readonly metadataIdentity: string | undefined;
    readonly metadataRevision: number;
}

interface ScriptRoutingState {
    readonly uri?: Uri;
    readonly metadata?: InlineScriptMetadata;
    readonly metadataIdentity?: string;
    readonly metadataRevision: number;
    readonly validatedAssociation: boolean;
}

export class InlineScriptRoutingRegistry implements Disposable {
    private readonly states = new Map<string, ScriptRoutingState>();
    private readonly _onDidChangeRouteability = new EventEmitter<InlineScriptRouteabilityChangeEvent>();
    private readonly _onDidChangeMetadata = new EventEmitter<InlineScriptMetadataChangeEvent>();

    public readonly onDidChangeRouteability: Event<InlineScriptRouteabilityChangeEvent> =
        this._onDidChangeRouteability.event;

    public readonly onDidChangeMetadata: Event<InlineScriptMetadataChangeEvent> = this._onDidChangeMetadata.event;

    public setMetadata(uri: Uri, metadata: InlineScriptMetadata | undefined): void {
        const scriptPath = getInlineScriptRoutingKey(uri);
        if (!scriptPath) {
            return;
        }
        const metadataIdentity = getInlineScriptMetadataRoutingIdentity(metadata);
        this.update(
            scriptPath,
            (state) => {
                const currentRevision = state?.metadataRevision ?? 0;
                return {
                    ...state,
                    uri,
                    metadata,
                    metadataIdentity,
                    metadataRevision: currentRevision + 1,
                };
            },
            true,
        );
    }

    public clearMetadata(uri: Uri): void {
        const scriptPath = getInlineScriptRoutingKey(uri);
        if (!scriptPath) {
            return;
        }
        this.update(
            scriptPath,
            (state) => {
                const currentRevision = state?.metadataRevision ?? 0;
                return {
                    ...state,
                    uri,
                    metadata: undefined,
                    metadataIdentity: undefined,
                    metadataRevision: currentRevision + 1,
                };
            },
            true,
        );
    }

    public getMetadata(script: Uri | string): InlineScriptMetadata | undefined {
        const scriptPath = getInlineScriptRoutingKey(script);
        return scriptPath ? this.states.get(scriptPath)?.metadata : undefined;
    }

    public getMetadataIdentity(script: Uri | string): string | undefined {
        const scriptPath = getInlineScriptRoutingKey(script);
        return scriptPath ? this.states.get(scriptPath)?.metadataIdentity : undefined;
    }

    public getMetadataRevision(script: Uri | string): number {
        const scriptPath = getInlineScriptRoutingKey(script);
        return scriptPath ? (this.states.get(scriptPath)?.metadataRevision ?? 0) : 0;
    }

    public getUri(script: Uri | string): Uri | undefined {
        const scriptPath = getInlineScriptRoutingKey(script);
        return scriptPath ? this.states.get(scriptPath)?.uri : undefined;
    }

    public setValidatedAssociation(script: Uri | string, validatedAssociation: boolean): void {
        const scriptPath = getInlineScriptRoutingKey(script);
        if (!scriptPath) {
            return;
        }
        this.update(scriptPath, (state) => ({
            ...state,
            uri: script instanceof Uri ? script : state.uri,
            validatedAssociation,
        }));
    }

    public hasValidatedAssociation(script: Uri | string): boolean {
        const scriptPath = getInlineScriptRoutingKey(script);
        return scriptPath ? this.states.get(scriptPath)?.validatedAssociation === true : false;
    }

    public shouldRoute(uri: Uri): boolean {
        const scriptPath = getInlineScriptRoutingKey(uri);
        return scriptPath ? this.isRouteable(this.states.get(scriptPath)) : false;
    }

    public dispose(): void {
        this.states.clear();
        this._onDidChangeMetadata.dispose();
        this._onDidChangeRouteability.dispose();
    }

    private update(
        scriptPath: string,
        updater: (state: ScriptRoutingState) => ScriptRoutingState,
        fireMetadataChange: boolean = false,
    ): void {
        const previous = this.states.get(scriptPath) ?? { metadataRevision: 0, validatedAssociation: false };
        const previousRouteable = this.isRouteable(previous);
        const next = updater(previous);

        if (!next.metadata && !next.validatedAssociation) {
            this.states.delete(scriptPath);
        } else {
            this.states.set(scriptPath, next);
        }

        if (fireMetadataChange && next.uri) {
            this._onDidChangeMetadata.fire({
                uri: next.uri,
                metadata: next.metadata,
                metadataIdentity: next.metadataIdentity,
                metadataRevision: next.metadataRevision,
            });
        }

        const routeable = this.isRouteable(next);
        if (previousRouteable !== routeable && next.uri) {
            this._onDidChangeRouteability.fire({
                uri: next.uri,
                previousRouteable,
                routeable,
            });
        }
    }

    private isRouteable(state: ScriptRoutingState | undefined): boolean {
        return !!state?.metadata && state.validatedAssociation;
    }
}

export function getInlineScriptRoutingKey(script: Uri | string): string | undefined {
    if (typeof script === 'string') {
        return normalizePath(script);
    }
    if (script.scheme !== 'file') {
        return undefined;
    }
    if (path.extname(script.fsPath).toLowerCase() !== '.py') {
        return undefined;
    }
    return normalizePath(script.fsPath);
}

export function getInlineScriptMetadataRoutingIdentity(metadata: InlineScriptMetadata | undefined): string | undefined {
    if (!metadata) {
        return undefined;
    }
    const normalizedDependencies = Array.from(
        new Set((metadata.dependencies ?? []).map((dependency) => normalizeDependency(dependency)).filter(Boolean)),
    ).sort();
    return JSON.stringify({
        requiresPython: metadata.requiresPython?.trim() ?? '',
        dependencies: normalizedDependencies,
    });
}
