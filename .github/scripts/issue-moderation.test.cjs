// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { inspectIssue, applyModeration } = require('./issue-moderation.cjs');

async function fixture() {
    const issue = {
        number: 42,
        title: 'qwerty',
        body: '',
        state: 'open',
        locked: false,
        labels: [{ name: 'triage-needed' }],
        assignees: [],
        comments: 0,
    };
    const comments = [];
    const events = [];
    const writes = [];
    const context = {
        repo: { owner: 'example', repo: 'python-environments' },
        payload: { issue: structuredClone(issue) },
        serverUrl: 'https://github.com',
        runId: 123,
    };
    const github = {
        rest: {
            issues: {
                get: async () => ({ data: structuredClone(issue) }),
                listComments: Symbol('listComments'),
                listEventsForTimeline: Symbol('listEventsForTimeline'),
                createComment: async (request) => {
                    writes.push({ operation: 'comment', ...request });
                    const comment = {
                        id: 1001,
                        user: { login: 'github-actions[bot]' },
                        author_association: 'NONE',
                        body: request.body,
                        html_url: 'https://github.com/example/python-environments/issues/42#issuecomment-1',
                    };
                    comments.push(comment);
                    return { data: comment };
                },
                addLabels: async (request) => {
                    writes.push({ operation: 'label', ...request });
                    for (const name of request.labels) {
                        if (!issue.labels.some((label) => label.name === name)) {
                            issue.labels.push({ name });
                            events.push({
                                event: 'labeled',
                                label: { name },
                                actor: { login: 'github-actions[bot]' },
                            });
                        }
                    }
                },
                removeLabel: async (request) => {
                    writes.push({ operation: 'unlabel', ...request });
                    issue.labels = issue.labels.filter((label) => label.name !== request.name);
                },
                update: async (request) => {
                    writes.push({ operation: 'close', ...request });
                    issue.state = request.state;
                    issue.state_reason = request.state_reason;
                },
            },
        },
        paginate: async (method, options) => {
            assert.equal(options.per_page, 100);
            if (method === github.rest.issues.listComments) {
                return structuredClone(comments);
            }
            assert.equal(method, github.rest.issues.listEventsForTimeline);
            return structuredClone(events);
        },
    };
    const f = { github, context, issue, comments, events, writes };
    f.snapshot = (await inspectIssue(f)).snapshot;
    return f;
}

function output(classification) {
    return { items: [{ type: 'moderation_action', classification }] };
}

function externalSpam(f) {
    f.issue.labels.push({ name: '~spam' });
    f.events.push({
        event: 'labeled',
        label: { name: '~spam' },
        actor: { login: 'vs-code-engineering[bot]' },
    });
}

