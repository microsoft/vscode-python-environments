import { compare as pep440Compare, valid as pep440Valid } from '@renovatebot/pep440';
import { PYTHON_EXTENSION_ID } from './constants';
import { getExtension } from './extension.apis';
import { traceError } from './logging';

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
