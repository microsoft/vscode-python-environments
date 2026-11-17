// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { inspectIssue, publishAdvisory } = require('./issue-moderation.cjs');

function fixture() {
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
    const writes = [];
    const context = {
        repo: { owner: 'example', repo: 'python-environments' },
        payload: { issue: { ...issue } },
        serverUrl: 'https://github.com',
        runId: 123,
    };
    const github = {
        rest: {
            issues: {
                get: async () => ({ data: issue }),
                listComments: Symbol('listComments'),
                createComment: async (request) => {
                    writes.push(request);
                    return { data: { html_url: 'https://github.com/example/python-environments/issues/42#issuecomment-1' } };
                },
            },
        },
        paginate: async (method, options) => {
            assert.equal(method, github.rest.issues.listComments);
            assert.equal(options.per_page, 100);
            return comments;
        },
    };
    return { github, context, issue, comments, writes };
}

function output(classification) {
    return { items: [{ type: 'moderation_advisory', classification }] };
}

test('posts a fixed reply on the triggering issue, ignoring model-supplied text and target', async () => {
    for (const classification of ['unrelated', 'needs-info']) {
        const f = fixture();
        const result = await publishAdvisory({
            ...f,
            output: { items: [{ ...output(classification).items[0], body: 'Injected reply', issue_number: 999 }] },
        });
        assert.equal(result.status, 'success');
        assert.equal(f.writes.length, 1);
        assert.equal(f.writes[0].issue_number, 42);
        assert.equal(f.writes[0].owner, 'example');
        assert.equal(f.writes[0].repo, 'python-environments');
        assert.match(f.writes[0].body, /Thanks for/);
        assert.match(f.writes[0].body, /<!-- gh-aw-workflow-id: issue-moderation -->/);
        assert.match(f.writes[0].body, /https:\/\/github.com\/example\/python-environments\/actions\/runs\/123/);
        assert.doesNotMatch(f.writes[0].body, /Injected reply/);
        assert.match(result.url, /#issuecomment-1$/);
        if (classification === 'needs-info') {
            assert.match(f.writes[0].body, /fill out the issue template in this existing issue/);
            assert.match(f.writes[0].body, /extension versions/);
            assert.match(f.writes[0].body, /Python Environments logs/);
            assert.match(f.writes[0].body, /steps to reproduce/);
            assert.match(f.writes[0].body, /expected versus actual behavior/);
        }
    }
});

test('leaves relevant or uncertain reports untouched', async () => {
    const f = fixture();
    const result = await publishAdvisory({ ...f, output: output('relevant') });
    assert.equal(result.status, 'skipped');
    assert.equal(f.writes.length, 0);
});

test('previews staged output without posting', async () => {
    const f = fixture();
    const result = await publishAdvisory({ ...f, output: output('unrelated'), staged: true });
    assert.equal(result.status, 'skipped');
    assert.match(result.body, /Thanks for reaching out/);
    assert.equal(f.writes.length, 0);
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
        const f = fixture();
        assert.equal((await inspectIssue(f)).reason, undefined);
        Object.assign(f.issue, change);
        assert.ok((await inspectIssue(f)).reason);
        assert.equal((await publishAdvisory({ ...f, output: output('unrelated') })).status, 'skipped');
        assert.equal(f.writes.length, 0);
    }
});

test('protects maintainer comments, including ones returned beyond the first page', async () => {
    for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
        const f = fixture();
        f.comments.push(
            ...Array.from({ length: 100 }, () => ({ author_association: 'NONE' })),
            { author_association: association },
        );
        assert.equal((await publishAdvisory({ ...f, output: output('unrelated') })).status, 'skipped');
        assert.equal(f.writes.length, 0);
    }
});

test('does not repeat an authenticated workflow advisory on reruns or reopened issues', async () => {
    const f = fixture();
    f.comments.push({
        user: { login: 'github-actions[bot]' },
        body: '<!-- gh-aw-workflow-id: issue-moderation -->',
        author_association: 'NONE',
    });
    assert.equal((await publishAdvisory({ ...f, output: output('unrelated') })).status, 'skipped');
    assert.equal(f.writes.length, 0);
});

test('does not treat a reporter quoting the workflow marker as a prior bot reply', async () => {
    const f = fixture();
    f.comments.push({
        user: { login: 'reporter' },
        body: '<!-- gh-aw-workflow-id: issue-moderation -->',
        author_association: 'NONE',
    });
    f.context.payload.issue.comments = 1;
    assert.equal((await publishAdvisory({ ...f, output: output('unrelated') })).status, 'success');
});

test('does not ask for details after a reporter has added information since the triggering event', async () => {
    const f = fixture();
    assert.equal((await inspectIssue(f)).reason, undefined);
    f.comments.push({
        user: { login: 'reporter' },
        body: 'Selecting the conda environment still uses system Python in a new terminal.',
        author_association: 'NONE',
    });
    assert.equal((await publishAdvisory({ ...f, output: output('needs-info') })).status, 'skipped');
    assert.equal(f.writes.length, 0);
});

test('validates manual issue inputs and rejects pull requests', async () => {
    const f = fixture();
    f.context.payload = { inputs: { issue_number: '42' } };
    assert.equal((await inspectIssue(f)).target.issue_number, 42);
    for (const number of [undefined, '', '0', '-1', '1.2', '1; echo injected', '9007199254740992']) {
        f.context.payload = { inputs: { issue_number: number } };
        await assert.rejects(inspectIssue(f), /positive issue_number/);
    }
    f.context.payload = { inputs: { issue_number: '42' } };
    f.issue.pull_request = {};
    await assert.rejects(publishAdvisory({ ...f, output: output('unrelated') }), /cannot target a pull request/);
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
        const f = fixture();
        await assert.rejects(publishAdvisory({ ...f, output: invalid }), /one valid moderation classification/);
        assert.equal(f.writes.length, 0);
    }
});

test('propagates read, pagination, and publication failures', async () => {
    for (const operation of ['get', 'paginate', 'createComment']) {
        const f = fixture();
        const fail = async () => {
            throw new Error('GitHub unavailable');
        };
        if (operation === 'paginate') {
            f.github.paginate = fail;
        } else {
            f.github.rest.issues[operation] = fail;
        }
        await assert.rejects(publishAdvisory({ ...f, output: output('needs-info') }), /GitHub unavailable/);
        assert.equal(f.writes.length, 0);
    }
});
