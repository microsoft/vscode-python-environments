// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Disposable, LogOutputChannel, Memento, Uri } from 'vscode';
import { EnvironmentManager, PythonEnvironmentApi } from '../../../api';
import { InlineScriptRoutingRegistry } from '../../../common/inlineScript/routingRegistry';
import { traceInfo } from '../../../common/logging';
import { getPythonApi } from '../../../extensionApi';
import { NativePythonFinder } from '../../common/nativePythonFinder';
import { InlineScriptEnvManager } from './envManager';

export interface PreparedInlineScriptFeatures {
    readonly manager: InlineScriptEnvManager;
    registerManager(): Disposable;
}

/**
 * Prepares an inert inline-script manager for publication after the rest of the feature is ready.
 */
export async function prepareInlineScriptFeatures(
    nativeFinder: NativePythonFinder,
    disposables: Disposable[],
    log: LogOutputChannel,
    baseManager: EnvironmentManager,
    globalStorageUri: Uri,
    routingRegistry: InlineScriptRoutingRegistry,
    workspaceState: Memento,
): Promise<PreparedInlineScriptFeatures> {
    const api: PythonEnvironmentApi = await getPythonApi();
    const mgr = new InlineScriptEnvManager(
        nativeFinder,
        api,
        baseManager,
        globalStorageUri,
        log,
        workspaceState,
        routingRegistry,
        true,
    );
    disposables.push(mgr);
    return {
        manager: mgr,
        registerManager: () => {
            const registration = api.registerEnvironmentManager(mgr);
            traceInfo('Inline-script env manager: registered');
            return registration;
        },
    };
}

/**
 * Starts restored-association discovery after the complete feature registration commits.
 */
export function scheduleInlineScriptActivationDiscovery(manager: InlineScriptEnvManager): Disposable {
    const handle = setImmediate(() => manager.startActivationDiscovery());
    return new Disposable(() => clearImmediate(handle));
}
