// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const { createHash } = require('node:crypto');

const marker = '<!-- gh-aw-workflow-id: issue-moderation -->';
const classifications = ['unrelated', 'needs-info', 'relevant'];
const maintainerAssociations = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const replies = {
    unrelated:
        "Thanks for reaching out! This tracker is for bugs and feature requests about the Python Environments extension for VS Code. This report appears unrelated, so we're closing it for now. If we misunderstood, please leave a comment so a maintainer can review it.",
    'needs-info':
        'Thanks for reaching out! Could you fill out the issue template in this issue? A little more information would help us investigate and better understand how to help.',
};

function getTarget(context) {
    const number = context.payload.issue?.number ?? context.payload.inputs?.issue_number;
    if (!/^[1-9]\d*$/.test(String(number)) || !Number.isSafeInteger(Number(number))) {
        throw new Error('An issue event or a positive issue_number input is required.');
    }
    return { ...context.repo, issue_number: Number(number) };
}

/**
 * Read the triggering issue and all comments. Return an eligibility reason or
 * a content fingerprint for checking that the classified report is unchanged.
 * Only the known external classifier's spam label may be independently reassessed;
 * human-applied labels and previous workflow responses remain protected.
 */
async function inspectIssue({ github, context, ownCommentId, appliedLabels = [] }) {
    const target = getTarget(context);
    const { data: issue } = await github.rest.issues.get(target);
    if (issue.pull_request) {
        throw new Error('Issue moderation cannot target a pull request.');
    }
    const labels = issue.labels.map((label) => label.name);
    let reason;
    let externalSpam = false;
    let comments = [];
    if (issue.state !== 'open' || issue.locked) {
        reason = 'The issue is closed or locked.';
    } else if (
        issue.assignees.length ||
        labels.some((label) => !['triage-needed', '~spam', ...appliedLabels].includes(label)) ||
        appliedLabels.some((label) => !labels.includes(label))
    ) {
        reason = 'The issue is assigned or already labeled for triage.';
    } else if (
        context.payload.issue &&
        (issue.title !== context.payload.issue.title || (issue.body ?? '') !== (context.payload.issue.body ?? ''))
    ) {
        reason = 'The issue was edited after this run was triggered.';
    } else {
        if (labels.includes('~spam')) {
            const events = await github.paginate(github.rest.issues.listEventsForTimeline, { ...target, per_page: 100 });
            const event = events.findLast((entry) => entry.event === 'labeled' && entry.label?.name === '~spam');
            externalSpam = event?.actor?.login === 'vs-code-engineering[bot]';
            const ownSpam =
                ownCommentId &&
                appliedLabels.includes('~spam') &&
                event?.actor?.login === 'github-actions[bot]';
            if (!externalSpam && !ownSpam) {
                return { target, reason: 'The spam label is not a verified automated-classifier decision.' };
            }
        }
        comments = (await github.paginate(github.rest.issues.listComments, { ...target, per_page: 100 })).filter(
            (comment) => ownCommentId === undefined || comment.id !== ownCommentId,
        );
        if (comments.some((comment) => maintainerAssociations.has(comment.author_association))) {
            reason = 'A maintainer has already commented.';
        } else if (
            comments.some(
                (comment) => comment.user?.login === 'github-actions[bot]' && (comment.body ?? '').includes(marker),
            )
        ) {
            reason = 'This workflow has already posted an advisory.';
        } else if (
            context.payload.issue?.comments !== undefined &&
            comments.length !== context.payload.issue.comments
        ) {
            reason = 'The discussion changed after this run was triggered.';
        }
    }
    const snapshot = createHash('sha256')
        .update(
            JSON.stringify({
                target,
                title: issue.title,
                body: issue.body ?? '',
                comments: comments.map((comment) => ({
                    id: comment.id,
                    body: comment.body,
                    author: comment.user?.login,
                    association: comment.author_association,
                    updated: comment.updated_at,
                })),
            }),
        )
        .digest('hex');
    return { target, reason, snapshot, externalSpam };
}

/**
 * Apply one classification to the triggering issue, using a trusted pre-inference
 * snapshot, fixed replies, and fresh checks before label/state changes.
 * Relevant reports stay open; incomplete reports enter the existing info-needed
 * lifecycle; only clearly unrelated reports are labeled as spam and closed.
 * Staged runs preview all actions without writing to GitHub. API failures propagate.
 */
async function applyModeration({ github, context, output, snapshot, staged = false }) {
    const items = Array.isArray(output?.items)
        ? output.items.filter((item) => item?.type === 'moderation_action')
        : [];
    if (items.length !== 1 || !classifications.includes(items[0].classification)) {
        throw new Error('Exactly one valid moderation classification is required.');
    }
    if (typeof snapshot !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot)) {
        throw new Error('A trusted pre-inference issue snapshot is required.');
    }
    const classification = items[0].classification;
    let ownCommentId;
    const check = async (appliedLabels = []) => {
        const current = await inspectIssue({ github, context, ownCommentId, appliedLabels });
        if (!current.reason && current.snapshot !== snapshot) {
            current.reason = 'The issue or discussion changed after classification started.';
        }
        return current;
    };
    const current = await check();
    if (current.reason) {
        return { status: 'skipped', reason: current.reason };
    }
    const { target } = current;
    const runUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
    const body =
        classification === 'relevant'
            ? undefined
            : [
                  replies[classification],
                  '',
                  `_Automated issue moderation (${classification}). [Workflow run](${runUrl})._`,
                  '',
                  marker,
              ].join('\n');
    const action =
        classification === 'unrelated'
            ? 'Post the fixed reply, apply ~spam, and close as not planned.'
            : classification === 'needs-info'
              ? 'Post the fixed reply and apply info-needed and triage-needed; leave the issue open.'
              : 'Leave the issue open without a reply.';
    if (staged) {
        return {
            status: 'skipped',
            reason: `Staged preview: ${action}${current.externalSpam && classification !== 'unrelated' ? ' Remove the external classifier spam label.' : ''}`,
            body,
        };
    }
    if (classification === 'relevant') {
        if (current.externalSpam) {
            await github.rest.issues.removeLabel({ ...target, name: '~spam' });
            return { status: 'success', reason: 'Removed the external spam flag; the report remains open without a reply.' };
        }
        return { status: 'skipped', reason: 'The report is relevant or uncertain; it remains open without a reply.' };
    }
    const { data: comment } = await github.rest.issues.createComment({ ...target, body });
    ownCommentId = comment.id;
    const afterReply = await check();
    if (afterReply.reason) {
        return { status: 'skipped', reason: `A reply was posted, but no further action was taken: ${afterReply.reason}` };
    }
    if (classification === 'needs-info' && afterReply.externalSpam) {
        await github.rest.issues.removeLabel({ ...target, name: '~spam' });
    }
    const labels = classification === 'unrelated' ? ['~spam'] : ['info-needed', 'triage-needed'];
    await github.rest.issues.addLabels({ ...target, labels });
    if (classification === 'unrelated') {
        const beforeClose = await check(labels);
        if (beforeClose.reason) {
            return { status: 'skipped', reason: `A reply and label were added, but closure was skipped: ${beforeClose.reason}` };
        }
        await github.rest.issues.update({ ...target, state: 'closed', state_reason: 'not_planned' });
    }
    return { status: 'success', reason: action, url: comment.html_url };
}

module.exports = { inspectIssue, applyModeration };