test('binds fixed replies and moderation writes to the triggering issue, ignoring model-supplied text and target', async () => {
    for (const classification of ['unrelated', 'needs-info']) {
        const f = await fixture();
        const result = await applyModeration({
            ...f,
            output: { items: [{ ...output(classification).items[0], body: 'Injected reply', issue_number: 999 }] },
        });
        assert.equal(result.status, 'success');
        for (const write of f.writes) {
            assert.equal(write.issue_number, 42);
            assert.equal(write.owner, 'example');
            assert.equal(write.repo, 'python-environments');
        }
        assert.match(f.writes[0].body, /Thanks for/);
        assert.match(f.writes[0].body, /<!-- gh-aw-workflow-id: issue-moderation -->/);
        assert.match(f.writes[0].body, /https:\/\/github.com\/example\/python-environments\/actions\/runs\/123/);
        assert.doesNotMatch(f.writes[0].body, /Injected reply/);
        assert.match(result.url, /#issuecomment-1$/);
        if (classification === 'needs-info') {
            assert.match(f.writes[0].body, /fill out the issue template/);
            assert.match(f.writes[0].body, /more information would help us investigate/);
            assert.doesNotMatch(f.writes[0].body, /extension versions|VS Code and Python versions|no need to open a new issue/);
            assert.deepEqual(f.writes.map((write) => write.operation), ['comment', 'label']);
            assert.deepEqual(f.writes[1].labels, ['info-needed', 'triage-needed']);
            assert.equal(f.issue.state, 'open');
        } else {
            assert.deepEqual(f.writes.map((write) => write.operation), ['comment', 'label', 'close']);
            assert.deepEqual(f.writes[1].labels, ['~spam']);
            assert.equal(f.issue.state, 'closed');
            assert.equal(f.issue.state_reason, 'not_planned');
        }
    }
});

test('leaves relevant or uncertain reports untouched', async () => {
    const f = await fixture();
    const result = await applyModeration({ ...f, output: output('relevant') });
    assert.equal(result.status, 'skipped');
    assert.equal(f.writes.length, 0);
});

test('previews comments, labels, and closure in staged mode without writes', async () => {
    for (const classification of ['unrelated', 'needs-info', 'relevant']) {
        const f = await fixture();
        const result = await applyModeration({ ...f, output: output(classification), staged: true });
        assert.equal(result.status, 'skipped');
        assert.match(result.reason, /Staged preview/);
        assert.equal(f.writes.length, 0);
        assert.equal(f.issue.state, 'open');
    }
});

test('skips closed, locked, assigned, labeled, and edited issues before publication', async () => {
    for (const change of [
        { state: 'closed' },
        { locked: true },
        { assignees: [{ login: 'maintainer' }] },
        { labels: [{ name: 'info-needed' }] },
        { labels: [{ name: '~spam' }] },
        { title: 'A new title' },
        { body: 'The reporter added a real description.' },
    ]) {
        const f = await fixture();
        Object.assign(f.issue, change);
        assert.ok((await inspectIssue(f)).reason);
        assert.equal((await applyModeration({ ...f, output: output('unrelated') })).status, 'skipped');
        assert.equal(f.writes.length, 0);
    }
});

test('protects maintainer comments, including ones returned beyond the first page', async () => {
    for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
        const f = await fixture();
        f.comments.push(
            ...Array.from({ length: 100 }, () => ({ author_association: 'NONE' })),
            { author_association: association },
        );
        assert.equal((await applyModeration({ ...f, output: output('unrelated') })).status, 'skipped');
        assert.equal(f.writes.length, 0);
    }
});

test('does not repeat an authenticated workflow advisory on reruns or reopened issues', async () => {
    const f = await fixture();
    f.comments.push({
        user: { login: 'github-actions[bot]' },
        body: '<!-- gh-aw-workflow-id: issue-moderation -->',
        author_association: 'NONE',
    });
    assert.equal((await applyModeration({ ...f, output: output('unrelated') })).status, 'skipped');
    assert.equal(f.writes.length, 0);
});

test('does not treat a reporter quoting the workflow marker as a prior bot reply', async () => {
    const f = await fixture();
    f.comments.push({
        user: { login: 'reporter' },
        body: '<!-- gh-aw-workflow-id: issue-moderation -->',
        author_association: 'NONE',
    });
    f.context.payload.issue.comments = 1;
    f.snapshot = (await inspectIssue(f)).snapshot;
    assert.equal((await applyModeration({ ...f, output: output('unrelated') })).status, 'success');
});

test('does not ask for details after a reporter has added information since the triggering event', async () => {
    const f = await fixture();
    f.comments.push({
        user: { login: 'reporter' },
        body: 'Selecting the conda environment still uses system Python in a new terminal.',
        author_association: 'NONE',
    });
    assert.equal((await applyModeration({ ...f, output: output('needs-info') })).status, 'skipped');
    assert.equal(f.writes.length, 0);
});

test('validates manual issue inputs and rejects pull requests', async () => {
    const f = await fixture();
    f.context.payload = { inputs: { issue_number: '42' } };
    assert.equal((await inspectIssue(f)).target.issue_number, 42);
    for (const number of [undefined, '', '0', '-1', '1.2', '1; echo injected', '9007199254740992']) {
        f.context.payload = { inputs: { issue_number: number } };
        await assert.rejects(inspectIssue(f), /positive issue_number/);
    }
    f.context.payload = { inputs: { issue_number: '42' } };
    f.issue.pull_request = {};
    await assert.rejects(applyModeration({ ...f, output: output('unrelated') }), /cannot target a pull request/);
    assert.equal(f.writes.length, 0);
});

