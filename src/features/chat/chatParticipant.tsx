
import { sendChatParticipantRequest } from "@vscode/chat-extension-utils";
import { traceInfo, traceWarn } from "../../common/logging";
import * as vscode from "vscode";
import { PythonEnvsPrompt } from "./prompts";
import { PromptElementAndProps } from "@vscode/chat-extension-utils/dist/toolsPrompt";
import { ChatEnvironmentErrorInfo, ERROR_CHAT_CONTEXT_QUEUE } from "./send_prompt";
import { PythonHelperChatParticipant } from "./pythonHelperChatParticipant";

export const CHAT_PARTICIPANT_ID = 'python-helper';
export const CHAT_PARTICIPANT_AT_MENTION = `@${CHAT_PARTICIPANT_ID}`;



export function registerChatParticipant(
	_context: vscode.ExtensionContext,
) {
    traceInfo('Registering python helper chat participant');
    const participant = vscode.chat.createChatParticipant(CHAT_PARTICIPANT_ID,
		async (
			request: vscode.ChatRequest,
			chatContext: vscode.ChatContext,
			stream: vscode.ChatResponseStream,
			token: vscode.CancellationToken
		) => {
            traceWarn('Python helper chat participant invoked with request:', request);
            const userPrompt = request.prompt;

         
            const prompt: PromptElementAndProps<PythonEnvsPrompt> = {
				promptElement: PythonEnvsPrompt,
				props: {
					title: 'Python Environment',
					description: 'Provide information about the Python environment.',
					request: {
						prompt: '' + userPrompt + ' What is the current Python environment? What packages are installed?',
					},
				},
			};

            const { result } = sendChatParticipantRequest(
                request,
                chatContext,
                {
                    prompt,
                    requestJustification: vscode.l10n.t('Tell me about my environment.'),
                    responseStreamOptions: {
                        stream,
                        references: false,
                        responseText: true,
                    },
                },
                token,
            );

            return await result;
		}
	);
    participant.iconPath = new vscode.ThemeIcon('python');

    // Register using our singleton manager
    return PythonHelperChatParticipant.register(participant, _context);


}

