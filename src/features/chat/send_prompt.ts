// // export async function sendPrompt() {
// //     const token: CancellationToken = new CancellationTokenSource().token;

import { commands, extensions, l10n, ProgressLocation, ProgressOptions, window } from 'vscode';

// import {
//     CancellationToken,
//     ChatContext,
//     ChatRequest,
//     ChatRequestHandler,
//     ChatResponseStream,
//     LanguageModelChatMessage,
// } from 'vscode';

// //     const request: ChatRequest = {
// //         prompt: 'What is the weather like today?',
// //         command: undefined,
// //         references: [],
// //         toolReferences: [],
// //         toolInvocationToken: [],
// //         model: undefined,
// //     };

// //     const chatContext: ChatContext = {
// //         history: [],
// //     };

// //     const prompt: PromptElementAndProps<PythonEnvsPrompt> = {
// //         promptElement: PythonEnvsPrompt,
// //     };

// //     const stream: ChatResponseStream = {};

// //     const { result } = sendChatParticipantRequest(
// //         request,
// //         chatContext,
// //         {
// //             prompt,
// //             requestJustification: l10n.t('Tell me about my environment.'),
// //             responseStreamOptions: {
// //                 stream,
// //                 references: false,
// //                 responseText: true,
// //             },
// //         },
// //         token,
// //     );

// //     return await result;
// // }

// // export async function sendPrompt2() {
// //     // send the request
// //     const chatResponse = await request.model.sendRequest(messages, {}, token);

// //     // stream the response
// //     for await (const fragment of chatResponse.text) {
// //         stream.markdown(fragment);
// //     }
// // }

// const BASE_PROMPT =
//     'You are a helpful code tutor. Your job is to teach the user with simple descriptions and sample code of the concept. Respond with a guided overview of the concept in a series of messages. Do not give the user the answer directly, but guide them to find the answer themselves. If the user asks a non-programming question, politely decline to respond.';

// // define a chat handler
// const handler: ChatRequestHandler = async (
//     request: ChatRequest,
//     context: ChatContext,
//     stream: ChatResponseStream,
//     token: CancellationToken,
// ) => {
//     // initialize the prompt
//     let prompt = BASE_PROMPT;

//     // initialize the messages array with the prompt
//     const messages = [LanguageModelChatMessage.User(prompt)];

//     // add in the user's message
//     messages.push(LanguageModelChatMessage.User(request.prompt));

//     // send the request
//     const chatResponse = await request.model.sendRequest(messages, {}, token);

//     // stream the response
//     for await (const fragment of chatResponse.text) {
//         stream.markdown(fragment);
//     }

//     return;
// };

const COPILOT_CHAT_EXTENSION_ID = 'github.copilot-chat';

function isCopilotChatInstalled(): boolean {
    return !!extensions.getExtension(COPILOT_CHAT_EXTENSION_ID);
}
export async function sendPromptIfCopilotChatInstalled(prompt: string): Promise<void> {
    const sendPrompt = async () => {
        // Artificial delay to work around
        // https://github.com/microsoft/vscode-copilot/issues/16541
        const progressOptions: ProgressOptions = {
            location: ProgressLocation.Notification,
            title: l10n.t('Analyzing your python environment extension logs...'),
            cancellable: false,
        };
        await window.withProgress(progressOptions, async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
        });
        const abc = await commands.executeCommand('workbench.action.chat.open', {
            query: prompt,
            mode: 'agent',
        });
        if (abc) {
            console.log('Chat opened successfully');
        }
    };
    // If the user has Copilot Chat installed, assume they are
    // logged in and can receive the 'sendToNewChat' command
    if (isCopilotChatInstalled()) {
        await sendPrompt();
        return;
    }
}

export interface ChatEnvironmentErrorInfo {
    errorMessage: string;
    stackTrace: string;
    attemptedPackages: string[];
    packageManager: string;
    environment: {
        displayName: string;
        environmentPath: string;
        version: string;
    };
    packagesBeforeInstall: string[];
    tools: string[];
}

export class PythonEnvErrorQueue {
    private errorQueue: ChatEnvironmentErrorInfo[] = [];

    /**
     * Add a new error to the queue
     * @param error The error information to add
     */
    public push(error: ChatEnvironmentErrorInfo): void {
        this.errorQueue.push(error);
    }

    /**
     * Remove and return the oldest error from the queue
     * @returns The oldest error or undefined if queue is empty
     */
    public pop(): ChatEnvironmentErrorInfo | undefined {
        return this.errorQueue.shift();
    }

    /**
     * View the next error without removing it
     * @returns The oldest error or undefined if queue is empty
     */
    public peek(): ChatEnvironmentErrorInfo | undefined {
        return this.errorQueue[0];
    }

    /**
     * Get the current number of errors in the queue
     * @returns The number of errors in the queue
     */
    public size(): number {
        return this.errorQueue.length;
    }

    /**
     * Check if the queue is empty
     * @returns true if the queue has no errors, false otherwise
     */
    public isEmpty(): boolean {
        return this.errorQueue.length === 0;
    }

    /**
     * Clear all errors from the queue
     */
    public clear(): void {
        this.errorQueue = [];
    }

    /**
     * Get all errors currently in the queue without removing them
     * @returns Array of all errors in the queue
     */
    public getAll(): ChatEnvironmentErrorInfo[] {
        return [...this.errorQueue];
    }
}

export const ERROR_CHAT_CONTEXT_QUEUE = new PythonEnvErrorQueue();
