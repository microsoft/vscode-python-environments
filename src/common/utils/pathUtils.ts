import * as path from 'path';
import * as os from 'os';
import { Uri } from 'vscode';
import { isWindows } from './platformUtils';

export function checkUri(scope?: Uri | Uri[] | string): Uri | Uri[] | string | undefined {
    if (scope instanceof Uri) {
        if (scope.scheme === 'vscode-notebook-cell') {
            return Uri.from({
                scheme: 'vscode-notebook',
                path: scope.path,
                authority: scope.authority,
            });
        }
    }
    if (Array.isArray(scope)) {
        return scope.map((item) => {
            return checkUri(item) as Uri;
        });
    }
    return scope;
}

export function normalizePath(fsPath: string): string {
    const path1 = fsPath.replace(/\\/g, '/');
    if (isWindows()) {
        return path1.toLowerCase();
    }
    return path1;
}

export function getResourceUri(resourcePath: string, root?: string): Uri | undefined {
    try {
        if (!resourcePath) {
            return undefined;
        }

        const normalizedPath = normalizePath(resourcePath);
        if (normalizedPath.includes('://')) {
            return Uri.parse(normalizedPath);
        }

        if (!path.isAbsolute(resourcePath) && root) {
            const absolutePath = path.resolve(root, resourcePath);
            return Uri.file(absolutePath);
        }
        return Uri.file(resourcePath);
    } catch (_err) {
        return undefined;
    }
}

export function untildify(path: string): string {
    return path.replace(/^~($|\/|\\)/, `${os.homedir()}$1`);
}

export function getUserHomeDir(): string {
    return os.homedir();
}
