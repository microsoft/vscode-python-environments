// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Disposable, Event, EventEmitter } from 'vscode';
import { traceInfo } from '../../common/logging';
import { onDidChangeConfiguration } from '../../common/workspace.apis';
import { getUserConfiguredSetting, isInlineScriptsFeatureEnabled } from '../../helpers';

const INLINE_SCRIPTS_SETTING = 'python-envs.inlineScripts.enabled';

export interface InlineScriptFeatureActivation extends Disposable {
    readonly activationRequested: boolean;
    readonly onDidRequestActivation: Event<void>;
}

/**
 * Requests inline-script activation from an explicit startup value or from a late
 * experimental default. Explicit setting changes still require a window reload.
 */
export function createInlineScriptFeatureActivation(): InlineScriptFeatureActivation {
    return new InlineScriptFeatureActivationImpl();
}

class InlineScriptFeatureActivationImpl implements InlineScriptFeatureActivation {
    private readonly activationEmitter = new EventEmitter<void>();
    private configurationSubscription: Disposable | undefined;
    private requested = false;

    public readonly onDidRequestActivation = this.activationEmitter.event;

    constructor() {
        const explicitValue = getUserConfiguredSetting<boolean>('python-envs', 'inlineScripts.enabled');
        if (explicitValue !== undefined) {
            if (explicitValue) {
                this.requestActivation();
            }
            return;
        }

        // Rollout bridge: remove this listener when the inline-script experiment gate is retired.
        // Subscribe before re-reading so a late VS Code experimental default cannot be missed.
        this.configurationSubscription = onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(INLINE_SCRIPTS_SETTING)) {
                this.handleDefaultChange();
            }
        });
        this.handleDefaultChange();
    }

    public get activationRequested(): boolean {
        return this.requested;
    }

    private handleDefaultChange(): void {
        if (getUserConfiguredSetting<boolean>('python-envs', 'inlineScripts.enabled') !== undefined) {
            this.stopWatching();
            return;
        }
        if (isInlineScriptsFeatureEnabled()) {
            traceInfo('PEP 723 inline-script activation requested by the effective default setting.');
            this.requestActivation();
        }
    }

    private requestActivation(): void {
        if (this.requested) {
            return;
        }
        this.requested = true;
        this.stopWatching();
        this.activationEmitter.fire();
    }

    private stopWatching(): void {
        this.configurationSubscription?.dispose();
        this.configurationSubscription = undefined;
    }

    public dispose(): void {
        this.stopWatching();
        this.activationEmitter.dispose();
    }
}
