import * as vscode from 'vscode';

export class PythonHelperChatParticipant {
    private static _instance: PythonHelperChatParticipant | undefined;
    public readonly participant: vscode.ChatParticipant;
    public readonly context: vscode.ExtensionContext;

    constructor(participant: vscode.ChatParticipant, context: vscode.ExtensionContext) {
        this.participant = participant;
        this.context = context;
    }

    public static getInstance(): PythonHelperChatParticipant | undefined {
        return PythonHelperChatParticipant._instance;
    }

    private static setInstance(instance: PythonHelperChatParticipant): void {
        PythonHelperChatParticipant._instance = instance;
    }

    public static register(
        participant: vscode.ChatParticipant,
        context: vscode.ExtensionContext,
    ): PythonHelperChatParticipant {
        const instance = new PythonHelperChatParticipant(participant, context);
        PythonHelperChatParticipant.setInstance(instance);
        return instance;
    }
}
