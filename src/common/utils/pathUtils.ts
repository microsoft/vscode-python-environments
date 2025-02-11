import * as os from 'os';
import { isWindows } from './platformUtils';

export function normalizePath(path: string): string {
    const path1 = path.replace(/\\/g, '/');
    if (isWindows()) {
        return path1.toLowerCase();
    }
    return path1;
}

export function untildify(path: string): string {
    return path.replace(/^~($|\/|\\)/, `${os.homedir()}$1`);
}

export function getUserHomeDir(): string {
    return os.homedir();
}
