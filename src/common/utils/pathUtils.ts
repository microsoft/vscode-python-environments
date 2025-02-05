import * as path from 'path';

export function areSamePaths(a: string, b: string): boolean {
    return path.resolve(a) === path.resolve(b);
}

export function isParentPath(parent: string, child: string): boolean {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
