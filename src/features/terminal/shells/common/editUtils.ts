export function hasStartupCode(content: string, start: string, end: string, keys: string[]): boolean {
    const startIndex = content.indexOf(start);
    const endIndex = content.indexOf(end);
    if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
        return false;
    }
    const contentBetween = content.substring(startIndex + start.length, endIndex).trim();
    return contentBetween.length > 0 && keys.every((key) => contentBetween.includes(key));
}

export function insertStartupCode(content: string, start: string, end: string, code: string): string {
    const startIndex = content.indexOf(start);
    const endIndex = content.indexOf(end);

    if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
        return content.substring(0, startIndex + start.length) + '\n\n' + code + '\n\n' + content.substring(endIndex);
    } else {
        return content + '\n' + start + '\n\n' + code + '\n\n' + end + '\n';
    }
}

export function removeStartupCode(content: string, start: string, end: string): string {
    const startIndex = content.indexOf(start);
    const endIndex = content.indexOf(end);

    if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
        const before = content.substring(0, startIndex + start.length);
        const after = content.substring(endIndex);
        return before.trimEnd() + after;
    }
    return content;
}
