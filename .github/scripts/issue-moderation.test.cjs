// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { inspectIssue, applyModeration } = require('./issue-moderation.cjs');

const human = { login: 'reporter', type: 'User' };
const automation = { login: 'github-actions[bot]', type: 'Bot' };
const central = { login: 'vs-code-engineering[bot]', type: 'Bot' };

async function fixture() {
    const issue = {
        number: 42, title: 'qwerty', body: '', state: 'open', locked: false, labels: [], assignees: [],
    };
    const events = [];
    const comments = [];
    const writes = [];
    const context = {
        repo: { owner: 'example', repo: 'python-environments' },
        payload: { action: 'opened', issue: structuredClone(issue) },
        eventName: 'issues', serverUrl: 'https://github.com', runId: 123,
    };
    const github = {
        rest: { issues: {
            get: async () => ({ data: structuredClone(issue) }),
            listComments: Symbol('listComments'),
            listEventsForTimeline: Symbol('listEventsForTimeline'),
            createComment: async (request) => {
                writes.push({ operation: 'comment', ...request });
                const comment = {
                    id: 1001, user: automation, body: request.body,
                    html_url: 'https://github.com/example/python-environments/issues/42#issuecomment-1',
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
    const f = { github, context, issue, events, comments, writes, issueNumber: 42 };
    f.snapshot = (await inspectIssue(f)).snapshot;
    return f;
}

function output(classification) {
    return { items: [{ type: 'moderation_action', classification }] };
}

function botLabel(f, name) {
    f.issue.labels.push({ name });
    f.events.push({ event: 'labeled', label: { name }, actor: central });
}

test('new unflagged junk gets a fixed polite reply and closure on its own issue only', async () => {
    const f = await fixture();
    const result = await applyModeration({
        ...f, output: { items: [{ ...output('unrelated').items[0], body: 'Injected reply', issue_number: 999, labels: ['bug'] }] },
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
    assert.deepEqual(f.issue.labels, []);
    assert.match(f.writes[0].body, /Thanks for reaching out/);
    assert.match(f.writes[0].body, /<!-- gh-aw-workflow-id: issue-moderation -->/);
    assert.match(f.writes[0].body, /actions\/runs\/123/);
    assert.doesNotMatch(f.writes[0].body, /Injected reply/);
});

test('an incomplete report gets a friendly request and only info-needed, without closure', async () => {
    const f = await fixture();
    const result = await applyModeration({ ...f, output: output('needs-info') });
    assert.equal(result.status, 'success');
    assert.deepEqual(f.writes.map((write) => write.operation), ['comment', 'label']);
    assert.deepEqual(f.writes[1].labels, ['info-needed']);
    assert.equal(f.issue.state, 'open');
    assert.match(f.writes[0].body, /fill out the issue template/);
    assert.match(f.writes[0].body, /more information would help us investigate/);
    assert.doesNotMatch(f.writes[0].body, /extension versions|no need to open a new issue/);
});

test('useful or uncertain reports stay completely untouched, without a review queue label', async () => {
    const f = await fixture();
    const result = await applyModeration({ ...f, output: output('relevant') });
    assert.equal(result.status, 'skipped');
    assert.equal(f.issue.state, 'open');
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.issue.labels, []);
});

test('central flags neither authorize nor veto any content judgment and are always preserved', async () => {
    for (const labels of [[], ['~spam'], ['~info-needed'], ['~spam', '~info-needed'], ['info-needed']]) {
        for (const classification of ['unrelated', 'needs-info', 'relevant']) {
            const f = await fixture();
            for (const label of labels) botLabel(f, label);
            const current = await inspectIssue(f);
            assert.equal(current.reason, undefined);
            assert.equal(current.snapshot, f.snapshot);
            assert.deepEqual(current.report, { title: f.issue.title, description: f.issue.body });
            await applyModeration({ ...f, output: output(classification) });
            assert.equal(f.issue.state, classification === 'unrelated' ? 'closed' : 'open');
            for (const name of labels) assert.ok(f.issue.labels.some((label) => label.name === name));
            assert.equal(f.writes.some((write) => write.operation === 'label'), classification === 'needs-info');
        }
    }
});

test('prepared model input contains content only, not account, labels, assignments, or bot judgments', async () => {
    const f = await fixture();
    botLabel(f, '~spam');
    f.issue.assignees = [{ login: 'area-owner' }];
    f.events.push({ event: 'assigned', assignee: { login: 'area-owner' }, actor: central });
    f.comments.push({ id: 1, user: central, body: 'This is definitely spam.' });
    const current = await inspectIssue(f);
    assert.equal(current.reason, undefined);
    assert.deepEqual(Object.keys(current.report).sort(), ['description', 'title']);
    assert.equal(current.snapshot, f.snapshot);
    assert.doesNotMatch(JSON.stringify(current.report), /~spam|area-owner|definitely spam/);
});

test('automated metadata changes during review do not invalidate content or get overwritten', async () => {
    const f = await fixture();
    botLabel(f, '~spam');
    botLabel(f, '~info-needed');
    botLabel(f, 'area-terminal');
    f.issue.assignees = [{ login: 'area-owner' }];
    f.events.push(
        { event: 'assigned', assignee: { login: 'area-owner' }, actor: central },
        { event: 'unlabeled', label: { name: 'triage-needed' }, actor: central },
    );
    f.comments.push({ id: 1, user: central, body: 'Automated translation and classification.' });
    assert.equal((await applyModeration({ ...f, output: output('needs-info') })).status, 'success');
    assert.deepEqual(f.issue.assignees, [{ login: 'area-owner' }]);
    assert.ok(f.issue.labels.some((label) => label.name === 'area-terminal'));
    assert.ok(!f.issue.labels.some((label) => label.name === 'triage-needed'));
});

test('initial template labels are neutral, but a later removal/reapplication is human triage', async () => {
    const f = await fixture();
    f.issue.labels = [{ name: 'bug' }];
    f.context.payload.issue.labels = structuredClone(f.issue.labels);
    f.events.push({ event: 'labeled', label: { name: 'bug' }, actor: human });
    assert.equal((await inspectIssue(f)).reason, undefined);
    f.events.push(
        { event: 'unlabeled', label: { name: 'bug' }, actor: human },
        { event: 'labeled', label: { name: 'bug' }, actor: human },
    );
    assert.ok((await inspectIssue(f)).reason);
});

test('human labels, assignments, and other manual state changes take precedence', async () => {
    for (const kind of ['label', 'assignment', 'removal', 'milestone', 'reopen']) {
        const f = await fixture();
        if (kind === 'label') {
            f.issue.labels.push({ name: '~spam' });
            f.events.push({ event: 'labeled', label: { name: '~spam' }, actor: human });
        } else if (kind === 'assignment') {
            f.issue.assignees.push({ login: 'area-owner' });
            f.events.push({ event: 'assigned', assignee: { login: 'area-owner' }, actor: human });
        } else {
            f.events.push({ event: { removal: 'unlabeled', milestone: 'milestoned', reopen: 'reopened' }[kind], actor: human });
        }
        assert.equal((await applyModeration({ ...f, output: output('unrelated') })).status, 'skipped');
        assert.equal(f.writes.length, 0);
    }
});

test('bot-only changes to a creation-time template label do not turn it into human triage', async () => {
    const f = await fixture();
    f.issue.labels = [{ name: 'bug' }];
    f.context.payload.issue.labels = structuredClone(f.issue.labels);
    f.events.push(
        { event: 'labeled', label: { name: 'bug' }, actor: human },
        { event: 'unlabeled', label: { name: 'bug' }, actor: central },
        { event: 'labeled', label: { name: 'bug' }, actor: central },
    );
    assert.equal((await inspectIssue(f)).reason, undefined);
    assert.equal((await applyModeration({ ...f, output: output('relevant') })).status, 'skipped');
    assert.deepEqual(f.writes, []);
});

test('unverifiable current labels or assignments do not permit unchecked moderation', async () => {
    for (const kind of ['label', 'assignment']) {
        const f = await fixture();
        if (kind === 'label') f.issue.labels = [{ name: 'bug' }];
        else f.issue.assignees = [{ login: 'area-owner' }];
        assert.ok((await inspectIssue(f)).reason);
        assert.equal((await applyModeration({ ...f, output: output('unrelated') })).status, 'skipped');
        assert.equal(f.writes.length, 0);
    }
});

test('human pins, projects, links and duplicate decisions block moderation while bot changes remain neutral', async () => {
    for (const event of ['pinned', 'unpinned', 'added_to_project', 'removed_from_project', 'moved_columns_in_project',
        'connected', 'disconnected', 'marked_as_duplicate', 'unmarked_as_duplicate']) {
        for (const actor of [human, central]) {
            const f = await fixture();
            f.events.push({ event, actor });
            const result = await applyModeration({ ...f, output: output('unrelated') });
            if (actor === human) {
                assert.equal(result.status, 'skipped');
                assert.deepEqual(f.writes, []);
                assert.equal(f.issue.state, 'open');
            } else {
                assert.equal(result.status, 'success');
                assert.equal(f.issue.state, 'closed');
            }
        }
    }
});

test('closed, locked, pull-request, reopened and labeled events are not automatically moderated', async () => {
    for (const change of [{ state: 'closed' }, { locked: true }, { pull_request: {} }]) {
        const f = await fixture();
        Object.assign(f.issue, change);
        assert.equal((await applyModeration({ ...f, output: output('unrelated') })).status, 'skipped');
        assert.equal(f.writes.length, 0);
    }
    for (const action of ['reopened', 'labeled', 'edited']) {
        const f = await fixture();
        f.context.payload.action = action;
        assert.ok((await inspectIssue(f)).reason);
    }
});

test('human discussion is protected, including comments beyond the first page', async () => {
    for (const user of [human, { login: 'maintainer', type: 'User' }, undefined]) {
        const f = await fixture();
        f.comments.push(...Array.from({ length: 100 }, (_, id) => ({ id, user: central, body: 'Bot context.' })),
            { id: 101, user, body: 'Additional details.' });
        assert.equal((await applyModeration({ ...f, output: output('unrelated') })).status, 'skipped');
        assert.equal(f.writes.length, 0);
    }
});

test('a prior authenticated response prevents another reply or reclosure after manual reopening', async () => {
    const f = await fixture();
    await applyModeration({ ...f, output: output('unrelated') });
    f.issue.state = 'open';
    f.context.eventName = 'workflow_dispatch';
    f.context.payload = { inputs: { issue_number: '42' } };
    assert.equal((await applyModeration({ ...f, output: output('unrelated') })).status, 'skipped');
    assert.deepEqual(f.writes.map((write) => write.operation), ['comment', 'close']);
});

test('a marker embedded in the issue body is untrusted data, not proof of a previous response', async () => {
    const f = await fixture();
    f.issue.body = '<!-- gh-aw-workflow-id: issue-moderation -->';
    f.context.payload.issue.body = f.issue.body;
    const current = await inspectIssue(f);
    assert.equal(current.reason, undefined);
    assert.equal((await applyModeration({ ...f, snapshot: current.snapshot, output: output('unrelated') })).status, 'success');
});

test('title or body edits after opening stop stale automatic review', async () => {
    for (const change of [{ title: 'A real report' }, { body: 'Complete reproduction details.' }]) {
        const f = await fixture();
        Object.assign(f.issue, change);
        assert.ok((await inspectIssue(f)).reason);
        assert.equal((await applyModeration({ ...f, output: output('unrelated') })).status, 'skipped');
        assert.equal(f.writes.length, 0);
    }
});

test('manual runs capture fresh content but still reject changes during inference', async () => {
    const f = await fixture();
    f.context.eventName = 'workflow_dispatch';
    f.context.payload = { inputs: { issue_number: '42' } };
    f.issue.body = 'Fresh current report.';
    const current = await inspectIssue(f);
    assert.equal(current.reason, undefined);
    assert.equal(current.report.description, f.issue.body);
    f.issue.body = 'New information while reviewing.';
    assert.equal((await applyModeration({ ...f, snapshot: current.snapshot, output: output('unrelated') })).status, 'skipped');
    assert.equal(f.writes.length, 0);
});

test('manual runs conservatively protect human labels without an original opening payload', async () => {
    const f = await fixture();
    f.issue.labels = [{ name: 'bug' }];
    f.context.payload.issue.labels = structuredClone(f.issue.labels);
    f.events.push({ event: 'labeled', label: { name: 'bug' }, actor: human });
    assert.equal((await inspectIssue(f)).reason, undefined);
    f.context.eventName = 'workflow_dispatch';
    f.context.payload = { inputs: { issue_number: '42' } };
    assert.equal((await applyModeration({ ...f, output: output('unrelated') })).status, 'skipped');
    assert.deepEqual(f.writes, []);
});

test('new human information during reply publication prevents remaining closure or labeling', async () => {
    for (const classification of ['unrelated', 'needs-info']) {
        const f = await fixture();
        const post = f.github.rest.issues.createComment;
        f.github.rest.issues.createComment = async (request) => {
            const result = await post(request);
            f.comments.push({ id: 2, user: human, body: 'Here are the reproduction steps.' });
            return result;
        };
        assert.equal((await applyModeration({ ...f, output: output(classification) })).status, 'skipped');
        assert.deepEqual(f.writes.map((write) => write.operation), ['comment']);
        assert.equal(f.issue.state, 'open');
    }
});

test('missing snapshots, malformed classifications and invalid/cross-event targets never write', async () => {
    const f = await fixture();
    for (const snapshot of [undefined, '', 'not-a-snapshot']) {
        await assert.rejects(applyModeration({ ...f, snapshot, output: output('unrelated') }), /trusted pre-inference/);
    }
    for (const invalid of [{}, { items: {} }, { items: [null] }, output('close-now'), {
        items: [output('unrelated').items[0], output('needs-info').items[0]],
    }]) {
        await assert.rejects(applyModeration({ ...f, output: invalid }), /one valid moderation classification/);
    }
    for (const issueNumber of ['', '0', '-1', '1.2', '1; injected', '9007199254740992']) {
        await assert.rejects(inspectIssue({ ...f, issueNumber }), /positive issue number/);
    }
    await assert.rejects(inspectIssue({ ...f, issueNumber: 43 }), /does not match/);
    f.context.eventName = 'workflow_dispatch';
    f.context.payload = { inputs: { issue_number: '' } };
    await assert.rejects(inspectIssue({ ...f, issueNumber: undefined }), /positive issue number/);
    assert.equal(f.writes.length, 0);
});

test('staged mode previews actions without changing issues, and normal reports remain no-ops', async () => {
    for (const classification of ['unrelated', 'needs-info', 'relevant']) {
        const f = await fixture();
        const result = await applyModeration({ ...f, output: output(classification), staged: true });
        assert.equal(result.status, 'skipped');
        if (classification !== 'relevant') assert.match(result.reason, /Staged preview/);
        assert.equal(f.writes.length, 0);
    }
});

test('API failures propagate rather than claiming successful moderation', async () => {
    for (const operation of ['get', 'paginate', 'createComment', 'addLabels', 'update']) {
        const f = await fixture();
        const fail = async () => { throw new Error('GitHub unavailable'); };
        if (operation === 'paginate') f.github.paginate = fail;
        else f.github.rest.issues[operation] = fail;
        const classification = operation === 'addLabels' ? 'needs-info' : 'unrelated';
        await assert.rejects(applyModeration({ ...f, output: output(classification) }), /GitHub unavailable/);
        assert.equal(f.issue.state, 'open');
    }
});
