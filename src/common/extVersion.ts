import { compare as pep440Compare, explain as pep440Explain, valid as pep440Valid } from '@renovatebot/pep440';
import { PYTHON_EXTENSION_ID } from './constants';
import { getExtension } from './extension.apis';
import { traceError, traceWarn } from './logging';

export type ComparableExtensionVersion =
    | { readonly kind: 'version'; readonly version: string }
    | { readonly kind: 'not-installed' }
    | { readonly kind: 'unknown' };

export function getComparableExtensionVersion(extensionId: string): ComparableExtensionVersion {
    const extension = getExtension(extensionId);
    if (!extension) {
        return { kind: 'not-installed' };
    }
    const rawVersion = extension.packageJSON?.version;
    if (typeof rawVersion !== 'string') {
        traceWarn(`Extension ${extensionId} reported no version string; skipping version comparison.`);
        return { kind: 'unknown' };
    }
    const parsed = pep440Explain(rawVersion);
    if (!parsed) {
        traceWarn(`Extension ${extensionId} version "${rawVersion}" is not PEP 440 parseable; skipping comparison.`);
        return { kind: 'unknown' };
    }
    if (parsed.is_devrelease) {
        traceWarn(`Extension ${extensionId} version "${rawVersion}" is a dev build; skipping version comparison.`);
        return { kind: 'unknown' };
    }
    return { kind: 'version', version: rawVersion };
}

export function ensureCorrectVersion() {
    const extension = getExtension(PYTHON_EXTENSION_ID);
    if (!extension) {
        return;
    }

    const version = pep440Valid(extension.packageJSON.version);
    const minVersion = '2024.23.0';
    if (version && pep440Compare(version, minVersion) >= 0) {
        return;
    }
    traceError('Incompatible Python extension. Please update `ms-python.python` to version 2024.23 or later.');
    throw new Error('Incompatible Python extension. Please update `ms-python.python` to version 2024.23 or later.');
}
