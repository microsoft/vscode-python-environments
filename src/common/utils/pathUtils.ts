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
