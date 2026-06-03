import { PYTHON_EXTENSION_ID } from './constants';
import { getExtension } from './extension.apis';
import { traceError } from './logging';
import { PEP440Version } from './utils/pep440Version';

export function ensureCorrectVersion() {
    const extension = getExtension(PYTHON_EXTENSION_ID);
    if (!extension) {
        return;
    }

    const version = PEP440Version.parse(extension.packageJSON.version);
    const minVersion = PEP440Version.parse('2024.23.0');
    if (version && minVersion && PEP440Version.compare(version, minVersion) >= 0) {
        return;
    }
    traceError('Incompatible Python extension. Please update `ms-python.python` to version 2024.23 or later.');
    throw new Error('Incompatible Python extension. Please update `ms-python.python` to version 2024.23 or later.');
}
