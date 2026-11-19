// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { inspectIssue, applyModeration, clearInfoNeededOnEdit } = require('./issue-moderation.cjs');

const human = { id: 7, login: 'reporter', type: 'User' };
const automation = { login: 'github-actions[bot]', type: 'Bot' };
const central = { login: 'vs-code-engineering[bot]', type: 'Bot' };

async function fixture() {
    const issue = {
        number: 42, title: 'qwerty', body: '', state: 'open', locked: false, labels: [], assignees: [],
        user: human, updated_at: '2026-11-18T12:00:00Z',
    };
    const events = [];
    const comments = [];
    const writes = [];
    const descriptionEdit = { lastEditedAt: null, before: '', editor: human };
    const warnings = [];
    const waits = [];
    const context = {
        repo: { owner: 'example', repo: 'python-environments' },
        payload: { action: 'opened', issue: structuredClone(issue) },
        eventName: 'issues', serverUrl: 'https://github.com', runId: 123,
    };
    const github = {
        graphql: async (_query, variables) => {
            assert.deepEqual(variables, { owner: 'example', name: 'python-environments', number: 42 });
            return { repository: { issue: {
                body: issue.body,
                userContentEdits: { nodes: [
                    { diff: issue.body, editedAt: descriptionEdit.lastEditedAt, deletedAt: null,
                        editor: { databaseId: descriptionEdit.editor?.id } },
                    { diff: descriptionEdit.before === '' ? null : descriptionEdit.before, deletedAt: null },
                ] },
            } } };
        },
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
                    if (!issue.labels.some((label) => label.name === name)) {
                        issue.labels.push({ name });
                        events.push({ event: 'labeled', label: { name }, actor: automation, created_at: issue.updated_at });
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
        } },
        paginate: async (method, options) => {
            assert.equal(options.per_page, 100);
            if (method === github.rest.issues.listComments) return structuredClone(comments);
            assert.equal(method, github.rest.issues.listEventsForTimeline);
            return structuredClone(events);
        },
    };
    const f = {
        github, context, issue, events, comments, writes, descriptionEdit, warnings, waits, issueNumber: 42,
        core: { warning: (message) => warnings.push(message) },
        wait: async (milliseconds) => { waits.push(milliseconds); },
    };
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

