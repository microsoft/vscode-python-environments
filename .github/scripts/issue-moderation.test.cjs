// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { inspectIssue, planFollowups, applyModeration } = require('./issue-moderation.cjs');

const central = { login: 'vs-code-engineering[bot]', type: 'Bot' };
const human = { login: 'reporter', type: 'User' };
const automation = { login: 'github-actions[bot]', type: 'Bot' };
const reviewLabel = 'moderation-review-needed';

async function fixture(flag = '~spam') {
    const now = Date.now();
    const before = new Date(now - 120000).toISOString();
    const flagged = new Date(now - 60000).toISOString();
    const after = new Date(now - 1000).toISOString();
    const issue = {
        number: 42, title: 'qwerty', body: '', state: 'open', locked: false,
        labels: [{ name: flag }], assignees: [],
    };
    const events = [{ id: 301, event: 'labeled', label: { name: flag }, actor: central, created_at: flagged }];
    const comments = [];
    const writes = [];
    const reads = [];
    const context = {
        repo: { owner: 'example', repo: 'python-environments' },
        payload: {}, eventName: 'workflow_dispatch', serverUrl: 'https://github.com', runId: 123,
    };
    const github = {
        rest: { issues: {
            get: async (target) => {
                reads.push(target);
                return { data: structuredClone(issue) };
            },
            listComments: Symbol('listComments'),
            listEventsForTimeline: Symbol('listEventsForTimeline'),
            listForRepo: async ({ labels }) => ({ data: issue.labels.some((label) => label.name === labels) ? [issue] : [] }),
            getLabel: async () => ({ data: { name: reviewLabel } }),
            createLabel: async (request) => { writes.push({ operation: 'create-label', ...request }); },
            createComment: async (request) => {
                writes.push({ operation: 'comment', ...request });
                const comment = {
                    id: 1001, user: automation, author_association: 'NONE', body: request.body,
                    created_at: after, html_url: 'https://github.com/example/python-environments/issues/42#issuecomment-1',
                };
                comments.push(comment);
                return { data: comment };
            },
            addLabels: async (request) => {
                writes.push({ operation: 'label', ...request });
                for (const name of request.labels) {
                    if (!issue.labels.some((label) => label.name === name)) issue.labels.push({ name });
                }
            },
            update: async (request) => {
                writes.push({ operation: 'close', ...request });
                issue.state = request.state;
                issue.state_reason = request.state_reason;
            },
        } },
        paginate: async (method, options) => {
            assert.equal(options.per_page, 100);
            if (method === github.rest.issues.listComments) return structuredClone(comments);
            assert.equal(method, github.rest.issues.listEventsForTimeline);
            return structuredClone(events);
        },
    };
    const f = { github, context, issue, events, comments, writes, reads, issueNumber: 42, now, before, flagged, after };
    const current = await inspectIssue(f);
    f.snapshot = current.snapshot;
    f.flagEventId = current.flagEventId;
    return f;
}

function output(classification) {
    return { items: [{ type: 'moderation_action', classification }] };
}

test('only clear junk from a verified spam flag closes, without rewriting central labels', async () => {
    const f = await fixture();
    const result = await applyModeration({
        ...f, output: { items: [{ ...output('unrelated').items[0], body: 'Injected reply', issue_number: 999 }] },
    });
    assert.equal(result.status, 'success');
    assert.deepEqual(f.writes.map((write) => write.operation), ['comment', 'close']);
    for (const write of f.writes) {
        assert.equal(write.issue_number, 42);
        assert.equal(write.owner, 'example');
        assert.equal(write.repo, 'python-environments');
    }
    assert.equal(f.issue.state, 'closed');
    assert.equal(f.issue.state_reason, 'not_planned');
    assert.deepEqual(f.issue.labels, [{ name: '~spam' }]);
    assert.match(f.writes[0].body, /Thanks for reaching out/);
    assert.match(f.writes[0].body, /<!-- gh-aw-workflow-id: issue-moderation -->/);
    assert.match(f.writes[0].body, /actions\/runs\/123/);
    assert.doesNotMatch(f.writes[0].body, /Injected reply/);
});

