// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const { createHash } = require('node:crypto');

const classifier = 'vs-code-engineering[bot]';
const flagNames = ['~spam', '~info-needed'];
const reviewLabel = 'moderation-review-needed';
const marker = '<!-- gh-aw-workflow-id: issue-moderation -->';
const maxFlagAge = 7 * 24 * 60 * 60 * 1000;
const maintainerAssociations = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const replies = {
    unrelated:
        "Thanks for reaching out! This tracker is for bugs and feature requests about the Python Environments extension for VS Code. This report appears unrelated, so we're closing it for now. If we misunderstood, please leave a comment so a maintainer can review it.",
    'needs-info':
        'Thanks for reaching out! Could you fill out the issue template in this issue? A little more information would help us investigate and better understand how to help.',
};

function isClassifier(actor) {
    return actor?.login === classifier;
}

function isHuman(actor) {
    return !actor || (actor.type !== 'Bot' && !isClassifier(actor));
}

function getTarget(context, issueNumber) {
    if (!/^[1-9]\d*$/.test(String(issueNumber)) || !Number.isSafeInteger(Number(issueNumber))) {
        throw new Error('A positive issue number is required.');
    }
    if (context.payload.issue && context.payload.issue.number !== Number(issueNumber)) {
        throw new Error('The requested issue does not match the triggering issue.');
    }
    return { ...context.repo, issue_number: Number(issueNumber) };
}

/**
 * Inspect a recent, currently applied central-bot flag. Human triage and replies
 * take precedence, while central assignments and area-label changes are preserved.
 * The fingerprint binds the report, discussion, and flag events across AI review.
 */
async function inspectIssue({ github, context, issueNumber, flagEventId, ownCommentId, now = Date.now() }) {
    const target = getTarget(context, issueNumber);
    const { data: issue } = await github.rest.issues.get(target);
    const skip = (reason) => ({ target, reason });
    if (issue.pull_request || issue.state !== 'open' || issue.locked) {
        return skip('The target is not an open, unlocked issue.');
    }
    const labels = issue.labels.map((label) => label.name);
    if (labels.includes(reviewLabel) || labels.includes('info-needed')) {
        return skip('The issue is already awaiting information or human review.');
    }
    const presentFlags = flagNames.filter((name) => labels.includes(name));
    if (!presentFlags.length) {
        return skip('There is no central triage flag to follow up.');
    }
    const events = await github.paginate(github.rest.issues.listEventsForTimeline, { ...target, per_page: 100 });
    const lastLabelEvent = (name) =>
        events.findLast((event) => ['labeled', 'unlabeled'].includes(event.event) && event.label?.name === name);
    const flags = presentFlags.map(lastLabelEvent);
    if (flags.some((event) => event?.event !== 'labeled' || !isClassifier(event.actor))) {
        return skip('A current triage flag was not applied by the trusted central bot.');
    }
    if (flags.some((event) =>
        !/^[1-9]\d*$/.test(String(event.id)) ||
        !Number.isSafeInteger(Number(event.id)) ||
        !Number.isFinite(Date.parse(event.created_at)))) {
        throw new Error('GitHub returned an invalid triage flag event.');
    }
    flags.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || Number(b.id) - Number(a.id));
    const latest = flags[0];
    if (Date.parse(latest.created_at) < now - maxFlagAge || Date.parse(latest.created_at) > now + 5 * 60 * 1000) {
        return skip('The bot flag is outside the seven-day automatic follow-up window.');
    }
    if (flagEventId !== undefined && String(latest.id) !== String(flagEventId)) {
        return skip('The selected flag was superseded before follow-up.');
    }
    for (const name of labels.filter((name) => !flagNames.includes(name) && name !== 'triage-needed')) {
        const event = lastLabelEvent(name);
        if (!event || isHuman(event.actor)) {
            return skip('A human-owned triage label is present.');
        }
    }
    for (const assignee of issue.assignees) {
        const event = events.findLast((entry) => entry.event === 'assigned' && entry.assignee?.login === assignee.login);
        if (!event || isHuman(event.actor)) {
            return skip('A human has assigned the issue.');
        }
    }
    if (
        events.some(
            (event) =>
                ['labeled', 'unlabeled', 'assigned', 'unassigned'].includes(event.event) &&
                isHuman(event.actor) &&
                Date.parse(event.created_at) >= Date.parse(latest.created_at),
        )
    ) {
        return skip('A human changed triage after the central flag.');
    }
    const comments = (await github.paginate(github.rest.issues.listComments, { ...target, per_page: 100 })).filter(
        (comment) => ownCommentId === undefined || comment.id !== ownCommentId,
    );
    if (
        comments.some(
            (comment) =>
                isHuman(comment.user) &&
                (maintainerAssociations.has(comment.author_association) ||
                    Date.parse(comment.updated_at || comment.created_at) >= Date.parse(latest.created_at)),
        )
    ) {
        return skip('A human has already handled or replied to the flagged report.');
    }
    if (
        comments.some(
            (comment) => comment.user?.login === 'github-actions[bot]' && (comment.body ?? '').includes(marker),
        )
    ) {
        return skip('This workflow has already followed up on the issue.');
    }
    const snapshot = createHash('sha256')
        .update(
            JSON.stringify({
                target,
                title: issue.title,
                body: issue.body ?? '',
                flags: flags.map((event) => String(event.id)),
                comments: comments.map((comment) => ({
                    id: comment.id,
                    body: comment.body,
                    author: comment.user?.login,
                    updated: comment.updated_at,
                })),
            }),
        )
        .digest('hex');
    return {
        target,
        snapshot,
        flagEventId: String(latest.id),
        flagName: flags.length > 1 ? 'conflicting' : latest.label.name,
    };
}