test('rejects malformed or repeated classifications without writes', async () => {
    for (const invalid of [
        {},
        { items: {} },
        { items: [null] },
        { items: [] },
        output('spam-close-now'),
        { items: [output('unrelated').items[0], output('needs-info').items[0]] },
    ]) {
        const f = await fixture();
        await assert.rejects(applyModeration({ ...f, output: invalid }), /one valid moderation classification/);
        assert.equal(f.writes.length, 0);
    }
});

test('propagates read, reply, label, and closure failures without claiming completion', async () => {
    for (const operation of ['get', 'paginate', 'createComment', 'addLabels', 'update']) {
        const f = await fixture();
        const fail = async () => {
            throw new Error('GitHub unavailable');
        };
        if (operation === 'paginate') {
            f.github.paginate = fail;
        } else {
            f.github.rest.issues[operation] = fail;
        }
        await assert.rejects(applyModeration({ ...f, output: output('unrelated') }), /GitHub unavailable/);
        assert.equal(f.issue.state, 'open');
    }
});

test('independently reassesses only verified external spam flags and preserves human decisions', async () => {
    for (const classification of ['unrelated', 'needs-info', 'relevant']) {
        const f = await fixture();
        externalSpam(f);
        const result = await applyModeration({ ...f, output: output(classification) });
        assert.ok(result.reason);
        assert.equal(f.issue.state, classification === 'unrelated' ? 'closed' : 'open');
        assert.equal(f.issue.labels.some((label) => label.name === '~spam'), classification === 'unrelated');
        assert.equal(f.writes.some((write) => write.operation === 'comment'), classification !== 'relevant');
    }
    for (const actor of ['maintainer', 'some-other[bot]']) {
        const f = await fixture();
        externalSpam(f);
        f.events.push({ event: 'labeled', label: { name: '~spam' }, actor: { login: actor } });
        assert.equal((await applyModeration({ ...f, output: output('unrelated') })).status, 'skipped');
        assert.equal(f.writes.length, 0);
    }
});

test('requires a trusted snapshot and detects edits during manual assessment, including comment edits', async () => {
    const f = await fixture();
    for (const snapshot of [undefined, '', 'not-a-snapshot']) {
        await assert.rejects(applyModeration({ ...f, snapshot, output: output('unrelated') }), /trusted pre-inference/);
    }
    f.context.payload = { inputs: { issue_number: '42' } };
    f.comments.push({ id: 1, user: { login: 'reporter' }, body: 'A brief report.' });
    f.snapshot = (await inspectIssue(f)).snapshot;
    f.comments[0].body = 'A complete report with a reproduction.';
    assert.equal((await applyModeration({ ...f, output: output('unrelated') })).status, 'skipped');
    assert.equal(f.writes.length, 0);
});

test('does not label or close after new information arrives during reply publication', async () => {
    const f = await fixture();
    const post = f.github.rest.issues.createComment;
    f.github.rest.issues.createComment = async (request) => {
        const result = await post(request);
        f.comments.push({ id: 2, user: { login: 'reporter' }, body: 'Here are the reproduction steps.' });
        return result;
    };
    assert.equal((await applyModeration({ ...f, output: output('unrelated') })).status, 'skipped');
    assert.deepEqual(f.writes.map((write) => write.operation), ['comment']);
    assert.equal(f.issue.state, 'open');
});

test('does not close when a report changes after the spam label is applied', async () => {
    const f = await fixture();
    const label = f.github.rest.issues.addLabels;
    f.github.rest.issues.addLabels = async (request) => {
        await label(request);
        f.issue.body = 'This is a real conda activation issue.';
    };
    assert.equal((await applyModeration({ ...f, output: output('unrelated') })).status, 'skipped');
    assert.deepEqual(f.writes.map((write) => write.operation), ['comment', 'label']);
    assert.equal(f.issue.state, 'open');
});
