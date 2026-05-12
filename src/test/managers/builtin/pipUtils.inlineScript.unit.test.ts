// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { CancellationToken, Progress, ProgressOptions, Uri } from 'vscode';
import { PythonEnvironmentApi, PythonProject } from '../../../api';
import * as ism from '../../../common/inlineScriptMetadata';
import * as winapi from '../../../common/window.apis';
import * as wapi from '../../../common/workspace.apis';
import { getProjectInstallable } from '../../../managers/builtin/pipUtils';

suite('Pip Utils - getProjectInstallable (inline script metadata)', () => {
    let findFilesStub: sinon.SinonStub;
    let withProgressStub: sinon.SinonStub;
    let readMetadataStub: sinon.SinonStub;
    let isEnabledStub: sinon.SinonStub;
    let mockApi: { getPythonProject: (uri: Uri) => PythonProject | undefined };

    setup(() => {
        findFilesStub = sinon.stub(wapi, 'findFiles');
        // Default: no requirements/pyproject files anywhere.
        findFilesStub.resolves([]);

        withProgressStub = sinon.stub(winapi, 'withProgress');
        withProgressStub.callsFake(
            async (
                _options: ProgressOptions,
                callback: (
                    progress: Progress<{ message?: string; increment?: number }>,
                    token: CancellationToken,
                ) => Thenable<unknown>,
            ) => {
                return await callback(
                    {} as Progress<{ message?: string; increment?: number }>,
                    { isCancellationRequested: false } as CancellationToken,
                );
            },
        );

        readMetadataStub = sinon.stub(ism, 'readInlineScriptMetadataFromFile');
        readMetadataStub.resolves(undefined);

        isEnabledStub = sinon.stub(ism, 'isInlineScriptMetadataEnabled');
        isEnabledStub.returns(true);

        const workspacePath = Uri.file(path.resolve('/test/path/root')).fsPath;
        mockApi = {
            getPythonProject: (uri: Uri) => {
                if (uri.fsPath.startsWith(workspacePath)) {
                    return { name: 'workspace', uri: Uri.file(workspacePath) };
                }
                return undefined;
            },
        };
    });

    teardown(() => {
        sinon.restore();
    });

    test('includes inline-metadata deps for a .py script project', async () => {
        const scriptUri = Uri.file(path.resolve('/test/path/root/script.py'));
        readMetadataStub.withArgs(sinon.match((u: Uri) => u.toString() === scriptUri.toString())).resolves({
            requiresPython: '>=3.11',
            dependencies: ['requests<3', 'rich'],
            tool: undefined,
            range: { start: 0, end: 80 },
        });

        const result = (
            await getProjectInstallable(mockApi as PythonEnvironmentApi, [{ name: 'script.py', uri: scriptUri }])
        ).installables;

        assert.strictEqual(result.length, 2, 'should produce one installable per dependency');
        const names = result.map((r) => r.name).sort();
        assert.deepStrictEqual(names, ['requests<3', 'rich']);
        result.forEach((item) => {
            assert.strictEqual(item.group, 'Inline metadata');
            assert.deepStrictEqual(item.args, [item.name]);
            assert.ok(item.uri && item.uri.toString() === scriptUri.toString());
        });
    });

    test('ignores non-.py projects (folder projects are not walked)', async () => {
        const folderProject: PythonProject = {
            name: 'workspace',
            uri: Uri.file(path.resolve('/test/path/root')),
        };
        const result = (await getProjectInstallable(mockApi as PythonEnvironmentApi, [folderProject])).installables;

        assert.ok(readMetadataStub.notCalled, 'should not read metadata for folder projects');
        assert.strictEqual(result.length, 0);
    });

    test('no installables when the .py script has no inline metadata', async () => {
        const scriptUri = Uri.file(path.resolve('/test/path/root/plain.py'));
        readMetadataStub.resolves(undefined);

        const result = (
            await getProjectInstallable(mockApi as PythonEnvironmentApi, [{ name: 'plain.py', uri: scriptUri }])
        ).installables;

        assert.strictEqual(result.length, 0);
    });

    test('no installables when the .py script has zero declared dependencies', async () => {
        const scriptUri = Uri.file(path.resolve('/test/path/root/empty.py'));
        readMetadataStub.resolves({
            requiresPython: '>=3.11',
            dependencies: [],
            tool: undefined,
            range: { start: 0, end: 40 },
        });

        const result = (
            await getProjectInstallable(mockApi as PythonEnvironmentApi, [{ name: 'empty.py', uri: scriptUri }])
        ).installables;

        assert.strictEqual(result.length, 0);
    });

    test('skips metadata read when the experimental setting is off', async () => {
        isEnabledStub.returns(false);
        const scriptUri = Uri.file(path.resolve('/test/path/root/skip.py'));

        const result = (
            await getProjectInstallable(mockApi as PythonEnvironmentApi, [{ name: 'skip.py', uri: scriptUri }])
        ).installables;

        assert.ok(readMetadataStub.notCalled, 'should not read metadata when feature is disabled');
        assert.strictEqual(result.length, 0);
    });

    test('ignores .py projects with non-file URI schemes', async () => {
        const result = (
            await getProjectInstallable(mockApi as PythonEnvironmentApi, [
                { name: 'untitled.py', uri: Uri.parse('untitled:untitled.py') },
            ])
        ).installables;

        assert.ok(readMetadataStub.notCalled, 'should not read metadata for non-file URI');
        assert.strictEqual(result.length, 0);
    });
});
