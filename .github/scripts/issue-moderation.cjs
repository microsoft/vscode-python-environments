// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const marker = '<!-- gh-aw-workflow-id: issue-moderation -->';
const classifications = ['unrelated', 'needs-info', 'relevant'];
const maintainerAssociations = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const replies = {
    unrelated:
        "Thanks for reaching out! This tracker is for bugs and feature requests about the Python Environments extension for VS Code. We couldn't identify one in this report. If you're reporting an extension issue, please describe what happened and what you expected so we can help.",
    'needs-info':
        'Thanks for the report! Please fill out the issue template in this existing issue. For a bug report, include the Python Environments and Python extension versions, VS Code and Python versions, relevant Python Environments logs, steps to reproduce, and expected versus actual behavior. These details help us investigate. Please update this issue rather than opening a duplicate.',
};

function getTarget(context) {
    const number = context.payload.issue?.number ?? context.payload.inputs?.issue_number;
    if (!/^[1-9]\d*$/.test(String(number)) || !Number.isSafeInteger(Number(number))) {
        throw new Error('An issue event or a positive issue_number input is required.');
    }
    return { ...context.repo, issue_number: Number(number) };
}

/**
 * Read the triggering issue and all comments, returning an ineligibility reason
 * when it is already handled, changed, or protected by maintainer activity.
 * GitHub API errors propagate instead of allowing an unchecked publication.
 */
async function inspectIssue({ github, context }) {
    const target = getTarget(context);
    const { data: issue } = await github.rest.issues.get(target);
    if (issue.pull_request) {
        throw new Error('Issue moderation cannot target a pull request.');
    }
    let reason;
    if (issue.state !== 'open' || issue.locked) {
        reason = 'The issue is closed or locked.';
    } else if (issue.assignees.length || issue.labels.some((label) => label.name !== 'triage-needed')) {
        reason = 'The issue is assigned or already labeled for triage.';
    } else if (
        context.payload.issue &&
        (issue.title !== context.payload.issue.title || (issue.body ?? '') !== (context.payload.issue.body ?? ''))
    ) {
        reason = 'The issue was edited after this run was triggered.';
    } else {
        const comments = await github.paginate(github.rest.issues.listComments, { ...target, per_page: 100 });
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
    return { target, reason };
}

/**
 * Validate the model's single classification and publish a fixed advisory on
 * the triggering issue only. Recheck eligibility just before publication.
 * Staged runs return the proposed body without making a GitHub write.
 */
async function publishAdvisory({ github, context, output, staged = false }) {
    const items = Array.isArray(output?.items)
        ? output.items.filter((item) => item?.type === 'moderation_advisory')
        : [];
    if (items.length !== 1 || !classifications.includes(items[0].classification)) {
        throw new Error('Exactly one valid moderation classification is required.');
    }
    const classification = items[0].classification;
    if (classification === 'relevant') {
        return { status: 'skipped', reason: 'The report is relevant or uncertain; normal triage is unchanged.' };
    }
    const { target, reason } = await inspectIssue({ github, context });
    if (reason) {
        return { status: 'skipped', reason };
    }
    const runUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
    const body = [
        replies[classification],
        '',
        `_Automated advisory (${classification}); no labels or issue state were changed. [Workflow run](${runUrl})._`,
        '',
        marker,
    ].join('\n');
    if (staged) {
        return { status: 'skipped', reason: 'Staged preview; no comment was posted.', body };
    }
    const { data: comment } = await github.rest.issues.createComment({ ...target, body });
    return { status: 'success', reason: `Posted a ${classification} advisory.`, url: comment.html_url };
}

module.exports = { inspectIssue, publishAdvisory };