/**
 * Select at most 20 eligible bot-flagged issues for one event, manual replay, or
 * hourly catch-up. Catch-up scans the latest 100 updated issues per source label;
 * deferred/truncated work is reported rather than silently claiming full coverage.
 */
async function planFollowups({ github, context, now = Date.now() }) {
    let numbers;
    let truncated = false;
    if (context.eventName === 'issues') {
        if (context.payload.action !== 'labeled' || !isClassifier(context.payload.sender) ||
            !flagNames.includes(context.payload.label?.name)) {
            return { candidates: [], truncated };
        }
        numbers = [context.payload.issue.number];
    } else if (context.payload.inputs?.issue_number) {
        numbers = [getTarget(context, context.payload.inputs.issue_number).issue_number];
    } else {
        numbers = [];
        for (const name of flagNames) {
            const { data } = await github.rest.issues.listForRepo({
                ...context.repo,
                state: 'open',
                labels: name,
                since: new Date(now - maxFlagAge).toISOString(),
                sort: 'updated',
                direction: 'desc',
                per_page: 100,
            });
            truncated ||= data.length === 100;
            numbers.push(...data.filter((issue) => !issue.pull_request).map((issue) => issue.number));
        }
    }
    const candidates = [];
    for (const number of [...new Set(numbers)]) {
        const current = await inspectIssue({ github, context, issueNumber: number, now });
        if (!current.reason) {
            candidates.push({ issue_number: String(number), flag_event_id: current.flagEventId });
            if (candidates.length === 20) {
                truncated = true;
                break;
            }
        }
    }
    return { candidates, truncated };
}

async function ensureReviewLabel(github, repo) {
    try {
        await github.rest.issues.getLabel({ ...repo, name: reviewLabel });
    } catch (error) {
        if (error.status !== 404) throw error;
        try {
            await github.rest.issues.createLabel({
                ...repo,
                name: reviewLabel,
                color: 'fbca04',
                description: 'A central-bot flag needs a human moderation decision.',
            });
        } catch (creationError) {
            if (creationError.status !== 422) throw creationError;
            await github.rest.issues.getLabel({ ...repo, name: reviewLabel });
        }
    }
}

/**
 * Apply the repository's follow-up policy to one verified flag. Source labels and
 * assignments are never rewritten. Only an unambiguous spam flag can authorize
 * closure; uncertain/relevant or conflicting results are queued for human review.
 */
async function applyModeration({ github, context, issueNumber, flagEventId, output, snapshot, staged = false }) {
    const items = Array.isArray(output?.items) ? output.items.filter((item) => item?.type === 'moderation_action') : [];
    if (items.length !== 1 || !['unrelated', 'needs-info', 'relevant'].includes(items[0].classification)) {
        throw new Error('Exactly one valid moderation classification is required.');
    }
    if (typeof snapshot !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot)) {
        throw new Error('A trusted pre-inference issue snapshot is required.');
    }
    let ownCommentId;
    const check = async () => {
        const current = await inspectIssue({ github, context, issueNumber, flagEventId, ownCommentId });
        if (!current.reason && current.snapshot !== snapshot) {
            current.reason = 'The report, discussion, or source flags changed during review.';
        }
        return current;
    };
    const current = await check();
    if (current.reason) return { status: 'skipped', reason: current.reason };
    const classification = current.flagName === 'conflicting' ? 'relevant' : items[0].classification;
    if (classification === 'unrelated' && current.flagName !== '~spam') {
        throw new Error('An information-needed flag cannot authorize closure.');
    }
    const action = classification === 'unrelated'
        ? 'Reply politely and close as not planned; preserve the central spam flag.'
        : classification === 'needs-info'
            ? 'Request information, add info-needed, and leave the issue open.'
            : 'Leave open without a reply and add moderation-review-needed for a human decision.';
    const runUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
    const body = classification === 'relevant' ? undefined : [
        replies[classification],
        '',
        `_Automated flag follow-up (${classification}). [Workflow run](${runUrl})._`,
        '',
        marker,
    ].join('\n');
    if (staged) return { status: 'skipped', reason: `Staged preview: ${action}`, body };
    if (classification === 'relevant') {
        await ensureReviewLabel(github, context.repo);
        const fresh = await check();
        if (fresh.reason) return { status: 'skipped', reason: fresh.reason };
        await github.rest.issues.addLabels({ ...current.target, labels: [reviewLabel] });
        return { status: 'success', reason: action };
    }
    const { data: comment } = await github.rest.issues.createComment({ ...current.target, body });
    ownCommentId = comment.id;
    const fresh = await check();
    if (fresh.reason) {
        return { status: 'skipped', reason: `A reply was posted; further actions were skipped: ${fresh.reason}` };
    }
    if (classification === 'needs-info') {
        await github.rest.issues.addLabels({ ...current.target, labels: ['info-needed'] });
    } else {
        await github.rest.issues.update({ ...current.target, state: 'closed', state_reason: 'not_planned' });
    }
    return { status: 'success', reason: action, url: comment.html_url };
}

module.exports = { inspectIssue, planFollowups, applyModeration };
