// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const { createHash } = require('node:crypto');

const marker = '<!-- gh-aw-workflow-id: issue-moderation -->';
const replies = {
    unrelated:
        "Thanks for reaching out! This tracker is for bugs and feature requests about the Python Environments extension for VS Code. This report appears unrelated, so we're closing it for now. If we misunderstood, please leave a comment so a maintainer can review it.",
    'needs-info':
        'Thanks for reaching out! Could you fill out the issue template in this issue? A little more information would help us investigate and better understand how to help.',
};

function isHuman(actor) {
    return actor?.type !== 'Bot';
}

function getTarget(context, issueNumber) {
    const number = issueNumber ?? context.payload.issue?.number ?? context.payload.inputs?.issue_number;
    if (!/^[1-9]\d*$/.test(String(number)) || !Number.isSafeInteger(Number(number))) {
        throw new Error('A positive issue number is required.');
    }
    if (context.payload.issue && context.payload.issue.number !== Number(number)) {
        throw new Error('The requested issue does not match the triggering issue.');
    }
    return { ...context.repo, issue_number: Number(number) };
}

/**
 * Prepare content-only input for an independent review. Bot metadata is neither
 * classification evidence nor an eligibility gate. Human triage/discussion,
 * closed/locked issues, and this workflow's previous responses take precedence.
 * The fingerprint binds the live report across inference and publication.
 */
async function inspectIssue({ github, context, issueNumber, ownCommentId }) {
    const target = getTarget(context, issueNumber);
    const skip = (reason) => ({ target, reason });
    if (context.eventName === 'issues' && context.payload.action !== 'opened') {
        return skip('Only newly opened issues are automatically reviewed.');
    }
    const { data: issue } = await github.rest.issues.get(target);
    if (issue.pull_request || issue.state !== 'open' || issue.locked) {
        return skip('The target is not an open, unlocked issue.');
    }
    const opening = context.eventName === 'issues' ? context.payload.issue : undefined;
    if (opening && (issue.title !== opening.title || (issue.body ?? '') !== (opening.body ?? ''))) {
        return skip('The report changed after opening; leave the updated report for normal triage.');
    }
    const events = await github.paginate(github.rest.issues.listEventsForTimeline, { ...target, per_page: 100 });
    const labelEvents = (name) =>
        events.filter((event) => ['labeled', 'unlabeled'].includes(event.event) && event.label?.name === name);
    // Only the opening payload proves creation-time labels; manual runs must not guess from timestamps.
    const initialLabelNames = new Set((opening?.labels ?? []).map((label) => label.name));
    const initialEvents = new Set();
    for (const name of initialLabelNames) {
        const history = labelEvents(name);
        if (history[0]?.event === 'labeled') initialEvents.add(history[0]);
    }
    for (const label of issue.labels) {
        const event = labelEvents(label.name).at(-1);
        if (!event || (isHuman(event.actor) && !initialEvents.has(event))) {
            return skip('A human-owned or unverifiable triage label is present.');
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
                ['labeled', 'unlabeled', 'assigned', 'unassigned', 'reopened', 'closed', 'locked', 'unlocked', 'renamed',
                    'milestoned', 'demilestoned', 'pinned', 'unpinned', 'added_to_project', 'removed_from_project',
                    'moved_columns_in_project', 'connected', 'disconnected', 'marked_as_duplicate', 'unmarked_as_duplicate']
                    .includes(event.event) &&
                isHuman(event.actor) &&
                !initialEvents.has(event),
        )
    ) {
        return skip('A human has already changed triage or issue state.');
    }
    const comments = (await github.paginate(github.rest.issues.listComments, { ...target, per_page: 100 })).filter(
        (comment) => ownCommentId === undefined || comment.id !== ownCommentId,
    );
    if (comments.some((comment) => isHuman(comment.user))) {
        return skip('Human discussion already exists; leave the issue for normal triage.');
    }
    if (
        comments.some(
            (comment) => comment.user?.login === 'github-actions[bot]' && (comment.body ?? '').includes(marker),
        )
    ) {
        return skip('This workflow has already responded to the issue.');
    }
    const report = { title: issue.title, description: issue.body ?? '' };
    const snapshot = createHash('sha256').update(JSON.stringify({ target, report })).digest('hex');
    return { target, report, snapshot };
}

/**
 * Apply one independent content classification to the selected issue only.
 * Useful/uncertain reports cause no writes. Missing details get a fixed request
 * and local info-needed; only clear unrelated content gets a polite closure.
 * Central labels and assignments are preserved. Staged mode performs no writes.
 */
async function applyModeration({ github, context, issueNumber, output, snapshot, staged = false }) {
    const items = Array.isArray(output?.items) ? output.items.filter((item) => item?.type === 'moderation_action') : [];
    if (items.length !== 1 || !['unrelated', 'needs-info', 'relevant'].includes(items[0].classification)) {
        throw new Error('Exactly one valid moderation classification is required.');
    }
    if (typeof snapshot !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot)) {
        throw new Error('A trusted pre-inference issue snapshot is required.');
    }
    let ownCommentId;
    const check = async () => {
        const current = await inspectIssue({ github, context, issueNumber, ownCommentId });
        if (!current.reason && current.snapshot !== snapshot) {
            current.reason = 'The report changed during review.';
        }
        return current;
    };
    const current = await check();
    if (current.reason) return { status: 'skipped', reason: current.reason };
    const classification = items[0].classification;
    if (classification === 'relevant') {
        return { status: 'skipped', reason: 'The report is useful or uncertain; no changes were made.' };
    }
    const action = classification === 'unrelated'
        ? 'Reply politely and close as not planned.'
        : 'Request information, add info-needed, and leave the issue open.';
    const runUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
    const body = [
        replies[classification],
        '',
        `_Automated issue moderation (${classification}). [Workflow run](${runUrl})._`,
        '',
        marker,
    ].join('\n');
    if (staged) return { status: 'skipped', reason: `Staged preview: ${action}`, body };
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

module.exports = { inspectIssue, applyModeration };
