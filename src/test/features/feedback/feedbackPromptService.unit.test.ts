import assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import {
    FEEDBACK_PROMPT_STATE_KEY,
    FeedbackPromptService,
    FeedbackPromptState,
    isFeedbackPromptEligible,
} from '../../../features/feedback/feedbackPromptService';
import { FeedbackStrings } from '../../../common/localize';
import { MockMemento } from '../../mocks/mementos';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 4, 12);

function day(offset: number): string {
    return new Date(NOW + offset * DAY_MS).toISOString().slice(0, 10);
}

function eligibleState(overrides: Partial<FeedbackPromptState> = {}): FeedbackPromptState {
    return {
        firstSeenAt: NOW - 20 * DAY_MS,
        activeDays: Array.from({ length: 9 }, (_, index) => day(index - 8)),
        successfulActionDays: [day(-1), day(0)],
        ...overrides,
    };
}

function dependencies(
    now: () => number,
    showInformationMessage = sinon.stub().resolves(undefined),
    launchBrowser = sinon.stub().resolves(true),
) {
    return {
        now,
        showInformationMessage,
        launchBrowser,
        isWindowFocused: () => true,
        isWeb: () => false,
        isFeedbackEnabled: () => true,
        claimPrompt: async () => true,
        releasePromptClaim: async () => undefined,
    };
}

suite('FeedbackPromptService', () => {
    teardown(() => {
        sinon.restore();
    });

    test('requires age, active days, and successful actions on two days', () => {
        assert.strictEqual(isFeedbackPromptEligible(eligibleState(), NOW), true);
        assert.strictEqual(
            isFeedbackPromptEligible(eligibleState({ firstSeenAt: NOW - 13 * DAY_MS }), NOW),
            false,
        );
        assert.strictEqual(
            isFeedbackPromptEligible(
                eligibleState({ activeDays: eligibleState().activeDays.slice(1) }),
                NOW,
            ),
            false,
        );
        assert.strictEqual(
            isFeedbackPromptEligible(eligibleState({ successfulActionDays: [day(0)] }), NOW),
            false,
        );
    });

    test('records active and successful-action days without same-day inflation', async () => {
        const memento = new MockMemento();
        let now = NOW;
        const service = new FeedbackPromptService(memento, 'unused', dependencies(() => now));

        await service.initialize();
        await service.initialize();
        await service.recordSuccessfulAction();
        await service.recordSuccessfulAction();
        now += DAY_MS;
        await service.recordSuccessfulAction();

        const state = memento.get(FEEDBACK_PROMPT_STATE_KEY) as FeedbackPromptState;
        assert.deepStrictEqual(state.activeDays, [day(0)]);
        assert.deepStrictEqual(state.successfulActionDays, [day(0), day(1)]);
        service.dispose();
    });

    test('prompts only after a successful action in the current session', async () => {
        const memento = new MockMemento();
        await memento.update(FEEDBACK_PROMPT_STATE_KEY, eligibleState());
        const showInformationMessage = sinon.stub().resolves(FeedbackStrings.reviewMarketplace);
        const launchBrowser = sinon.stub().resolves(true);
        const service = new FeedbackPromptService(
            memento,
            'unused',
            dependencies(() => NOW, showInformationMessage, launchBrowser),
        );

        await service.initialize();
        await service.showPromptIfEligible();
        assert.strictEqual(showInformationMessage.callCount, 0);

        await service.recordSuccessfulAction();
        await service.showPromptIfEligible();

        assert.strictEqual(showInformationMessage.callCount, 1);
        assert.deepStrictEqual(showInformationMessage.firstCall.args.slice(1), [
            FeedbackStrings.reviewMarketplace,
        ]);
        assert.strictEqual(launchBrowser.callCount, 1);
        assert.match(launchBrowser.firstCall.args[0].toString(), /tab=RatingsAndReviews$/);
        service.dispose();
    });

    test('never prompts a second time, including after dismissal', async () => {
        const memento = new MockMemento();
        await memento.update(FEEDBACK_PROMPT_STATE_KEY, eligibleState());
        const showInformationMessage = sinon.stub().resolves(undefined);
        const service = new FeedbackPromptService(
            memento,
            'unused',
            dependencies(() => NOW, showInformationMessage),
        );

        await service.initialize();
        await service.recordSuccessfulAction();
        await service.showPromptIfEligible();
        await service.showPromptIfEligible();

        assert.strictEqual(showInformationMessage.callCount, 1);
        service.dispose();
    });

    test('claims the prompt atomically across extension hosts', async () => {
        const storagePath = path.join(os.tmpdir(), `python-envs-feedback-${process.pid}-${Date.now()}`);
        const firstMemento = new MockMemento();
        const secondMemento = new MockMemento();
        await firstMemento.update(FEEDBACK_PROMPT_STATE_KEY, eligibleState());
        await secondMemento.update(FEEDBACK_PROMPT_STATE_KEY, eligibleState());
        const showInformationMessage = sinon.stub().resolves(undefined);
        const sharedDependencies = {
            now: () => NOW,
            showInformationMessage,
            launchBrowser: sinon.stub(),
            isWindowFocused: () => true,
            isWeb: () => false,
            isFeedbackEnabled: () => true,
        };
        const first = new FeedbackPromptService(firstMemento, storagePath, sharedDependencies);
        const second = new FeedbackPromptService(secondMemento, storagePath, sharedDependencies);

        try {
            await Promise.all([first.initialize(), second.initialize()]);
            await Promise.all([first.recordSuccessfulAction(), second.recordSuccessfulAction()]);
            await Promise.all([first.showPromptIfEligible(), second.showPromptIfEligible()]);

            assert.strictEqual(showInformationMessage.callCount, 1);
        } finally {
            first.dispose();
            second.dispose();
            await fs.remove(storagePath);
        }
    });

    test('suppresses web, unfocused, and feedback-disabled sessions', async () => {
        const cases = [
            { isWeb: () => true },
            { isWindowFocused: () => false },
            { isFeedbackEnabled: () => false },
        ];
        for (const overrides of cases) {
            const memento = new MockMemento();
            await memento.update(FEEDBACK_PROMPT_STATE_KEY, eligibleState());
            const showInformationMessage = sinon.stub();
            const service = new FeedbackPromptService(memento, 'unused', {
                ...dependencies(() => NOW, showInformationMessage),
                ...overrides,
            });

            await service.initialize();
            await service.recordSuccessfulAction();
            await service.showPromptIfEligible();

            assert.strictEqual(showInformationMessage.callCount, 0);
            service.dispose();
        }
    });

    test('uses a one-minute quiet delay and cancels it on disposal', async () => {
        const memento = new MockMemento();
        const schedule = sinon.stub().returns(123 as unknown as ReturnType<typeof setTimeout>);
        const cancelSchedule = sinon.stub();
        const service = new FeedbackPromptService(memento, 'unused', {
            ...dependencies(() => NOW),
            schedule,
            cancelSchedule,
        });

        await service.initialize();
        await service.recordSuccessfulAction();
        service.dispose();

        assert.strictEqual(schedule.callCount, 1);
        assert.strictEqual(schedule.firstCall.args[1], 60_000);
        assert.strictEqual(cancelSchedule.callCount, 1);
    });
});
