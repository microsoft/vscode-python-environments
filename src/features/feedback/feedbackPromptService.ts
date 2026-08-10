import { promises as fs } from 'fs';
import * as path from 'path';
import { Disposable, env, Memento, UIKind, window } from 'vscode';
import { launchBrowser } from '../../common/env.apis';
import { FeedbackStrings } from '../../common/localize';
import { traceError } from '../../common/logging';
import { showInformationMessage } from '../../common/window.apis';
import { getConfiguration } from '../../common/workspace.apis';

export const FEEDBACK_PROMPT_STATE_KEY = 'python-envs:feedbackPrompt:v2';

const MARKETPLACE_REVIEWS_URL =
    'https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-python-envs&tab=RatingsAndReviews';
const PROMPT_CLAIM_FILE = 'feedback-prompt-shown';
const MINIMUM_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MINIMUM_ACTIVE_DAYS = 9;
const MINIMUM_SUCCESSFUL_ACTION_DAYS = 2;
const QUIET_PERIOD_MS = 60 * 1000;
const MAX_TRACKED_DAYS = 30;

export interface FeedbackPromptState {
    firstSeenAt: number;
    activeDays: string[];
    successfulActionDays: string[];
}

interface FeedbackPromptDependencies {
    now: () => number;
    schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    cancelSchedule: (timer: ReturnType<typeof setTimeout>) => void;
    showInformationMessage: typeof showInformationMessage;
    launchBrowser: typeof launchBrowser;
    isWindowFocused: () => boolean;
    isWeb: () => boolean;
    isFeedbackEnabled: () => boolean;
    claimPrompt: () => Promise<boolean>;
    releasePromptClaim: () => Promise<void>;
}

const defaultDependencies: Omit<FeedbackPromptDependencies, 'claimPrompt' | 'releasePromptClaim'> = {
    now: () => Date.now(),
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancelSchedule: (timer) => clearTimeout(timer),
    showInformationMessage,
    launchBrowser,
    isWindowFocused: () => window.state.focused,
    isWeb: () => env.uiKind === UIKind.Web,
    isFeedbackEnabled: () => getConfiguration('telemetry').get<boolean>('feedback.enabled', true),
};

function utcDay(timestamp: number): string {
    return new Date(timestamp).toISOString().slice(0, 10);
}

function boundedDays(days: string[]): string[] {
    return [...new Set(days)].slice(-MAX_TRACKED_DAYS);
}

function normalizeState(value: FeedbackPromptState | undefined, now: number): FeedbackPromptState {
    return {
        firstSeenAt: typeof value?.firstSeenAt === 'number' ? value.firstSeenAt : now,
        activeDays: boundedDays(Array.isArray(value?.activeDays) ? value.activeDays : []),
        successfulActionDays: boundedDays(
            Array.isArray(value?.successfulActionDays) ? value.successfulActionDays : [],
        ),
    };
}

function mergeStates(first: FeedbackPromptState, second: FeedbackPromptState): FeedbackPromptState {
    return {
        firstSeenAt: Math.min(first.firstSeenAt, second.firstSeenAt),
        activeDays: boundedDays([...first.activeDays, ...second.activeDays]),
        successfulActionDays: boundedDays([
            ...first.successfulActionDays,
            ...second.successfulActionDays,
        ]),
    };
}

export function isFeedbackPromptEligible(state: FeedbackPromptState, now: number): boolean {
    return (
        now - state.firstSeenAt >= MINIMUM_AGE_MS &&
        new Set(state.activeDays).size >= MINIMUM_ACTIVE_DAYS &&
        new Set(state.successfulActionDays).size >= MINIMUM_SUCCESSFUL_ACTION_DAYS
    );
}

export class FeedbackPromptService implements Disposable {
    private state: FeedbackPromptState;
    private stateWrite = Promise.resolve();
    private promptShown: boolean;
    private successfulActionThisSession = false;
    private promptInProgress = false;
    private disposed = false;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private readonly dependencies: FeedbackPromptDependencies;

    constructor(
        private readonly globalState: Memento,
        globalStoragePath: string,
        dependencies: Partial<FeedbackPromptDependencies> = {},
        private readonly quietPeriodMs = QUIET_PERIOD_MS,
    ) {
        this.dependencies = {
            ...defaultDependencies,
            claimPrompt: () => claimPrompt(globalStoragePath),
            releasePromptClaim: () => releasePromptClaim(globalStoragePath),
            ...dependencies,
        };
        this.promptShown = false;
        this.state = normalizeState(
            globalState.get<FeedbackPromptState>(FEEDBACK_PROMPT_STATE_KEY),
            this.dependencies.now(),
        );
    }

