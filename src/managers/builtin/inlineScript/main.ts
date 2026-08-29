// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Disposable, LogOutputChannel, Memento, Uri } from 'vscode';
import { EnvironmentManager, PythonEnvironmentApi } from '../../../api';
import { traceInfo, traceVerbose } from '../../../common/logging';
import { InlineScriptFeatureActivation } from '../../../features/inlineScript/activation';
import { getPythonApi } from '../../../features/pythonApi';
import { NativePythonFinder } from '../../common/nativePythonFinder';
import { InlineScriptEnvManager } from './envManager';

/**
 * Register the inline-script env manager when the activation-latched
 * `python-envs.inlineScripts.enabled` flag is true.
 */
export async function registerInlineScriptFeatures(
    nativeFinder: NativePythonFinder,
    disposables: Disposable[],
    log: LogOutputChannel,
    baseManager: EnvironmentManager,
    globalStorageUri: Uri,
    activation: InlineScriptFeatureActivation,
    workspaceState: Memento,
): Promise<void> {
    if (!activation.enabled) {
        traceVerbose('Inline-script env manager: skipping registration (internal flag is off)');
        return;
    }
    const { routingRegistry } = activation;
    if (!routingRegistry) {
        throw new Error('Inline-script env manager requires a routing registry when the feature flag is on');
    }

    const api: PythonEnvironmentApi = await getPythonApi();
    const mgr = new InlineScriptEnvManager(
        nativeFinder,
        api,
        baseManager,
        globalStorageUri,
        log,
        workspaceState,
        routingRegistry,
    );
    disposables.push(mgr, api.registerEnvironmentManager(mgr));
    setImmediate(() => mgr.startActivationDiscovery());
    traceInfo('Inline-script env manager: registered (internal flag is on)');
}
