export function isWindows(): boolean {
    return process.platform === 'win32';
}

export function isMac(): boolean {
    return process.platform === 'darwin';
}