test('incomplete spam and information candidates get a friendly request and only local info-needed', async () => {
    for (const flag of ['~spam', '~info-needed']) {
        const f = await fixture(flag);
        const result = await applyModeration({ ...f, output: output('needs-info') });
        assert.equal(result.status, 'success');
        assert.deepEqual(f.writes.map((write) => write.operation), ['comment', 'label']);
        assert.deepEqual(f.writes[1].labels, ['info-needed']);
        assert.equal(f.issue.state, 'open');
        assert.ok(f.issue.labels.some((label) => label.name === flag));
        assert.match(f.writes[0].body, /fill out the issue template/);
        assert.match(f.writes[0].body, /more information would help us investigate/);
        assert.doesNotMatch(f.writes[0].body, /extension versions|no need to open a new issue/);
    }
});

test('an information flag cannot authorize closure even if the model requests it', async () => {
    const f = await fixture('~info-needed');
    await assert.rejects(applyModeration({ ...f, output: output('unrelated') }), /cannot authorize closure/);
    assert.equal(f.writes.length, 0);
    assert.equal(f.issue.state, 'open');
});

test('relevant and conflicting flags go to a human queue, with no public reply or closure', async () => {
    for (const conflict of [false, true]) {
        const f = await fixture();
        if (conflict) {
            f.issue.labels.push({ name: '~info-needed' });
            f.events.push({ id: 302, event: 'labeled', label: { name: '~info-needed' }, actor: central, created_at: f.after });
            Object.assign(f, await inspectIssue({ ...f, flagEventId: undefined }));
        }
        const result = await applyModeration({ ...f, output: output(conflict ? 'unrelated' : 'relevant') });
        assert.equal(result.status, 'success');
        assert.deepEqual(f.writes.map((write) => write.operation), ['label']);
        assert.deepEqual(f.writes[0].labels, [reviewLabel]);
        assert.equal(f.issue.state, 'open');
        assert.ok(f.issue.labels.some((label) => label.name === '~spam'));
        assert.ok((await inspectIssue(f)).reason);
    }
});

test('staged mode previews every outcome without creating labels, comments, or closures', async () => {
    for (const classification of ['unrelated', 'needs-info', 'relevant']) {
        const f = await fixture();
        const result = await applyModeration({ ...f, output: output(classification), staged: true });
        assert.equal(result.status, 'skipped');
        assert.match(result.reason, /Staged preview/);
        assert.equal(f.writes.length, 0);
    }
});

test('unflagged, human-flagged, closed, locked, or already handled issues are not candidates', async () => {
    for (const change of [
        { labels: [] }, { state: 'closed' }, { locked: true }, { pull_request: {} },
        { labels: [{ name: '~spam' }, { name: 'info-needed' }] },
        { labels: [{ name: '~spam' }, { name: reviewLabel }] },
    ]) {
        const f = await fixture();
        Object.assign(f.issue, change);
        assert.ok((await inspectIssue(f)).reason);
        assert.equal((await applyModeration({ ...f, output: output('unrelated') })).status, 'skipped');
        assert.equal(f.writes.length, 0);
    }
    for (const actor of [human, { login: 'another[bot]', type: 'Bot' }, undefined]) {
        const f = await fixture();
        f.events[0].actor = actor;
        assert.ok((await inspectIssue(f)).reason);
    }
});

test('central assignments and area-label cleanup do not block or get overwritten by follow-up', async () => {
    const f = await fixture('~info-needed');
    f.issue.assignees = [{ login: 'area-owner' }];
    f.issue.labels.push({ name: 'area-terminal' });
    f.events.push(
        { event: 'assigned', assignee: { login: 'area-owner' }, actor: central, created_at: f.after },
        { event: 'labeled', label: { name: 'area-terminal' }, actor: central, created_at: f.after },
        { event: 'unlabeled', label: { name: 'triage-needed' }, actor: central, created_at: f.after },
    );
    assert.equal((await applyModeration({ ...f, output: output('needs-info') })).status, 'success');
    assert.deepEqual(f.issue.assignees, [{ login: 'area-owner' }]);
    assert.ok(f.issue.labels.some((label) => label.name === 'area-terminal'));
    assert.ok(!f.issue.labels.some((label) => label.name === 'triage-needed'));
});

test('human labels, assignments, and post-flag triage changes take precedence', async () => {
    for (const kind of ['label', 'assignment', 'removal']) {
        const f = await fixture();
        if (kind === 'label') {
            f.issue.labels.push({ name: 'bug' });
            f.events.push({ event: 'labeled', label: { name: 'bug' }, actor: human, created_at: f.before });
        } else if (kind === 'assignment') {
            f.issue.assignees.push({ login: 'area-owner' });
            f.events.push({ event: 'assigned', assignee: { login: 'area-owner' }, actor: human, created_at: f.before });
        } else {
            f.events.push({ event: 'unlabeled', label: { name: 'triage-needed' }, actor: human, created_at: f.after });
        }
        assert.equal((await applyModeration({ ...f, output: output('unrelated') })).status, 'skipped');
        assert.equal(f.writes.length, 0);
    }
});

