// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

export interface InlineScriptBlock {
    readonly start: number;
    readonly end: number;
}

/**
 * Locate the first recognizable script opener and its next closing marker, without validation.
 * Incomplete blocks are included so editor actions remain available while typing.
 * This approximate presentation range must not be used for metadata validation or fingerprints.
 */
export function findInlineScriptBlock(text: string): InlineScriptBlock | undefined {
    const opener = /^[\t \uFEFF]*#[\t ]*\/\/\/[\t ]+script\b[^\r\n]*/gm.exec(text);
    if (!opener) {
        return undefined;
    }
    const closerPattern = /^[\t ]*#[\t ]*\/\/\/[\t ]*$/gm;
    closerPattern.lastIndex = opener.index + opener[0].length;
    const closer = closerPattern.exec(text);
    return {
        start: opener.index + (opener.index === 0 && text.startsWith('\uFEFF') ? 1 : 0),
        end: closer ? closer.index + closer[0].length : text.length,
    };
}
