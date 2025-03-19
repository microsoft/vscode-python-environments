/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {
    // https://github.com/microsoft/vscode/issues/230165

    // Part of TerminalState since the shellType can change multiple times and this comes with an event.
    export interface TerminalState {
        /**
         * The detected shell type of the {@link Terminal}. This will be `undefined` when there is
         * not a clear signal as to what the shell is, or the shell is not supported yet. This
         * value should change to the shell type of a sub-shell when launched (for example, running
         * `bash` inside `zsh`).
         *
         * Note that the possible values are currently defined as any of the following:
         * 'bash', 'cmd', 'csh', 'fish', 'gitbash', 'julia', 'ksh', 'node', 'nu', 'pwsh', 'python',
         * 'sh', 'wsl', 'zsh'.
         */
        readonly shell: string | undefined;
    }
}
