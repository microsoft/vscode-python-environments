/**
 * Manages temporary visual feedback for copy operations by tracking recently copied items.
 */

import { EventEmitter } from 'vscode';

export interface CopiedItem {
    id: string;
    timestamp: number;
}

/**
 * Manages state for copy feedback, tracking which items were recently copied
 * and providing events for UI updates.
 */
export class CopyFeedbackManager {
    private readonly copiedItems = new Map<string, number>();
    private readonly _onDidChangeCopiedState = new EventEmitter<string>();
    private readonly timeoutDuration: number;

    public readonly onDidChangeCopiedState = this._onDidChangeCopiedState.event;

    constructor(timeoutDuration: number = 2000) {
        this.timeoutDuration = timeoutDuration;
    }

    /**
     * Mark an item as recently copied and schedule its removal
     * @param itemId Unique identifier for the copied item
     */
    public markAsCopied(itemId: string): void {
        const timestamp = Date.now();
        this.copiedItems.set(itemId, timestamp);
        this._onDidChangeCopiedState.fire(itemId);

        // Schedule removal of the copied state
        setTimeout(() => {
            if (this.copiedItems.get(itemId) === timestamp) {
                this.copiedItems.delete(itemId);
                this._onDidChangeCopiedState.fire(itemId);
            }
        }, this.timeoutDuration);
    }

    /**
     * Check if an item is currently in the "recently copied" state
     * @param itemId Unique identifier for the item
     * @returns true if the item was recently copied and is still within the timeout period
     */
    public isRecentlyCopied(itemId: string): boolean {
        const timestamp = this.copiedItems.get(itemId);
        if (!timestamp) {
            return false;
        }

        const elapsed = Date.now() - timestamp;
        if (elapsed > this.timeoutDuration) {
            this.copiedItems.delete(itemId);
            return false;
        }

        return true;
    }

    /**
     * Clear all copied states immediately
     */
    public clearAll(): void {
        const itemIds = Array.from(this.copiedItems.keys());
        this.copiedItems.clear();
        itemIds.forEach(id => this._onDidChangeCopiedState.fire(id));
    }

    /**
     * Dispose of the feedback manager and clean up resources
     */
    public dispose(): void {
        this.copiedItems.clear();
        this._onDidChangeCopiedState.dispose();
    }
}

// Global instance for the extension
let globalCopyFeedbackManager: CopyFeedbackManager | undefined;

/**
 * Get the global copy feedback manager instance
 */
export function getCopyFeedbackManager(): CopyFeedbackManager {
    if (!globalCopyFeedbackManager) {
        globalCopyFeedbackManager = new CopyFeedbackManager();
    }
    return globalCopyFeedbackManager;
}

/**
 * Initialize the global copy feedback manager
 */
export function initializeCopyFeedbackManager(timeoutDuration?: number): CopyFeedbackManager {
    if (globalCopyFeedbackManager) {
        globalCopyFeedbackManager.dispose();
    }
    globalCopyFeedbackManager = new CopyFeedbackManager(timeoutDuration);
    return globalCopyFeedbackManager;
}

/**
 * Dispose the global copy feedback manager
 */
export function disposeCopyFeedbackManager(): void {
    if (globalCopyFeedbackManager) {
        globalCopyFeedbackManager.dispose();
        globalCopyFeedbackManager = undefined;
    }
}