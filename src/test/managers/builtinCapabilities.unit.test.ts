// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { Disposable, l10n, Memento, Uri } from 'vscode';
import { EnvironmentManager, PythonEnvironmentApi, PythonProject } from '../../api';
import {
    CapabilityContext,
    resolveEnvironmentManagerCapability as environmentCapability,
    EnvironmentCapability,
    resolvePackageManagerCapability as packageCapability,
    PackageCapability,
    Support,
} from '../../capabilities';
import * as metadata from '../../common/inlineScript/metadata';
import * as workspaceApis from '../../common/workspace.apis';
import { InlineScriptEnvManager } from '../../managers/builtin/inlineScript/envManager';
import { SysPythonManager } from '../../managers/builtin/sysPythonManager';
import { VenvManager } from '../../managers/builtin/venvManager';
import { CondaEnvManager } from '../../managers/conda/condaEnvManager';
import { NativePythonFinder } from '../../managers/common/nativePythonFinder';
import { PipenvManager } from '../../managers/pipenv/pipenvManager';
import { PoetryManager } from '../../managers/poetry/poetryManager';
import { PoetryPackageManager } from '../../managers/poetry/poetryPackageManager';
import { PyEnvManager } from '../../managers/pyenv/pyenvManager';
import { createMockLogOutputChannel } from '../mocks/helper';
import { createMockPythonEnvironment } from '../mocks/pythonEnvironment';

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

    test('system-owned local environments report manager-level removal support without classifying the installation', async () => {
        const manager = new SysPythonManager({} as NativePythonFinder, api, log);
        const environment = createMockPythonEnvironment({
            envPath: path.join(root, '.venv'),
            managerId: 'test:system',
        });
        assert.deepStrictEqual(await environmentCapability(manager, EnvironmentCapability.Remove, { environment }), {
            supported: false,
            reason: l10n.t('This environment manager does not support removing environments.'),
        });
    });

    test('only venv and Conda advertise named creation without invoking operations', async () => {
        const finder = {} as NativePythonFinder;
        const system = new SysPythonManager(finder, api, log);
        const conda = new CondaEnvManager(finder, api, log);
        const supported = [new VenvManager(finder, api, system, log), conda];
        const otherManagers = [
            new PipenvManager(finder, api),
            new PoetryManager(finder, api),
            new PyEnvManager(finder, api),
        ];
        disposables.push(conda, ...otherManagers);
        for (const manager of supported) {
            const create = sinon.stub(manager, 'create').throws(new Error('Unexpected creation'));
            assert.deepStrictEqual(await environmentCapability(manager, EnvironmentCapability.CreateNamed), {
                supported: true,
            });
            assert.ok(create.notCalled);
        }
        for (const manager of [system, ...otherManagers]) {
            assertUnsupported(await environmentCapability(manager, EnvironmentCapability.CreateNamed));
        }
    });

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
                {} as NativePythonFinder,
                api,
                {} as EnvironmentManager,
                Uri.file(path.join(root, 'storage')),
                log,
                { get: sinon.stub().returns(undefined), update: stateUpdate, keys: () => [] } as Memento,
            );
            disposables.push(manager);
            readMetadata = sinon.stub(metadata, 'readInlineScriptMetadataFromFile').resolves({
                requiresPython: '>=3.11',
                dependencies: ['requests'],
                range: { start: 0, end: 40 },
            });
        });

        teardown(() => {
            assert.ok(stateUpdate.notCalled);
        });

        test('accepts a single local script with metadata without a quick-create UI hook', async () => {
            const create = sinon.stub(manager, 'create').throws(new Error('Unexpected creation'));
            assert.strictEqual((manager as EnvironmentManager).quickCreateConfig, undefined);
            for (const scope of [script, [script]]) {
                assert.deepStrictEqual(await environmentCapability(manager, EnvironmentCapability.Create, { scope }), {
                    supported: true,
                });
            }
            assert.ok(readMetadata.alwaysCalledWithExactly(script));
            assert.ok(create.notCalled);
        });

        test('does not support caller-supplied names even for scripts with valid metadata', async () => {
            assertUnsupported(
                await environmentCapability(manager, EnvironmentCapability.CreateNamed, { scope: script }),
            );
            assert.ok(readMetadata.notCalled);
        });

        test('rejects unsupported scopes before reading metadata', async () => {
            const scopes: CapabilityContext['scope'][] = [
                undefined,
                'global',
                'all',
                [],
                [script, script],
                Uri.parse('untitled:script.py'),
            ];
            for (const scope of scopes) {
                assertUnsupported(await environmentCapability(manager, EnvironmentCapability.Create, { scope }));
            }
            assert.ok(readMetadata.notCalled);
        });

        test('missing metadata disables creation', async () => {
            readMetadata.resolves(undefined);
            assertUnsupported(await environmentCapability(manager, EnvironmentCapability.Create, { scope: script }));
        });

        test('unexpected metadata probe failures reject', async () => {
            const failure = new Error('Metadata probe failed');
            readMetadata.rejects(failure);
            await assert.rejects(
                environmentCapability(manager, EnvironmentCapability.Create, { scope: script }),
                (error) => error === failure,
            );
        });
    });

    suite('Poetry project context', () => {
        let manager: PoetryPackageManager;
        const projectCapabilities = [
            PackageCapability.List,
            PackageCapability.ListDirect,
            PackageCapability.Install,
            PackageCapability.Uninstall,
        ] as const;

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