    async initialize(): Promise<void> {
        const day = utcDay(this.dependencies.now());
        await this.updateState((state) => {
            if (state.activeDays.includes(day)) {
                return false;
            }
            state.activeDays = boundedDays([...state.activeDays, day]);
            return true;
        });
    }

    async recordSuccessfulAction(): Promise<void> {
        const day = utcDay(this.dependencies.now());
        await this.updateState((state) => {
            if (state.successfulActionDays.includes(day)) {
                return false;
            }
            state.successfulActionDays = boundedDays([...state.successfulActionDays, day]);
            return true;
        });
        this.successfulActionThisSession = true;
        this.scheduleEvaluation();
    }

    notifyWindowFocused(): void {
        this.scheduleEvaluation();
    }

    async showPromptIfEligible(): Promise<void> {
        await this.stateWrite;
        if (!this.canShowPrompt()) {
            return;
        }

        this.cancelEvaluation();
        this.promptInProgress = true;
        try {
            if (!(await this.dependencies.claimPrompt())) {
                this.promptShown = true;
                return;
            }
            if (!this.canShowPrompt(true)) {
                await this.dependencies.releasePromptClaim();
                this.scheduleEvaluation();
                return;
            }

            this.promptShown = true;
            const selection = await this.dependencies.showInformationMessage(
                FeedbackStrings.prompt,
                FeedbackStrings.reviewMarketplace,
            );
            if (selection === FeedbackStrings.reviewMarketplace) {
                await this.dependencies.launchBrowser(MARKETPLACE_REVIEWS_URL);
            }
        } catch (error) {
            traceError('Failed to show or handle the feedback prompt:', error);
        } finally {
            this.promptInProgress = false;
        }
    }

    dispose(): void {
        this.disposed = true;
        this.cancelEvaluation();
    }

    private canShowPrompt(ignorePromptInProgress = false): boolean {
        return (
            !this.disposed &&
            (ignorePromptInProgress || !this.promptInProgress) &&
            !this.promptShown &&
            this.successfulActionThisSession &&
            !this.dependencies.isWeb() &&
            this.dependencies.isWindowFocused() &&
            this.dependencies.isFeedbackEnabled() &&
            isFeedbackPromptEligible(this.state, this.dependencies.now())
        );
    }

    private async updateState(mutator: (state: FeedbackPromptState) => boolean): Promise<void> {
        this.stateWrite = this.stateWrite
            .then(async () => {
                this.state = mergeStates(
                    this.state,
                    normalizeState(
                        this.globalState.get<FeedbackPromptState>(FEEDBACK_PROMPT_STATE_KEY),
                        this.dependencies.now(),
                    ),
                );
                if (!mutator(this.state)) {
                    return;
                }
                await this.globalState.update(FEEDBACK_PROMPT_STATE_KEY, this.state);
            })
            .catch((error) => traceError('Failed to persist feedback prompt state:', error));
        await this.stateWrite;
    }

    private scheduleEvaluation(): void {
        if (this.disposed || this.promptShown || !this.successfulActionThisSession) {
            return;
        }
        this.cancelEvaluation();
        this.timer = this.dependencies.schedule(() => {
            this.timer = undefined;
            void this.showPromptIfEligible();
        }, this.quietPeriodMs);
    }

    private cancelEvaluation(): void {
        if (this.timer !== undefined) {
            this.dependencies.cancelSchedule(this.timer);
            this.timer = undefined;
        }
    }
}

/**
 * Atomically creates the marker only when it does not already exist.
 * Success acquires the prompt claim; EEXIST means another extension host already claimed or displayed it.
 */
async function claimPrompt(globalStoragePath: string): Promise<boolean> {
    await fs.mkdir(globalStoragePath, { recursive: true });
    try {
        const handle = await fs.open(path.join(globalStoragePath, PROMPT_CLAIM_FILE), 'wx');
        await handle.close();
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            return false;
        }
        throw error;
    }
}

// Remove the claim only when display conditions change before the prompt is shown.
// After the prompt is displayed or dismissed, the marker remains to enforce once-only behavior.
async function releasePromptClaim(globalStoragePath: string): Promise<void> {
    try {
        await fs.unlink(path.join(globalStoragePath, PROMPT_CLAIM_FILE));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }
}
