import { traceInfo, traceWarn } from '../../common/logging';
import * as vscode from 'vscode';
import { PythonEnvsPrompt, PythonEnvsPromptProps } from './prompts';
import { PythonHelperChatParticipant } from './pythonHelperChatParticipant';
import { PromptElement, renderPrompt, UserMessage } from '@vscode/prompt-tsx';
import { LanguageModelTextPart, LanguageModelToolCallPart } from 'vscode';
import { ToolCallRound, ToolResultMetadata } from '@vscode/chat-extension-utils/dist/toolsPrompt';

export const CHAT_PARTICIPANT_ID = 'python-helper';
export const CHAT_PARTICIPANT_AT_MENTION = `@${CHAT_PARTICIPANT_ID}`;

export function registerChatParticipant(_context: vscode.ExtensionContext) {
    traceInfo('Registering python helper chat participant'); // Log registration start

    // Define the request handler for the chat participant
    const requestHandler: vscode.ChatRequestHandler = async (
        request: vscode.ChatRequest, // prompt made in pip file
        chatContext: vscode.ChatContext, // history
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
    ) => {
        traceWarn('Python helper chat participant invoked with request:', request); // Log request details

        // gather the available tools
        const first100tools = vscode.lm.tools.slice(0, 100);
        const tools: vscode.LanguageModelChatTool[] = first100tools.map((tool): vscode.LanguageModelChatTool => {
            return {
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema ?? {},
            };
        });
        traceInfo('Tools prepared:', tools); // Log tools

        const userPrompt = request.prompt;
        traceInfo('User prompt received:', userPrompt); // Log user prompt

        const refTools = request.toolReferences;
        const refToolInvToken = request.toolInvocationToken;
        const refRef = request.references;
        const refCom = request.command;
        const refPrompt = request.prompt;
        let model = request.model;
        traceInfo('References received:', refTools, refToolInvToken, refRef, refCom, refPrompt, model); // Log references

        // takes the info and creates a prompt using the PythonEnvsPrompt
        const result = await renderPrompt<PythonEnvsPromptProps>(
            PythonEnvsPrompt, // Extract the constructor PythonEnvsPromptProps
            {
                title: 'Python Environment',
                description: 'Provide information about the Python environment.',
                request: {
                    prompt: '' + userPrompt + ' What is the current Python environment? What packages are installed?',
                },
            },
            { modelMaxPromptTokens: model.maxInputTokens },
            model,
        );

        // result of building the prompt
        let messages = result.messages;

        const options: vscode.LanguageModelChatRequestOptions = {
            justification: 'To make a request to @toolsTSX',
            tools: tools,
        };

        const toolReferences = [...request.toolReferences];
        const accumulatedToolResults: Record<string, vscode.LanguageModelToolResult> = {};
        const toolCallRounds: ToolCallRound[] = [];
        const runWithTools = async (): Promise<void> => {
            const requestedTool = toolReferences.shift();

            if (requestedTool) {
                 // NOT WORKING::: If a toolReference is present, force the model to call that tool
                options.toolMode = vscode.LanguageModelChatToolMode.Required;
                options.tools = vscode.lm.tools.filter((tool) => tool.name === requestedTool.name);
            } else {
                options.toolMode = undefined;
                options.tools = [...tools];
            }
            console.log('Requested tool:', requestedTool); // Log requested tool

            // Send the request to the model
            const response = await model.sendRequest(messages, options, token);
            traceInfo('Chat participant response sent:', response); // Log response

            // Stream the response back to VS Code
            let responseStr = '';
            const toolCalls: vscode.LanguageModelToolCallPart[] = [];

            for await (const chunk of response.stream) {
                if (chunk instanceof LanguageModelTextPart) {
                    stream.markdown(chunk.value);
                    responseStr += chunk.value; // Accumulate the response string
                } else if (chunk instanceof LanguageModelToolCallPart) {
                    // If the response contains vscode.LanguageModelToolCallPart, then you should re-send the prompt with a ToolCall element for each of those.
                    console.log('TOOL CALL', chunk);
                    toolCalls.push(chunk);
                }
            }

            if (toolCalls.length) {
                traceInfo('Tool calls detected:', toolCalls); // Log tool calls

                // If the model called any tools, then we do another round- render the prompt with those tool calls (rendering the PromptElements will invoke the tools)
                // and include the tool results in the prompt for the next request.
                toolCallRounds.push({
                    response: responseStr,
                    toolCalls,
                });

                const result = await renderPrompt<PythonEnvsPromptProps>(
                    PythonEnvsPrompt, // Extract the constructor PythonEnvsPromptProps
                    {
                        title: 'Python Environment',
                        description: 'Provide information about the Python environment.',
                        request: {
                            prompt:
                                '' +
                                userPrompt +
                                ' What is the current Python environment? What packages are installed?',
                        },
                    },
                    { modelMaxPromptTokens: model.maxInputTokens },
                    model,
                );

                // result of building the prompt
                let messages = result.messages;
                const toolResultMetadata = result.metadatas.getAll(ToolResultMetadata);
                if (toolResultMetadata?.length) {
                    // Cache tool results for later, so they can be incorporated into later prompts without calling the tool again
                    toolResultMetadata.forEach((meta) => (accumulatedToolResults[meta.toolCallId] = meta.result));
                }

                // This loops until the model doesn't want to call any more tools, then the request is done.
                return runWithTools();
            }
        };
        await runWithTools(); // Ensure tools are run before proceeding

        // end of request handler
    };

    const participant = vscode.chat.createChatParticipant(CHAT_PARTICIPANT_ID, requestHandler);
    participant.iconPath = new vscode.ThemeIcon('python');

    traceInfo('Chat participant created and registered'); // Log participant creation

    // Register using our singleton manager
    return PythonHelperChatParticipant.register(participant, _context);
}
