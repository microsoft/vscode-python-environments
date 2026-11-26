// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { LogOutputChannel, Uri } from 'vscode';
import {
    DidChangeEnvironmentEventArgs,
    EnvironmentManager,
    PythonEnvironment,
    PythonEnvironmentApi,
    PythonProject,
} from '../../../api';
import { SYSTEM_MANAGER_ID, VENV_MANAGER_ID } from '../../../common/constants';
import { normalizePath } from '../../../common/utils/pathUtils';
import * as windowApis from '../../../common/window.apis';
import { BuiltInEnvironmentManager } from '../../../managers/builtin/builtInEnvironmentManager';
import { UvEnvironmentManager } from '../../../managers/builtin/uvEnvironmentManager';
import { VenvEnvironmentManager } from '../../../managers/builtin/venvEnvironmentManager';
import * as venvUtils from '../../../managers/builtin/venvUtils';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

suite('VenvManager auto-selection for a project', () => {
    const projectUri = Uri.file(path.resolve('workspace', 'project'));
    const bin = process.platform === 'win32' ? 'Scripts' : 'bin';

    function venvIn(...segments: string[]): string {
        return Uri.file(path.join(projectUri.fsPath, ...segments, '.venv')).fsPath;
    }

    function makeVenv(prefix: string, version: string, id = prefix): PythonEnvironment {
        return createMockPythonEnvironment({
            id,
            name: '.venv',
            envPath: path.join(prefix, bin, 'python'),
            sysPrefix: prefix,
            version,
            managerId: VENV_MANAGER_ID,
        });
    }

    function makeGlobal(prefix: string, version: string): PythonEnvironment {
        return createMockPythonEnvironment({
            id: prefix,
            name: 'python',
            envPath: path.join(prefix, 'python'),
            sysPrefix: prefix,
            version,
            managerId: SYSTEM_MANAGER_ID,
        });
    }

    async function createManager(
        getGlobals: sinon.SinonStub = sinon.stub().resolves([]),
    ): Promise<BuiltInEnvironmentManager> {
        const project = { name: 'project', uri: projectUri } as PythonProject;
        const projectRoot = normalizePath(projectUri.fsPath);
        const api = {
            getPythonProject: (uri: Uri) => {
                const p = normalizePath(uri.fsPath);
                return p === projectRoot || p.startsWith(`${projectRoot}/`) ? project : undefined;
            },
            getPythonProjects: () => [project],
        } as unknown as PythonEnvironmentApi;
        const baseManager = { getEnvironments: getGlobals } as unknown as EnvironmentManager;
        const log = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() } as unknown as LogOutputChannel;
        const manager = new BuiltInEnvironmentManager(
            {} as NativePythonFinder,
            api,
            baseManager,
            log,
            new VenvEnvironmentManager(),
            new UvEnvironmentManager(),
        );
        await manager.initialize();
        return manager;
    }

    setup(() => {
        sinon.stub(windowApis, 'withProgress').callsFake(async (_options, task) => task({} as never, {} as never));
        sinon.stub(venvUtils, 'getVenvForWorkspace').resolves(undefined);
        sinon.stub(venvUtils, 'getVenvForGlobal').resolves(undefined);
    });

    teardown(() => {
        sinon.restore();
    });

    test("prefers the project's own .venv over a newer one in a subfolder", async () => {
        const rootVenv = makeVenv(venvIn(), '3.12.14');
        const toolsVenv = makeVenv(venvIn('tools'), '3.13.15');
        sinon.stub(venvUtils, 'findVirtualEnvironments').resolves([toolsVenv, rootVenv]);
        const manager = await createManager();

        assert.strictEqual((await manager.get(projectUri))?.envId.id, rootVenv.envId.id);
    });

    test('still selects a nested environment when the project root has none', async () => {
        const toolsVenv = makeVenv(venvIn('tools'), '3.13.15');
        sinon.stub(venvUtils, 'findVirtualEnvironments').resolves([toolsVenv]);
        const manager = await createManager();

        assert.strictEqual((await manager.get(projectUri))?.envId.id, toolsVenv.envId.id);
    });

    test('does not prefer a broken root environment over a working nested one', async () => {
        const brokenRoot = Object.assign(makeVenv(venvIn(), '3.12.14'), { error: 'Python executable not found' });
        const toolsVenv = makeVenv(venvIn('tools'), '3.13.15');
        sinon.stub(venvUtils, 'findVirtualEnvironments').resolves([brokenRoot, toolsVenv]);
        const manager = await createManager();

        assert.strictEqual((await manager.get(projectUri))?.envId.id, toolsVenv.envId.id);
    });

    test('still selects a broken root environment when it is the only one', async () => {
        const brokenRoot = Object.assign(makeVenv(venvIn(), '3.12.14'), { error: 'Python executable not found' });
        sinon.stub(venvUtils, 'findVirtualEnvironments').resolves([brokenRoot]);
        const manager = await createManager();

        assert.strictEqual((await manager.get(projectUri))?.envId.id, brokenRoot.envId.id);
    });

    test('fires onDidChangeEnvironment when a refresh finds a venv created in the project', async () => {
        const rootVenv = makeVenv(venvIn(), '3.12.14');
        const find = sinon.stub(venvUtils, 'findVirtualEnvironments').resolves([]);
        const manager = await createManager();
        const events: DidChangeEnvironmentEventArgs[] = [];
        manager.onDidChangeEnvironment((e) => events.push(e));

        find.resolves([rootVenv]);
        await manager.refresh(undefined);

        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].uri?.fsPath, projectUri.fsPath);
        assert.strictEqual(events[0].new?.envId.id, rootVenv.envId.id);
        assert.strictEqual((await manager.get(projectUri))?.envId.id, rootVenv.envId.id);
    });

    test('reports the global fallback from before the refresh as the old environment', async () => {
        const oldGlobal = makeGlobal(path.resolve('python312'), '3.12.14');
        const newGlobal = makeGlobal(path.resolve('python313'), '3.13.15');
        const rootVenv = makeVenv(venvIn(), '3.12.14');
        const getGlobals = sinon.stub().resolves([oldGlobal]);
        const find = sinon.stub(venvUtils, 'findVirtualEnvironments').resolves([]);
        const manager = await createManager(getGlobals);
        const events: DidChangeEnvironmentEventArgs[] = [];
        manager.onDidChangeEnvironment((e) => events.push(e));

        getGlobals.resolves([oldGlobal, newGlobal]);
        find.resolves([rootVenv]);
        await manager.refresh(undefined);

        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].old?.envId.id, oldGlobal.envId.id);
        assert.strictEqual(events[0].new?.envId.id, rootVenv.envId.id);
    });

    test('does not fire onDidChangeEnvironment when a refresh finds the same venv again', async () => {
        const find = sinon
            .stub(venvUtils, 'findVirtualEnvironments')
            .resolves([makeVenv(venvIn(), '3.12.14', 'first')]);
        const manager = await createManager();
        const events: DidChangeEnvironmentEventArgs[] = [];
        manager.onDidChangeEnvironment((e) => events.push(e));

        // Discovery creates a new item with a new id for the same interpreter.
        find.resolves([makeVenv(venvIn(), '3.12.14', 'second')]);
        await manager.refresh(undefined);

        assert.strictEqual(events.length, 0);
    });
});