test('human discussion is protected, including comments beyond page one and replies before review starts', async () => {
    for (const comment of [
        { user: human, author_association: 'MEMBER', created_at: '2000-01-01T00:00:00Z' },
        { user: human, author_association: 'NONE', created_at: new Date().toISOString() },
        { user: human, author_association: 'NONE', created_at: '2000-01-01T00:00:00Z', updated_at: new Date().toISOString() },
    ]) {
        const f = await fixture();
        f.comments.push(...Array.from({ length: 100 }, (_, id) => ({ id, user: central, body: 'Bot context.' })), comment);
        assert.equal((await applyModeration({ ...f, output: output('unrelated') })).status, 'skipped');
        assert.equal(f.writes.length, 0);
    }
});

test('bot translations and reporter comments predating a flag can be reviewed', async () => {
    const f = await fixture('~info-needed');
    f.comments.push(
        { id: 1, user: central, author_association: 'MEMBER', body: 'Translation', created_at: f.after },
        { id: 2, user: human, author_association: 'NONE', body: 'Original context', created_at: f.before },
    );
    f.snapshot = (await inspectIssue(f)).snapshot;
    assert.equal((await applyModeration({ ...f, output: output('needs-info') })).status, 'success');
});

test('prior bot responses prevent repeat replies and reclosure, but reporter-quoted markers do not spoof them', async () => {
    const f = await fixture();
    const body = '<!-- gh-aw-workflow-id: issue-moderation -->';
    f.comments.push({ id: 1, user: automation, body });
    assert.ok((await inspectIssue(f)).reason);
    f.comments[0] = { id: 1, user: human, author_association: 'NONE', body, created_at: f.before };
    f.snapshot = (await inspectIssue(f)).snapshot;
    assert.equal((await applyModeration({ ...f, output: output('unrelated') })).status, 'success');
});

test('the seven-day eligibility window and five-minute clock tolerance have exact boundaries', async () => {
    const f = await fixture();
    for (const [offset, eligible] of [
        [-7 * 86400000, true], [-7 * 86400000 - 1, false], [5 * 60000, true], [5 * 60000 + 1, false],
    ]) {
        f.events[0].created_at = new Date(f.now + offset).toISOString();
        assert.equal(!(await inspectIssue({ ...f, now: f.now })).reason, eligible);
    }
});

test('removed or superseded flags cannot authorize an old review', async () => {
    const f = await fixture();
    f.events.push({ id: 302, event: 'labeled', label: { name: '~spam' }, actor: central, created_at: f.after });
    assert.ok((await inspectIssue(f)).reason);
    f.events.pop();
    f.events.push({ id: 302, event: 'unlabeled', label: { name: '~spam' }, actor: central, created_at: f.after });
    assert.ok((await inspectIssue(f)).reason);
});

test('missing snapshots, invalid classifications, and invalid or cross-event targets cannot cause writes', async () => {
    const f = await fixture();
    for (const snapshot of [undefined, '', 'not-a-snapshot']) {
        await assert.rejects(applyModeration({ ...f, snapshot, output: output('unrelated') }), /trusted pre-inference/);
    }
    for (const invalid of [{}, { items: {} }, { items: [null] }, output('close-now'), {
        items: [output('unrelated').items[0], output('needs-info').items[0]],
    }]) {
        await assert.rejects(applyModeration({ ...f, output: invalid }), /one valid moderation classification/);
    }
    for (const issueNumber of [undefined, '', '0', '-1', '1.2', '1; injected', '9007199254740992']) {
        await assert.rejects(inspectIssue({ ...f, issueNumber }), /positive issue number/);
    }
    f.context.payload.issue = { number: 43 };
    await assert.rejects(inspectIssue(f), /does not match/);
    assert.equal(f.writes.length, 0);
});

test('manual review snapshots detect body and existing-comment edits with an unchanged comment count', async () => {
    for (const kind of ['body', 'comment']) {
        const f = await fixture();
        f.comments.push({ id: 1, user: human, author_association: 'NONE', body: 'Original', created_at: f.before });
        f.snapshot = (await inspectIssue(f)).snapshot;
        if (kind === 'body') f.issue.body = 'A real extension report.';
        else f.comments[0].body = 'Updated reproduction.';
        assert.equal((await applyModeration({ ...f, output: output('unrelated') })).status, 'skipped');
        assert.equal(f.writes.length, 0);
    }
});