function reporterEdit(f) {
    const from = f.issue.body;
    f.issue.body = 'Selecting conda works, but a new PowerShell terminal still uses system Python.';
    f.issue.updated_at = '2026-11-18T12:05:00Z';
    f.descriptionEdit.lastEditedAt = f.issue.updated_at;
    f.descriptionEdit.before = from;
    f.context.payload = {
        action: 'edited', issue: structuredClone(f.issue), sender: human, changes: { body: { from } },
    };
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

test('completing the requested template by editing removes only local info-needed without another review', async () => {
    const f = await fixture();
    botLabel(f, '~spam');
    botLabel(f, '~info-needed');
    await applyModeration({ ...f, output: output('needs-info') });
    reporterEdit(f);
    const result = await clearInfoNeededOnEdit(f);
    assert.equal(result.status, 'success');
    assert.equal(f.issue.state, 'open');
    assert.deepEqual(f.issue.labels.map((label) => label.name), ['~spam', '~info-needed']);
    assert.deepEqual(f.writes.map((write) => write.operation), ['comment', 'label', 'unlabel']);
    assert.equal(f.writes.at(-1).name, 'info-needed');
    assert.equal(f.writes.at(-1).issue_number, 42);
    assert.equal(f.comments.length, 1);
    assert.match((await inspectIssue(f)).reason, /Only newly opened/);
    assert.equal((await clearInfoNeededOnEdit(f)).status, 'skipped');
    assert.equal(f.writes.length, 3);
});

test('description cleanup requires a real nonempty body update by the human issue author', async () => {
    for (const change of ['title-only', 'whitespace', 'empty', 'another-user', 'bot', 'unknown-user', 'comment']) {
        const f = await fixture();
        await applyModeration({ ...f, output: output('needs-info') });
        reporterEdit(f);
        if (change === 'title-only') delete f.context.payload.changes.body;
        if (change === 'whitespace') f.context.payload.changes.body.from = `  ${f.issue.body}  `;
        if (change === 'empty') f.context.payload.issue.body = '';
        if (change === 'another-user') f.context.payload.sender = { ...human, id: 8 };
        if (change === 'bot') f.context.payload.sender = { ...human, type: 'Bot' };
        if (change === 'unknown-user') delete f.context.payload.sender;
        if (change === 'comment') f.context.eventName = 'issue_comment';
        assert.equal((await clearInfoNeededOnEdit(f)).status, 'skipped', change);
        assert.equal(f.writes.length, 2, change);
        assert.ok(f.issue.labels.some((label) => label.name === 'info-needed'), change);
    }
});

test('real title-only webhook payloads cannot acknowledge a description response', async () => {
    for (const change of ['never-edited', 'before-request', 'earlier-formatting-edit', 'same-second-formatting-edit']) {
        const f = await fixture();
        await applyModeration({ ...f, output: output('needs-info') });
        reporterEdit(f);
        if (change === 'never-edited') f.descriptionEdit.lastEditedAt = null;
        if (change === 'before-request') f.descriptionEdit.lastEditedAt = '2026-11-18T11:59:00Z';
        if (['earlier-formatting-edit', 'same-second-formatting-edit'].includes(change)) {
            if (change === 'earlier-formatting-edit') f.descriptionEdit.lastEditedAt = '2026-11-18T12:04:00Z';
            f.descriptionEdit.before = `\n\n${f.issue.body}\n`;
        }
        f.issue.title = 'Corrected issue title';
        f.context.payload.issue.title = f.issue.title;
        f.context.payload.changes = { body: { from: '' }, title: { from: 'qwerty' } };
        f.events.push({
            event: 'renamed', actor: human, created_at: f.issue.updated_at,
            rename: { from: 'qwerty', to: f.issue.title },
        });
        assert.equal((await clearInfoNeededOnEdit(f)).status, 'skipped', change);
        assert.equal(f.writes.length, 2, change);
        assert.ok(f.issue.labels.some((label) => label.name === 'info-needed'), change);
    }
});

test('body history can precede webhook updated_at without hiding intervening human handling', async () => {
    for (const interveningHuman of [false, true]) {
        const f = await fixture();
        await applyModeration({ ...f, output: output('needs-info') });
        reporterEdit(f);
        f.descriptionEdit.lastEditedAt = '2026-11-18T12:04:58Z';
        if (interveningHuman) {
            f.events.push({ event: 'commented', user: human, created_at: '2026-11-18T12:04:59Z' });
        }
        const result = await clearInfoNeededOnEdit(f);
        assert.equal(result.status, interveningHuman ? 'skipped' : 'success');
        assert.equal(f.writes.length, interveningHuman ? 2 : 3);
    }
});

test('description cleanup ignores blank-line formatting while preserving code indentation and contents', async () => {
    const cases = [
        ['## Steps\n\nSelect conda.\n\n## Result\n\nWrong interpreter.',
            '## Steps\n\n\nSelect conda.\n \t\n## Result\n\nWrong interpreter.', false],
        ['## Steps\r\n\r\nSelect conda.', '## Steps\n\nSelect conda.', false],
        ['Details\n\n```python\nif True:\n    print("ok")\n```\n\nResult',
            'Details\n\n\n```python\nif True:\n    print("ok")\n```\n\n\nResult', false],
        ['```python\nif True:\n    print("ok")\n```', '```python\nif True:\nprint("ok")\n```', true],
        ['```python\nvalue = """one\n\ntwo"""\n```', '```python\nvalue = """one\n\n\ntwo"""\n```', true],
        ['~~~~python\nvalue = """one\n\ntwo"""\n~~~~', '~~~~python\nvalue = """one\n\n\ntwo"""\n~~~~', true],
        ['    if True:\n        print("ok")', 'if True:\n        print("ok")', true],
        ['Code:\n\n    value = """one\n\n    two"""\n\nDone',
            'Code:\n\n    value = """one\n\n\n    two"""\n\nDone', true],
        ['- ```python\n  value = """one\n\n  two"""\n  ```',
            '- ```python\n  value = """one\n\n\n  two"""\n  ```', true],
        ['10. ```python\n    print("ok")\n    ```\n\nDone',
            '10. ```python\n    print("ok")\n    ```\n\n\nDone', false],
        ['-\t~~~python\n\tprint("ok")\n\t~~~\n\nDone',
            '-\t~~~python\n\tprint("ok")\n\t~~~\n\n\nDone', false],
        [' \tvalue = """one\n\n \ttwo"""', ' \tvalue = """one\n\n\n \ttwo"""', true],
    ];
    for (const [before, after, meaningful] of cases) {
        const f = await fixture();
        await applyModeration({ ...f, output: output('needs-info') });
        reporterEdit(f);
        f.issue.body = after;
        f.context.payload.issue.body = after;
        f.context.payload.changes.body.from = before;
        f.descriptionEdit.before = before;
        assert.equal((await clearInfoNeededOnEdit(f)).status, meaningful ? 'success' : 'skipped');
        assert.equal(f.issue.labels.some((label) => label.name === 'info-needed'), !meaningful);
    }
});

test('list continuation prose ignores blank lines without flattening code inside or after a list', async () => {
    const cases = [
        ['numbered list', '1. Steps\n\n    Select conda.\n\n    Open terminal.', false],
        ['bullet list', '- Steps\n\n    Select conda.\n\n    Open terminal.', false],
        ['wide marker', '10. Steps\n\n    Select conda.\n\n    Open terminal.', false],
        ['nested list', '1. Steps\n\n    - Reproduce\n\n        Select conda.\n\n        Open terminal.', false],
        ['tab padding', '1.\tSteps\n\n\tSelect conda.\n\n\tOpen terminal.', false],
        ['sibling lists', '1. Steps\n\n    Select conda.\n\n2. More\n\n    Select conda.\n\n    Open terminal.', false],
        ['list code', '1. Steps\n\n       value = """one\n\n       two"""', true],
        ['list code with tabs', '1.\tSteps\n\n\t\tvalue = """one\n\n\t\ttwo"""', true],
        ['code on marker line', '1.     value = """one\n\n       two"""', true],
        ['list fence', '1. Steps\n\n    ```python\n    value = """one\n\n    two"""\n    ```', true],
        ['list fence then prose', '1. Steps\n\n    ```python\n    print("ok")\n    ```\n\n    Select conda.\n\n    Open terminal.', false],
        ['code after list', '1. Steps\n\n    Select conda.\n\nOutside list.\n\n    value = """one\n\n    two"""', true],
        ['code after empty item', '1.\n\n    value = """one\n\n    two"""', true],
        ['code after empty nested item', '1. Steps\n\n    -\n\n        value = """one\n\n        two"""', true],
    ];
    for (const [name, before, meaningful] of cases) {
        const after = before.includes('"""one\n\n')
            ? before.replace('"""one\n\n', '"""one\n\n\n')
            : before.replace(/\n\n(?=[^\n]*$)/, '\n\n\n');
        assert.notEqual(before, after, name);
        const f = await fixture();
        await applyModeration({ ...f, output: output('needs-info') });
        reporterEdit(f);
        f.issue.body = after;
        f.context.payload.issue.body = after;
        f.context.payload.changes.body.from = before;
        f.descriptionEdit.before = before;
        assert.equal((await clearInfoNeededOnEdit(f)).status, meaningful ? 'success' : 'skipped', name);
        assert.equal(f.issue.labels.some((label) => label.name === 'info-needed'), !meaningful, name);
    }
});

test('description cleanup defers when body-edit metadata is missing or no longer matches', async () => {
    for (const change of ['missing-issue', 'missing-history', 'missing-before', 'body-mismatch',
        'different-before', 'different-editor', 'future-edit', 'invalid-time',
        'deleted-before', 'deleted-latest', 'missing-deletion-status']) {
        const f = await fixture();
        await applyModeration({ ...f, output: output('needs-info') });
        reporterEdit(f);
        const graphql = f.github.graphql;
        f.github.graphql = async (...args) => {
            const result = await graphql(...args);
            const description = result.repository.issue;
            if (change === 'missing-issue') result.repository.issue = null;
            if (change === 'missing-history') description.userContentEdits = null;
            if (change === 'missing-before') description.userContentEdits.nodes.pop();
            if (change === 'body-mismatch') description.body = 'A newer description.';
            if (change === 'different-before') description.userContentEdits.nodes[1].diff = 'A different previous body.';
            if (change === 'different-editor') description.userContentEdits.nodes[0].editor = { databaseId: 8 };
            if (change === 'future-edit') description.userContentEdits.nodes[0].editedAt = '2026-11-18T12:06:00Z';
            if (change === 'invalid-time') description.userContentEdits.nodes[0].editedAt = 'invalid';
            if (change === 'deleted-before') description.userContentEdits.nodes[1].deletedAt = '2026-11-18T12:04:59Z';
            if (change === 'deleted-latest') description.userContentEdits.nodes[0].deletedAt = '2026-11-18T12:06:00Z';
            if (change === 'missing-deletion-status') delete description.userContentEdits.nodes[1].deletedAt;
            return result;
        };
        assert.equal((await clearInfoNeededOnEdit(f)).status, 'skipped', change);
        assert.equal(f.writes.length, 2, change);
    }
});

test('description cleanup preserves closed, locked, pull-request and superseded responses', async () => {
    for (const change of ['closed', 'locked', 'pull-request', 'stale-body', 'changed-author', 'no-label']) {
        const f = await fixture();
        await applyModeration({ ...f, output: output('needs-info') });
        reporterEdit(f);
        if (change === 'closed') f.issue.state = 'closed';
        if (change === 'locked') f.issue.locked = true;
        if (change === 'pull-request') f.issue.pull_request = {};
        if (change === 'stale-body') f.issue.body = 'A newer edit.';
        if (change === 'changed-author') f.issue.user = { ...human, id: 8 };
        if (change === 'no-label') f.issue.labels = [];
        assert.equal((await clearInfoNeededOnEdit(f)).status, 'skipped', change);
        assert.equal(f.writes.length, 2, change);
    }
});

test('a queued author edit cannot clear an unverifiable or renewed information request', async () => {
    for (const change of ['missing-event', 'missing-time', 'same-second', 'new-label', 'new-human-request']) {
        const f = await fixture();
        await applyModeration({ ...f, output: output('needs-info') });
        reporterEdit(f);
        if (change === 'missing-event') f.events.length = 0;
        if (change === 'missing-time') delete f.events[0].created_at;
        if (change === 'same-second') f.events[0].created_at = f.issue.updated_at;
        if (change === 'new-label') {
            f.events.push({
                event: 'labeled', label: { name: 'info-needed' }, actor: human, created_at: '2026-11-18T12:06:00Z',
            });
        }
        if (change === 'new-human-request') {
            f.events.push({ event: 'commented', user: human, created_at: '2026-11-18T12:06:00Z' });
        }
        assert.equal((await clearInfoNeededOnEdit(f)).status, 'skipped', change);
        assert.equal(f.writes.length, 2, change);
    }
});

test('unrelated bot metadata after an author response does not prevent description cleanup', async () => {
    const f = await fixture();
    await applyModeration({ ...f, output: output('needs-info') });
    reporterEdit(f);
    f.events.push({ event: 'commented', user: central, created_at: '2026-11-18T12:06:00Z' });
    botLabel(f, 'area-terminal');
    f.issue.updated_at = '2026-11-18T12:06:00Z';
    assert.equal((await clearInfoNeededOnEdit(f)).status, 'success');
    assert.deepEqual(f.issue.labels.map((label) => label.name), ['area-terminal']);
});

test('a title change belonging to the same response does not veto its body update, but later human changes do', async () => {
    for (const change of ['same-edit', 'split-body-event', 'later-rename', 'another-person', 'different-title']) {
        const f = await fixture();
        await applyModeration({ ...f, output: output('needs-info') });
        const oldTitle = f.issue.title;
        reporterEdit(f);
        f.issue.title = 'New terminals use the wrong Python after selecting conda';
        f.context.payload.issue.title = f.issue.title;
        f.context.payload.changes.title = { from: oldTitle };
        const renamed = {
            event: 'renamed', actor: human, created_at: f.issue.updated_at,
            rename: { from: oldTitle, to: f.issue.title },
        };
        if (change === 'split-body-event') delete f.context.payload.changes.title;
        if (change === 'later-rename') renamed.created_at = '2026-11-18T12:06:00Z';
        if (change === 'another-person') renamed.actor = { ...human, id: 8 };
        if (change === 'different-title') renamed.rename.to = 'A separate edit';
        f.events.push(renamed);
        const result = await clearInfoNeededOnEdit(f);
        const sameEdit = ['same-edit', 'split-body-event'].includes(change);
        assert.equal(result.status, sameEdit ? 'success' : 'skipped', change);
        assert.equal(f.writes.length, sameEdit ? 3 : 2, change);
    }
});

test('passive subscriptions and mentions after an edit are not mistaken for renewed human requests', async () => {
    const f = await fixture();
    await applyModeration({ ...f, output: output('needs-info') });
    reporterEdit(f);
    f.events.push(
        { event: 'subscribed', actor: human, created_at: f.issue.updated_at },
        { event: 'mentioned', actor: human, created_at: f.issue.updated_at },
    );
    assert.equal((await clearInfoNeededOnEdit(f)).status, 'success');
    assert.deepEqual(f.issue.labels, []);
});

test('description cleanup rechecks intervening changes and propagates API failures', async () => {
    for (const operation of ['get', 'graphql', 'paginate', 'removeLabel', 'intervening-change']) {
        const f = await fixture();
        await applyModeration({ ...f, output: output('needs-info') });
        reporterEdit(f);
        const fail = async () => { throw new Error('GitHub unavailable'); };
        if (operation === 'get') f.github.rest.issues.get = fail;
        if (operation === 'graphql') f.github.graphql = fail;
        if (operation === 'paginate') f.github.paginate = fail;
        if (operation === 'removeLabel') f.github.rest.issues.removeLabel = fail;
        if (operation === 'intervening-change') {
            const paginate = f.github.paginate;
            f.github.paginate = async (...args) => {
                const events = await paginate(...args);
                f.issue.updated_at = '2026-11-18T12:07:00Z';
                return events;
            };
            assert.equal((await clearInfoNeededOnEdit(f)).status, 'skipped');
        } else {
            await assert.rejects(clearInfoNeededOnEdit(f), /GitHub unavailable/);
        }
        assert.equal(f.writes.length, 2);
    }
});

test('transient description cleanup failures retry the whole guarded operation with bounded backoff', async () => {
    for (const operation of ['get', 'graphql', 'paginate', 'removeLabel']) {
        const f = await fixture();
        await applyModeration({ ...f, output: output('needs-info') });
        reporterEdit(f);
        const owner = ['graphql', 'paginate'].includes(operation) ? f.github : f.github.rest.issues;
        const original = owner[operation];
        let calls = 0;
        owner[operation] = async (...args) => {
            if (++calls < 3) throw Object.assign(new Error('GitHub unavailable'), { status: 500 });
            return original(...args);
        };
        assert.equal((await clearInfoNeededOnEdit(f)).status, 'success', operation);
        assert.deepEqual(f.waits, [1000, 2000], operation);
        assert.equal(f.warnings.length, 2, operation);
        assert.equal(f.writes.filter((write) => write.operation === 'unlabel').length, 1, operation);
    }
});

test('retrying label removal preserves renewed requests, human handling, and changed descriptions', async () => {
    for (const change of ['renewed-request', 'human-comment', 'body-edit', 'closed', 'locked', 'already-removed']) {
        const f = await fixture();
        await applyModeration({ ...f, output: output('needs-info') });
        reporterEdit(f);
        let deletions = 0;
        f.github.rest.issues.removeLabel = async () => {
            deletions++;
            throw Object.assign(new Error('GitHub unavailable'), { status: 502 });
        };
        f.wait = async () => {
            if (change === 'renewed-request') {
                f.events.push({
                    event: 'labeled', label: { name: 'info-needed' }, actor: human, created_at: '2026-11-18T12:06:00Z',
                });
            }
            if (change === 'human-comment') {
                f.events.push({ event: 'commented', user: human, created_at: '2026-11-18T12:06:00Z' });
            }
            if (change === 'body-edit') f.issue.body = 'A newer description.';
            if (change === 'closed') f.issue.state = 'closed';
            if (change === 'locked') f.issue.locked = true;
            if (change === 'already-removed') f.issue.labels = [];
        };
        assert.equal((await clearInfoNeededOnEdit(f)).status, 'skipped', change);
        assert.equal(deletions, 1, change);
        assert.equal(f.writes.length, 2, change);
    }
});

test('a DELETE that completed despite an HTTP 500 is not issued again', async () => {
    const f = await fixture();
    await applyModeration({ ...f, output: output('needs-info') });
    reporterEdit(f);
    const remove = f.github.rest.issues.removeLabel;
    let deletions = 0;
    f.github.rest.issues.removeLabel = async (...args) => {
        deletions++;
        await remove(...args);
        throw Object.assign(new Error('Response lost after deletion'), { status: 500 });
    };
    assert.equal((await clearInfoNeededOnEdit(f)).status, 'skipped');
    assert.equal(deletions, 1);
    assert.equal(f.warnings.length, 1);
    assert.equal(f.issue.labels.some((label) => label.name === 'info-needed'), false);
});

test('cleanup retries only transient server failures and surfaces exhausted errors', async () => {
    for (const status of [400, 401, 403, 404, 422, 429, 500, 502, 503, 504]) {
        const f = await fixture();
        await applyModeration({ ...f, output: output('needs-info') });
        reporterEdit(f);
        let calls = 0;
        const error = Object.assign(new Error('GitHub unavailable'), { status });
        f.github.rest.issues.removeLabel = async () => { calls++; throw error; };
        await assert.rejects(clearInfoNeededOnEdit(f), (actual) => actual === error);
        const transient = [500, 502, 503, 504].includes(status);
        assert.equal(calls, transient ? 3 : 1, String(status));
        assert.equal(f.warnings.length, transient ? 2 : 0, String(status));
        assert.equal(f.writes.length, 2, String(status));
    }
});
