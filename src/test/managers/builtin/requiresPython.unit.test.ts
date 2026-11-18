// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import { PythonEnvironment } from '../../../api';
import * as workspaceApis from '../../../common/workspace.apis';
import {
    chooseQuickCreateInterpreter,
    readRequiresPython,
    resolveProjectRequiresPython,
    selectInterpretersForRequiresPython,
} from '../../../managers/builtin/requiresPython';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

suite('requires-python for environment creation', () => {
    let root: string;

    setup(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'requires-python-'));
    });

    teardown(async () => {
        sinon.restore();
        await fs.remove(root);
    });

    function interpreter(version: string): PythonEnvironment {
        return createMockPythonEnvironment({
            name: `Python ${version}`,
            envPath: path.join(root, 'interpreters', version, 'python'),
            version,
        });
    }

    async function writePyproject(directory: string, requiresPython?: string): Promise<string> {
        const specifier = requiresPython === undefined ? '' : `\nrequires-python = "${requiresPython}"`;
        const fsPath = path.join(directory, 'pyproject.toml');
        await fs.outputFile(fsPath, `[project]\nname = "demo"\nversion = "0.0.1"${specifier}\n`);
        return fsPath;
    }

    test('reads a trimmed requires-python specifier', async () => {
        const fsPath = await writePyproject(root, '  >=3.10  ');

        assert.strictEqual(await readRequiresPython(fsPath), '>=3.10');
    });

    test('returns undefined when the project table has no requires-python', async () => {
        const fsPath = await writePyproject(root);

        assert.strictEqual(await readRequiresPython(fsPath), undefined);
    });

    test('returns undefined for an unreadable or invalid pyproject.toml', async () => {
        assert.strictEqual(await readRequiresPython(path.join(root, 'missing.toml')), undefined);

        const invalid = path.join(root, 'pyproject.toml');
        await fs.writeFile(invalid, '[[[\n');
        assert.strictEqual(await readRequiresPython(invalid), undefined);
    });

    test('uses the creation-root specifier from the issue example', async () => {
        await writePyproject(root, '>3.10');
        const search = sinon.stub(workspaceApis, 'findFiles').rejects(new Error('search should not run'));

        assert.strictEqual(await resolveProjectRequiresPython(Uri.file(root)), '>3.10');
        assert.ok(search.notCalled);
    });

    test('prefers an ancestor project over a nested package', async () => {
        const parent = root;
        const project = path.join(parent, 'service');
        const nested = path.join(project, 'experiments');
        await writePyproject(parent, '>=3.10');
        await writePyproject(nested, '>=3.13');
        sinon
            .stub(workspaceApis, 'findFiles')
            .resolves([Uri.file(path.join(parent, 'pyproject.toml')), Uri.file(path.join(nested, 'pyproject.toml'))]);

        assert.strictEqual(await resolveProjectRequiresPython(Uri.file(project)), '>=3.10');
    });

    test('uses the only nested specifier when the creation root has no pyproject.toml', async () => {
        const nested = path.join(root, 'pkg');
        const fsPath = await writePyproject(nested, '>=3.11');
        sinon.stub(workspaceApis, 'findFiles').resolves([Uri.file(fsPath)]);

        assert.strictEqual(await resolveProjectRequiresPython(Uri.file(root)), '>=3.11');
    });

    test('ignores conflicting nested specifiers and pyproject files inside virtual environments', async () => {
        const first = await writePyproject(path.join(root, 'a'), '>=3.11');
        const second = await writePyproject(path.join(root, 'b'), '>=3.9');
        const venvFile = await writePyproject(path.join(root, '.venv'), '>=3.8');
        const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'requires-python-outside-'));
        try {
            const unrelated = await writePyproject(outside, '>=3.13');
            sinon
                .stub(workspaceApis, 'findFiles')
                .resolves([Uri.file(first), Uri.file(second), Uri.file(venvFile), Uri.file(unrelated)]);

            assert.strictEqual(await resolveProjectRequiresPython(Uri.file(root)), undefined);
        } finally {
            await fs.remove(outside);
        }
    });

    test('accepts nested files that declare the same specifier', async () => {
        const first = await writePyproject(path.join(root, 'a'), '>=3.11');
        const second = await writePyproject(path.join(root, 'b'), '>=3.11');
        sinon.stub(workspaceApis, 'findFiles').resolves([Uri.file(first), Uri.file(second)]);

        assert.strictEqual(await resolveProjectRequiresPython(Uri.file(root)), '>=3.11');
    });

    test('filters to interpreters that satisfy >3.10 and keeps newest-first order', () => {
        const interpreters = [
            interpreter('3.12.1'),
            interpreter('3.10.1'),
            interpreter('3.10.0'),
            interpreter('3.9.18'),
        ];

        const selection = selectInterpretersForRequiresPython(interpreters, '>3.10');

        assert.strictEqual(selection.outcome, 'applied');
        assert.strictEqual(selection.requiresPython, '>3.10');
        assert.deepStrictEqual(
            selection.interpreters.map((item) => item.version),
            ['3.12.1', '3.10.1'],
        );
    });

    test('supports an upper bound and rejects prereleases the specifier does not name', () => {
        const selection = selectInterpretersForRequiresPython(
            [interpreter('3.12.0'), interpreter('3.11.0rc1'), interpreter('3.11.4'), interpreter('3.9.0')],
            '>=3.10,<3.12',
        );

        assert.deepStrictEqual(
            selection.interpreters.map((item) => item.version),
            ['3.11.4'],
        );
    });

    test('keeps every interpreter when nothing matches or the specifier is invalid', () => {
        const interpreters = [interpreter('3.9.0'), interpreter('not-a-version')];

        const none = selectInterpretersForRequiresPython(interpreters, '>=3.13');
        assert.strictEqual(none.outcome, 'none-compatible');
        assert.strictEqual(none.requiresPython, undefined);
        assert.deepStrictEqual(none.interpreters, interpreters);

        const invalid = selectInterpretersForRequiresPython(interpreters, '3.10');
        assert.strictEqual(invalid.outcome, 'unparseable');
        assert.deepStrictEqual(invalid.interpreters, interpreters);

        const unconstrained = selectInterpretersForRequiresPython(interpreters, '   ');
        assert.strictEqual(unconstrained.outcome, 'unconstrained');
    });

    test('Quick Create keeps a compatible preferred interpreter', () => {
        const preferred = interpreter('3.11.2');
        const newer = interpreter('3.13.0');

        assert.strictEqual(chooseQuickCreateInterpreter(preferred, [newer, preferred], '>=3.10'), preferred);
    });

    test('Quick Create replaces an incompatible preferred interpreter with the newest match', () => {
        const preferred = interpreter('3.9.1');
        const newer = interpreter('3.13.0');
        const olderMatch = interpreter('3.11.8');

        assert.strictEqual(chooseQuickCreateInterpreter(preferred, [olderMatch, preferred, newer], '>=3.10'), newer);
        assert.strictEqual(chooseQuickCreateInterpreter(preferred, [preferred], '>=3.10'), preferred);
        assert.strictEqual(chooseQuickCreateInterpreter(preferred, [newer, preferred], undefined), preferred);
    });
});
