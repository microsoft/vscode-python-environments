import { traceVerbose } from '../../../../common/logging';
import { isWindows } from '../../../../common/utils/platformUtils';

/**
 * Checks if startup code with specified keys exists between start and end markers in the content.
 * @param content The content string to search in
 * @param start The start marker string
 * @param end The end marker string  
 * @param keys Array of strings that must all be present in the content between markers
 * @returns True if all keys are found between the markers, false otherwise
 */
export function hasStartupCode(content: string, start: string, end: string, keys: string[]): boolean {
    traceVerbose(`hasStartupCode: Checking for ${keys.length} keys between markers`);
    const normalizedContent = content.replace(/\r\n/g, '\n');
    const startIndex = normalizedContent.indexOf(start);
    const endIndex = normalizedContent.indexOf(end);
    if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
        traceVerbose(`hasStartupCode: Invalid marker positions - start: ${startIndex}, end: ${endIndex}`);
        return false;
    }
    const contentBetween = normalizedContent.substring(startIndex + start.length, endIndex).trim();
    const hasAllKeys = contentBetween.length > 0 && keys.every((key) => contentBetween.includes(key));
    traceVerbose(`hasStartupCode: Content between markers has all keys: ${hasAllKeys}`);
    return hasAllKeys;
}

/**
 * Determines the appropriate line ending style based on the content.
 * Detects existing line endings in the content and defaults to platform-specific endings if none found.
 * @param content The content string to analyze for line endings
 * @returns The line ending string to use ('\r\n' for Windows, '\n' for Unix-like systems)
 */
function getLineEndings(content: string): string {
    if (content.includes('\r\n')) {
        return '\r\n';
    } else if (content.includes('\n')) {
        return '\n';
    }
    return isWindows() ? '\r\n' : '\n';
}

/**
 * Inserts startup code between specified start and end markers in the content.
 * If markers exist, replaces content between them. If only start marker exists, adds end marker.
 * If no markers exist, appends both markers and code to the content.
 * @param content The original content string
 * @param start The start marker string
 * @param end The end marker string
 * @param code The code to insert between the markers
 * @returns The modified content string with the startup code inserted
 */
export function insertStartupCode(content: string, start: string, end: string, code: string): string {
    traceVerbose(`insertStartupCode: Inserting startup code between markers`);
    let lineEnding = getLineEndings(content);
    const normalizedContent = content.replace(/\r\n/g, '\n');

    const startIndex = normalizedContent.indexOf(start);
    const endIndex = normalizedContent.indexOf(end);

    let result: string;
    if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
        traceVerbose(`insertStartupCode: Replacing existing content between markers`);
        result =
            normalizedContent.substring(0, startIndex + start.length) +
            '\n' +
            code +
            '\n' +
            normalizedContent.substring(endIndex);
    } else if (startIndex !== -1) {
        traceVerbose(`insertStartupCode: Found start marker, adding end marker`);
        result = normalizedContent.substring(0, startIndex + start.length) + '\n' + code + '\n' + end + '\n';
    } else {
        traceVerbose(`insertStartupCode: No markers found, appending to content`);
        result = normalizedContent + '\n' + start + '\n' + code + '\n' + end + '\n';
    }

    if (lineEnding === '\r\n') {
        result = result.replace(/\n/g, '\r\n');
    }
    traceVerbose(`insertStartupCode: Successfully inserted startup code`);
    return result;
}

/**
 * Removes startup code between specified start and end markers from the content.
 * Cleanly handles line endings and whitespace to avoid leaving empty lines or malformed content.
 * @param content The original content string
 * @param start The start marker string
 * @param end The end marker string
 * @returns The modified content string with startup code removed, or original content if markers not found
 */
export function removeStartupCode(content: string, start: string, end: string): string {
    traceVerbose(`removeStartupCode: Attempting to remove startup code between markers`);
    let lineEnding = getLineEndings(content);
    const normalizedContent = content.replace(/\r\n/g, '\n');

    const startIndex = normalizedContent.indexOf(start);
    const endIndex = normalizedContent.indexOf(end);

    if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
        traceVerbose(`removeStartupCode: Found valid markers, removing content between them`);
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

        if (lineEnding === '\r\n') {
            result = result.replace(/\n/g, '\r\n');
        }
        traceVerbose(`removeStartupCode: Successfully removed startup code`);
        return result;
    }
    traceVerbose(`removeStartupCode: No valid markers found, returning original content`);
    return content;
}
