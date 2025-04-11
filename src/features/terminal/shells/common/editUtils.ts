export function hasStartupCode(content: string, start: string, end: string, keys: string[]): boolean {
    // Normalize line endings to \n
    const normalizedContent = content.replace(/\r\n/g, '\n');
    const startIndex = normalizedContent.indexOf(start);
    const endIndex = normalizedContent.indexOf(end);
    if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
        return false;
    }
    const contentBetween = normalizedContent.substring(startIndex + start.length, endIndex).trim();
    return contentBetween.length > 0 && keys.every((key) => contentBetween.includes(key));
}

export function insertStartupCode(content: string, start: string, end: string, code: string): string {
    // Detect line ending style from content (default to \n if cannot determine)
    const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';

    // Normalize line endings to \n for processing
    const normalizedContent = content.replace(/\r\n/g, '\n');
    const startIndex = normalizedContent.indexOf(start);
    const endIndex = normalizedContent.indexOf(end);

    let result: string;
    if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
        // Both markers exist in correct order
        result =
            normalizedContent.substring(0, startIndex + start.length) +
            '\n' +
            code +
            '\n' +
            normalizedContent.substring(endIndex);
    } else if (startIndex !== -1) {
        // Only start marker exists - truncate everything after the start marker
        result = normalizedContent.substring(0, startIndex + start.length) + '\n' + code + '\n' + end + '\n';
    } else {
        // No markers or only end marker exists
        result = normalizedContent + '\n' + start + '\n' + code + '\n' + end + '\n';
    }

    // Restore original line ending style
    if (lineEnding === '\r\n') {
        result = result.replace(/\n/g, '\r\n');
    }
    return result;
}

export function removeStartupCode(content: string, start: string, end: string): string {
    // Detect line ending style from content (default to \n if cannot determine)
    const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';

    // Normalize line endings to \n for processing
    const normalizedContent = content.replace(/\r\n/g, '\n');
    const startIndex = normalizedContent.indexOf(start);
    const endIndex = normalizedContent.indexOf(end);

    if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
        const before = normalizedContent.substring(0, startIndex);
        const after = normalizedContent.substring(endIndex + end.length);

        let result: string;
        if (before === '') {
            result = after.startsWith('\n') ? after.substring(1) : after;
        } else if (after === '' || after === '\n') {
            result = before.endsWith('\n') ? before.substring(0, before.length - 1) : before;
        } else if (after.startsWith('\n') && before.endsWith('\n')) {
            result = before + after.substring(1);
        } else {
            result = before + after;
        }

        // Restore original line ending style
        if (lineEnding === '\r\n') {
            result = result.replace(/\n/g, '\r\n');
        }
        return result;
    }
    return content;
}
