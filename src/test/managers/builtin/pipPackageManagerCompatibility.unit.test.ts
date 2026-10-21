// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { CancellationTokenSource, Uri } from 'vscode';
import { PythonEnvironmentApi } from '../../../api';
import { pythonToolSupport } from '../../../internal/pythonToolSupport';
import { PipListCommand, UvListCommand } from '../../../managers/builtin/commands';
import * as helpers from '../../../managers/builtin/helpers';
import { PipPackageManager } from '../../../managers/builtin/pipPackageManager';
import { UvPackageManager } from '../../../managers/builtin/uvPackageManager';
import { VenvManager } from '../../../managers/builtin/venvManager';
import { createMockLogOutputChannel } from '../../mocks/helper';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

suite('Built-in package manager command compatibility', () => {
    const scope = Uri.file(path.join(process.cwd(), 'project with spaces'));
    const environment = createMockPythonEnvironment({
        envPath: path.join(scope.fsPath, '.venv'),
        version: '3.12.0',
        managerId: 'ms-python.python:venv',
    });

    for (const useUv of [false, true]) {
        suite(useUv ? 'uv manager' : 'pip manager', () => {
            let manager: PipPackageManager | UvPackageManager;
            let source: CancellationTokenSource;
            let runPython: sinon.SinonStub;
            let runUV: sinon.SinonStub;
            let getUvExecutable: sinon.SinonStub;

            setup(() => {
                source = new CancellationTokenSource();
                const api: Partial<PythonEnvironmentApi> = {
                    createPackageItem: sinon.stub().callsFake((info) => info),
                };
                const Manager = useUv ? UvPackageManager : PipPackageManager;
                manager = new Manager(
                    api as PythonEnvironmentApi,
                    createMockLogOutputChannel(),
                    {} as VenvManager,
                );
                sinon.stub(helpers, 'shouldUseUv').resolves(useUv);
                getUvExecutable = sinon.stub(helpers, 'getUvExecutable').resolves('workspace-uv');
                runPython = sinon.stub(helpers, 'runPython').resolves('[]');
                runUV = sinon.stub(helpers, 'runUV').resolves('[]');
            });

            teardown(() => {
                manager.dispose();
                source.dispose();
                sinon.restore();
            });

            test('keeps uninstall, upgrade, and inventory refresh on the selected backend', async () => {
                const selected = useUv ? runUV : runPython;
                const other = useUv ? runPython : runUV;
                const changes = sinon.spy();
                manager.onDidChangePackages(changes);
                selected.onThirdCall().resolves(JSON.stringify([{ name: 'requests', version: '2.32.5' }]));

                await manager[pythonToolSupport].manage(
                    environment,
                    { uninstall: ['old-package'], install: ['requests'], upgrade: true },
                    source.token,
                    scope,
                );

                assert.strictEqual(selected.callCount, 3);
                assert.ok(other.notCalled);
                if (useUv) {
                    assert.deepStrictEqual(selected.firstCall.args[0], [
                        'pip', 'uninstall', '--python', environment.environmentPath.fsPath, 'old-package',
                    ]);
                    assert.deepStrictEqual(selected.secondCall.args[0], [
                        'pip', 'install', '--python', environment.environmentPath.fsPath, '--upgrade', 'requests',
                    ]);
                    assert.ok(getUvExecutable.alwaysCalledWithExactly(
                        manager.log, environment.environmentPath.fsPath, source.token,
                    ));
                } else {
                    assert.strictEqual(selected.firstCall.args[0], environment.execInfo.run.executable);
                    assert.deepStrictEqual(selected.firstCall.args[1], ['-m', 'pip', 'uninstall', '-y', 'old-package']);
                    assert.deepStrictEqual(selected.secondCall.args[1], ['-m', 'pip', 'install', '--upgrade', 'requests']);
                    assert.ok(getUvExecutable.notCalled);
                }
                const tokenIndex = useUv ? 3 : 4;
                for (const call of selected.getCalls()) {
                    assert.strictEqual(call.args[tokenIndex], source.token);
                    assert.strictEqual(call.args[6], true);
                }
                assert.strictEqual(changes.firstCall.args[0].manager, manager);
                assert.strictEqual(changes.firstCall.args[0].environment, environment);
            });

            test('keeps backend version and direct dependency queries unchanged', async () => {
                const selected = useUv ? runUV : runPython;
                selected.onFirstCall().resolves(useUv ? 'uv 0.8.0' : 'pip 25.1 from pip (python 3.12)');
                selected.onSecondCall().resolves(useUv ? 'Requests v2.32.5\n' : JSON.stringify([{ name: 'Requests' }]));

                assert.strictEqual((await manager.getVersion(environment))?.public, useUv ? '0.8.0' : '25.1');
                assert.deepStrictEqual(await manager.getDirectPackageNames(environment), new Set(['requests']));
                assert.ok((useUv ? runPython : runUV).notCalled);
                if (useUv) {
                    assert.deepStrictEqual(selected.secondCall.args[0], [
                        'pip', 'tree', '--python', environment.environmentPath.fsPath, '--depth=0',
                    ]);
                } else {
                    assert.deepStrictEqual(selected.secondCall.args[1], [
                        '-m', 'pip', 'list', '--format=json', '--not-required', '--disable-pip-version-check',
                    ]);
                }
            });

            test('preserves cached inventory when strict tool refresh fails', async () => {
                const list = sinon.stub(useUv ? UvListCommand.prototype : PipListCommand.prototype, 'execute');
                list.resolves([{ name: 'requests', displayName: 'requests', version: '2.32.5' }]);
                const cached = await manager.getPackages(environment);
                const error = new Error('inventory failed');
                list.rejects(error);

                await assert.rejects(
                    manager[pythonToolSupport].getPackages(environment, source.token, scope),
                    (actual: unknown) => actual === error,
                );
                assert.strictEqual(await manager.getPackages(environment), cached);
            });
        });
    }
});
