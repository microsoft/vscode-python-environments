// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { Disposable, Memento, Uri } from 'vscode';
import { EnvironmentManager, PythonEnvironmentApi, PythonProject } from '../../api';
import {
    CapabilityContext,
    resolveEnvironmentManagerCapability as environmentCapability,
    resolvePackageManagerCapability as packageCapability,
    Support,
} from '../../capabilities';
import * as metadata from '../../common/inlineScript/metadata';
import * as workspaceApis from '../../common/workspace.apis';
import { InlineScriptEnvManager } from '../../managers/builtin/inlineScript/envManager';
import { VenvManager } from '../../managers/builtin/venvManager';
import { NativePythonFinder } from '../../managers/common/nativePythonFinder';
import { CondaEnvManager } from '../../managers/conda/condaEnvManager';
import { PoetryManager } from '../../managers/poetry/poetryManager';
import { PoetryPackageManager } from '../../managers/poetry/poetryPackageManager';
import { createMockLogOutputChannel } from '../mocks/helper';

suite('Built-in manager capabilities', () => {
    const root = path.join(__dirname, 'capability-fixtures');
    const project: PythonProject = { name: 'project', uri: Uri.file(path.join(root, 'project')) };
    let api: PythonEnvironmentApi;
    let log: ReturnType<typeof createMockLogOutputChannel>;
    const disposables: Disposable[] = [];

    function assertUnsupported(result: Support): void {
        assert.strictEqual(result.supported, false);
        if (!result.supported) {
            assert.ok(result.reason.length > 0);
        }
    }

    setup(() => {
        api = {
            getPythonProject: sinon.stub().throws(new Error('Unexpected project lookup')),
            getEnvironments: sinon.stub().rejects(new Error('Unexpected environment discovery')),
        } as unknown as PythonEnvironmentApi;
        log = createMockLogOutputChannel();
    });

    teardown(() => {
        try {
            disposables.splice(0).forEach((disposable) => disposable.dispose());
        } finally {
            sinon.restore();
        }
    });

    for (const [name, createManager] of [
        ['Venv', () => new VenvManager({} as NativePythonFinder, api, {} as EnvironmentManager, log)],
        ['Conda', () => {
            const manager = new CondaEnvManager({} as NativePythonFinder, api, log);
            disposables.push(manager);
            return manager;
        }],
    ] as const) {
        test(`${name} quick support delegates to create support without creating an environment`, async () => {
            const manager = createManager();
            const create = sinon.stub(manager, 'create').throws(new Error('Unexpected creation'));
            assert.deepStrictEqual(await environmentCapability(manager, 'environments.create.quick'), { supported: true });
            const denied: Support = { supported: false, reason: 'Creation disabled' };
            sinon.stub(manager, 'capabilities').value({ ...manager.capabilities, 'environments.create': async () => denied });
            assert.strictEqual(await environmentCapability(manager, 'environments.create.quick'), denied);
            assert.ok(create.notCalled);
        });
    }

    suite('Inline-script creation', () => {
        let manager: InlineScriptEnvManager;
        let readMetadata: sinon.SinonStub;
        let stateUpdate: sinon.SinonStub;
        const script = Uri.file(path.join(root, 'script.py'));

        setup(() => {
            sinon.stub(workspaceApis, 'onDidDeleteFiles').returns(new Disposable(() => {}));
            sinon.stub(workspaceApis, 'onDidRenameFiles').returns(new Disposable(() => {}));
            stateUpdate = sinon.stub().resolves();
            manager = new InlineScriptEnvManager(
                {} as NativePythonFinder, api, {} as EnvironmentManager, Uri.file(path.join(root, 'storage')), log,
                { get: sinon.stub().returns(undefined), update: stateUpdate, keys: () => [] } as Memento,
            );
            disposables.push(manager);
            readMetadata = sinon.stub(metadata, 'readInlineScriptMetadataFromFile').resolves({
                requiresPython: '>=3.11', dependencies: ['requests'], range: { start: 0, end: 40 },
            });
        });

        teardown(() => {
            assert.ok(stateUpdate.notCalled);
        });

        test('accepts a single local script with metadata, including quick creation without a UI hook', async () => {
            const create = sinon.stub(manager, 'create').throws(new Error('Unexpected creation'));
            assert.strictEqual((manager as EnvironmentManager).quickCreateConfig, undefined);
            for (const scope of [script, [script]]) {
                for (const key of ['environments.create', 'environments.create.quick'] as const) {
                    assert.deepStrictEqual(await environmentCapability(manager, key, { scope }), { supported: true });
                }
            }
            assert.ok(readMetadata.alwaysCalledWithExactly(script));
            assert.ok(create.notCalled);
        });

        test('rejects unsupported scopes before reading metadata', async () => {
            const scopes: CapabilityContext['scope'][] = [
                undefined, 'global', 'all', [], [script, script], Uri.parse('untitled:script.py'),
            ];
            for (const scope of scopes) {
                assertUnsupported(await environmentCapability(manager, 'environments.create', { scope }));
            }
            assert.ok(readMetadata.notCalled);
        });

        test('missing metadata disables creation and its quick variant', async () => {
            readMetadata.resolves(undefined);
            for (const key of ['environments.create', 'environments.create.quick'] as const) {
                assertUnsupported(await environmentCapability(manager, key, { scope: script }));
            }
        });

        test('unexpected metadata probe failures reject', async () => {
            const failure = new Error('Metadata probe failed');
            readMetadata.rejects(failure);
            await assert.rejects(
                environmentCapability(manager, 'environments.create.quick', { scope: script }),
                (error) => error === failure,
            );
        });
    });

    suite('Poetry project context', () => {
        let manager: PoetryPackageManager;
        const projectCapabilities = ['packages.list', 'packages.direct', 'packages.manage', 'packages.refresh'] as const;

        setup(() => {
            manager = new PoetryPackageManager(api, log, {} as PoetryManager);
            disposables.push(manager);
        });

        test('a query context cannot substitute for a project-bound instance', async () => {
            for (const key of projectCapabilities) {
                assertUnsupported(await packageCapability(manager, key, { project }));
            }
        });

        test('a project-bound instance supports its project-dependent capabilities', async () => {
            const scoped = manager.createForProject(project);
            disposables.push(scoped);
            for (const key of projectCapabilities) {
                assert.deepStrictEqual(await packageCapability(scoped, key), { supported: true });
            }
        });
    });
});
