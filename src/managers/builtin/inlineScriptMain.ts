// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Disposable, LogOutputChannel, Uri } from 'vscode';
import { EnvironmentManager, PythonEnvironmentApi } from '../../api';
import { traceInfo, traceVerbose } from '../../common/logging';
import { getPythonApi } from '../../features/pythonApi';
import { isInlineScriptsFeatureEnabled } from '../../helpers';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { InlineScriptEnvManager } from './inlineScriptEnvManager';

/**
 * Register the inline-script env manager when the internal
 * `python-envs.inlineScripts.enabled` flag is true. The flag is
 * undeclared in `package.json`, so default users see nothing.
 */
export async function registerInlineScriptFeatures(
    nativeFinder: NativePythonFinder,
    disposables: Disposable[],
    log: LogOutputChannel,
    baseManager: EnvironmentManager,
    globalStorageUri: Uri,
): Promise<void> {
    if (!isInlineScriptsFeatureEnabled()) {
        traceVerbose('Inline-script env manager: skipping registration (internal flag is off)');
        return;
    }

    const api: PythonEnvironmentApi = await getPythonApi();
    const mgr = new InlineScriptEnvManager(nativeFinder, api, baseManager, globalStorageUri, log);
    disposables.push(mgr, api.registerEnvironmentManager(mgr));
    traceInfo('Inline-script env manager: registered (internal flag is on)');
}