test('new information arriving during reply publication prevents closure or information labeling', async () => {
    for (const classification of ['unrelated', 'needs-info']) {
        const f = await fixture();
        const post = f.github.rest.issues.createComment;
        f.github.rest.issues.createComment = async (request) => {
            const result = await post(request);
            f.comments.push({ id: 2, user: human, body: 'Here are the reproduction steps.', created_at: f.after });
            return result;
        };
        assert.equal((await applyModeration({ ...f, output: output(classification) })).status, 'skipped');
        assert.deepEqual(f.writes.map((write) => write.operation), ['comment']);
        assert.equal(f.issue.state, 'open');
    }
});

test('read and write failures propagate instead of claiming moderation succeeded', async () => {
    for (const operation of ['get', 'paginate', 'createComment', 'addLabels', 'update', 'getLabel']) {
        const f = await fixture();
        const fail = async () => { throw new Error('GitHub unavailable'); };
        if (operation === 'paginate') f.github.paginate = fail;
        else f.github.rest.issues[operation] = fail;
        const classification = operation === 'addLabels' ? 'needs-info' : operation === 'getLabel' ? 'relevant' : 'unrelated';
        await assert.rejects(applyModeration({ ...f, output: output(classification) }), /GitHub unavailable/);
        assert.equal(f.issue.state, 'open');
    }
});

test('review-label creation handles a concurrent creator but does not hide permission errors', async () => {
    const f = await fixture();
    let lookups = 0;
    f.github.rest.issues.getLabel = async () => {
        if (lookups++ === 0) throw Object.assign(new Error('Missing'), { status: 404 });
        return { data: { name: reviewLabel } };
    };
    f.github.rest.issues.createLabel = async () => { throw Object.assign(new Error('Already exists'), { status: 422 }); };
    assert.equal((await applyModeration({ ...f, output: output('relevant') })).status, 'success');
    const denied = await fixture();
    denied.github.rest.issues.getLabel = async () => { throw Object.assign(new Error('Denied'), { status: 403 }); };
    await assert.rejects(applyModeration({ ...denied, output: output('relevant') }), /Denied/);
    assert.equal(denied.writes.length, 0);
});

test('the router accepts only expected bot flag events and ignores opening, human flags, and unrelated labels', async () => {
    for (const [action, sender, name, accepted] of [
        ['labeled', central, '~spam', true], ['labeled', central, '~info-needed', true],
        ['opened', central, '~spam', false], ['labeled', human, '~spam', false],
        ['labeled', automation, '~spam', false], ['labeled', central, 'bug', false],
    ]) {
        const f = await fixture(name === '~info-needed' ? name : '~spam');
        f.context.eventName = 'issues';
        f.context.payload = { action, sender, label: { name }, issue: { number: 42 } };
        const result = await planFollowups(f);
        assert.equal(result.candidates.length > 0, accepted);
    }
});

test('manual and catch-up routing still require verified provenance and do not duplicate both source labels', async () => {
    const f = await fixture();
    f.context.payload.inputs = { issue_number: '42' };
    assert.deepEqual((await planFollowups(f)).candidates, [{ issue_number: '42', flag_event_id: '301' }]);
    f.events[0].actor = human;
    assert.equal((await planFollowups(f)).candidates.length, 0);
    f.events[0].actor = central;
    f.context.eventName = 'schedule';
    f.context.payload = {};
    f.issue.labels.push({ name: '~info-needed' });
    f.events.push({ id: 302, event: 'labeled', label: { name: '~info-needed' }, actor: central, created_at: f.after });
    assert.equal((await planFollowups(f)).candidates.length, 1);
});

test('catch-up caps dispatch at 20 and reports its 100-per-label scan boundary', async () => {
    const f = await fixture();
    f.context.eventName = 'schedule';
    f.github.rest.issues.listForRepo = async ({ labels, since, per_page }) => {
        assert.equal(per_page, 100);
        assert.equal(since, new Date(f.now - 7 * 86400000).toISOString());
        return { data: labels === '~spam' ? Array.from({ length: 100 }, (_, index) => ({ number: index + 1 })) : [] };
    };
    const result = await planFollowups(f);
    assert.equal(result.candidates.length, 20);
    assert.equal(result.truncated, true);
});
