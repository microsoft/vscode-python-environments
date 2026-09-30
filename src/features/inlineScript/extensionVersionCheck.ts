// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { compare as pep440Compare } from '@renovatebot/pep440';
import { PYLANCE_EXTENSION_ID, PYTHON_EXTENSION_ID } from '../../common/constants';
import { getComparableExtensionVersion } from '../../common/extVersion';
import { Common, InlineScriptStrings } from '../../common/localize';
import { traceInfo, traceVerbose } from '../../common/logging';
import { getGlobalPersistentState } from '../../common/persistentState';
import { showWarningMessage } from '../../common/window.apis';
import { openExtension } from '../../common/workbenchCommands';
import { getConfiguration } from '../../common/workspace.apis';

export const INLINE_SCRIPT_UPDATE_EXTENSIONS_DONT_SHOW_KEY = 'python-envs:inline-script:UPDATE_EXTENSIONS_DONT_SHOW';

interface CompanionExtension {
    readonly id: string;
    /** Newest version on each channel that still LACKS the required change; anything newer is fine. */
    readonly lastUnsupportedStable: string;
    readonly lastUnsupportedPreRelease: string;
    /** Patch component at or above which a version is a pre-release build. */
    readonly preReleasePatchFloor: number;
}

/**
 * Python needs per-file interpreter resolution (`exactResource`, PR #26129, merged 2026-08-31);
 * Pylance needs the `python/didChangeFilePythonPath` notification (PR #9302, merged 2026-09-01).
 */
const PYTHON_COMPANION: CompanionExtension = {
    id: PYTHON_EXTENSION_ID,
    lastUnsupportedStable: '2026.4.0',
    lastUnsupportedPreRelease: '2026.7.2026082601',
    preReleasePatchFloor: 1_000_000,
};

const PYLANCE_COMPANION: CompanionExtension = {
    id: PYLANCE_EXTENSION_ID,
    lastUnsupportedStable: '2026.3.1',
    lastUnsupportedPreRelease: '2026.3.101',
    preReleasePatchFloor: 100,
};

let promptShownThisSession = false;

export function resetInlineScriptExtensionPromptForTests(): void {
    promptShownThisSession = false;
}

function isPylanceInUse(): boolean {
    const languageServer = getConfiguration('python').get<string>('languageServer', 'Default');
    return languageServer === 'Default' || languageServer === 'Pylance';
}

function isPreReleaseBuild(version: string, preReleasePatchFloor: number): boolean {
    const patch = Number((version.split('.')[2] ?? '').replace(/\D.*$/, ''));
    return Number.isFinite(patch) && patch >= preReleasePatchFloor;
}

function isOutdated(extension: CompanionExtension): boolean {
    const resolved = getComparableExtensionVersion(extension.id);
    if (resolved.kind !== 'version') {
        traceVerbose(`inline-script companion check: ${extension.id} -> ${resolved.kind}`);
        return false;
    }
    const lastUnsupported = isPreReleaseBuild(resolved.version, extension.preReleasePatchFloor)
        ? extension.lastUnsupportedPreRelease
        : extension.lastUnsupportedStable;
    const outdated = pep440Compare(resolved.version, lastUnsupported) <= 0;
    if (outdated) {
        traceVerbose(`inline-script companion check: ${extension.id} ${resolved.version} <= ${lastUnsupported}`);
    }
    return outdated;
}

export function getOutdatedInlineScriptExtensions(): CompanionExtension[] {
    const candidates = isPylanceInUse() ? [PYTHON_COMPANION, PYLANCE_COMPANION] : [PYTHON_COMPANION];
    return candidates.filter(isOutdated);
}

function getOutdatedMessage(outdated: readonly CompanionExtension[]): string {
    const hasPython = outdated.some((extension) => extension.id === PYTHON_EXTENSION_ID);
    const hasPylance = outdated.some((extension) => extension.id === PYLANCE_EXTENSION_ID);
    if (hasPython && hasPylance) {
        return InlineScriptStrings.updatePythonAndPylanceExtensions;
    }
    return hasPython ? InlineScriptStrings.updatePythonExtension : InlineScriptStrings.updatePylanceExtension;
}

export async function promptUpdateExtensionsForInlineScripts(): Promise<void> {
    if (promptShownThisSession) {
        return;
    }

    const outdated = getOutdatedInlineScriptExtensions();
    if (outdated.length === 0) {
        return;
    }

    // Latched here, not on entry, so an up-to-date run does not consume the session's one prompt.
    promptShownThisSession = true;

    const state = await getGlobalPersistentState();
    if (await state.get<boolean>(INLINE_SCRIPT_UPDATE_EXTENSIONS_DONT_SHOW_KEY)) {
        traceInfo('Skipping inline-script companion extension prompt: user selected "Don\'t Show Again".');
        return;
    }

    const names = outdated.map((extension) => extension.id).join(', ');
    traceInfo(`Inline-script companion extensions out of date: ${names}`);

    const result = await showWarningMessage(
        getOutdatedMessage(outdated),
        InlineScriptStrings.updateExtension,
        Common.dontShowAgain,
    );

    if (result === InlineScriptStrings.updateExtension) {
        await openExtension(outdated[0].id);
    } else if (result === Common.dontShowAgain) {
        await state.set(INLINE_SCRIPT_UPDATE_EXTENSIONS_DONT_SHOW_KEY, true);
        traceInfo('User selected "Don\'t Show Again" for the inline-script companion extension prompt.');
    }
}
