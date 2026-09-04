// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as path from 'path';
import { Disposable, Event, EventEmitter, Uri } from 'vscode';
import { normalizeDependency } from './cacheKey';
import { InlineScriptMetadata } from './metadata';
import { normalizePath } from '../utils/pathUtils';
import type { InlineScriptEnvErrorCategory } from '../telemetry/constants';

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

/**
 * Outcome of the last inline-script setup attempt for a script: a `failed` reason, or a benign
 * `skipped` (an environment was built but intentionally not associated). Diagnostic side-channel —
 * not routing state — recorded by the env manager and read once by the interactive setup command.
 */
export type InlineScriptSetupOutcome =
    | {
          readonly kind: 'failed';
          readonly category: InlineScriptEnvErrorCategory;
          readonly requiresPython?: string;
      }
    | { readonly kind: 'skipped' };

interface ScriptRoutingState {
    readonly uri?: Uri;
    readonly metadata?: InlineScriptMetadata;
    readonly metadataIdentity?: string;
    readonly metadataRevision: number;
    readonly validatedAssociation: boolean;
}

export class InlineScriptRoutingRegistry implements Disposable {
    private readonly states = new Map<string, ScriptRoutingState>();
    private readonly metadataRevisions = new Map<string, number>();
    private readonly setupOutcomes = new Map<string, InlineScriptSetupOutcome>();
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
        const metadataRevision = this.nextMetadataRevision(scriptPath);
        this.update(
            scriptPath,
            (state) => {
                return {
                    ...state,
                    uri,
                    metadata,
                    metadataIdentity,
                    metadataRevision,
                    validatedAssociation:
                        state.metadataIdentity === metadataIdentity ? state.validatedAssociation : false,
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
        const metadataRevision = this.nextMetadataRevision(scriptPath);
        this.update(
            scriptPath,
            (state) => {
                return {
                    ...state,
                    uri,
                    metadata: undefined,
                    metadataIdentity: undefined,
                    metadataRevision,
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
        return scriptPath ? (this.metadataRevisions.get(scriptPath) ?? 0) : 0;
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

    public noteSetupOutcome(script: Uri | string, outcome: InlineScriptSetupOutcome): void {
        const scriptPath = getInlineScriptRoutingKey(script);
        if (scriptPath) {
            this.setupOutcomes.set(scriptPath, outcome);
        }
    }

    public clearSetupOutcome(script: Uri | string): void {
        const scriptPath = getInlineScriptRoutingKey(script);
        if (scriptPath) {
            this.setupOutcomes.delete(scriptPath);
        }
    }

    public takeSetupOutcome(script: Uri | string): InlineScriptSetupOutcome | undefined {
        const scriptPath = getInlineScriptRoutingKey(script);
        if (!scriptPath) {
            return undefined;
        }
        const outcome = this.setupOutcomes.get(scriptPath);
        this.setupOutcomes.delete(scriptPath);
        return outcome;
    }

    public shouldRoute(uri: Uri): boolean {
        const scriptPath = getInlineScriptRoutingKey(uri);
        return scriptPath ? this.isRouteable(this.states.get(scriptPath)) : false;
    }

    public dispose(): void {
        this.states.clear();
        this.metadataRevisions.clear();
        this.setupOutcomes.clear();
        this._onDidChangeMetadata.dispose();
        this._onDidChangeRouteability.dispose();
    }

    private update(
        scriptPath: string,
        updater: (state: ScriptRoutingState) => ScriptRoutingState,
        fireMetadataChange: boolean = false,
    ): void {
        const previous = this.states.get(scriptPath) ?? {
            metadataRevision: this.metadataRevisions.get(scriptPath) ?? 0,
            validatedAssociation: false,
        };
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

    private nextMetadataRevision(scriptPath: string): number {
        const revision = (this.metadataRevisions.get(scriptPath) ?? 0) + 1;
        this.metadataRevisions.set(scriptPath, revision);
        return revision;
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
