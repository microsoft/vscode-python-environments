import assert from 'node:assert';
import * as sinon from 'sinon';
import { ConfigurationTarget, WorkspaceConfiguration } from 'vscode';
import * as platformUtils from '../../../common/utils/platformUtils';
import * as workspaceApis from '../../../common/workspace.apis';
import { appendWorkspaceSearchPaths } from '../../../features/views/envManagerSearch';

type UpdateCall = { key: string; value: unknown; target?: ConfigurationTarget | boolean };

suite('Environment Manager Search', () => {
    suite('appendWorkspaceSearchPaths', () => {
        let updateCalls: UpdateCall[];

        function createMockConfig(workspaceValue: string[]) {
            updateCalls = [];
            return {
                inspect: sinon.stub().returns({ workspaceValue }),
                update: sinon
                    .stub()
                    .callsFake((section: string, value: unknown, target?: ConfigurationTarget | boolean) => {
                        updateCalls.push({ key: section, value, target });
                        return Promise.resolve();
                    }),
            } as unknown as WorkspaceConfiguration;
        }

        teardown(() => {
            sinon.restore();
        });

        test('does not update when all paths are duplicates or empty', async () => {
            sinon.stub(platformUtils, 'isWindows').returns(false);
            const mockConfig = createMockConfig(['.venv', 'envs/existing']);
            const getConfigurationStub = sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            await appendWorkspaceSearchPaths(['  .venv  ', ' ', 'envs/existing']);

            assert.strictEqual(getConfigurationStub.calledOnce, true);
            assert.strictEqual(updateCalls.length, 0);
        });

        test('appends new paths to workspace search paths', async () => {
            sinon.stub(platformUtils, 'isWindows').returns(false);
            const mockConfig = createMockConfig(['.venv']);
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            await appendWorkspaceSearchPaths(['envs/new', '  .venv  ']);

            assert.strictEqual(updateCalls.length, 1);
            assert.strictEqual(updateCalls[0].key, 'workspaceSearchPaths');
            assert.deepStrictEqual(updateCalls[0].value, ['.venv', 'envs/new']);
            assert.strictEqual(updateCalls[0].target, ConfigurationTarget.Workspace);
        });

        test('dedupes paths case-insensitively on Windows', async () => {
            sinon.stub(platformUtils, 'isWindows').returns(true);
            const mockConfig = createMockConfig(['ENV']);
            sinon.stub(workspaceApis, 'getConfiguration').returns(mockConfig);

            await appendWorkspaceSearchPaths(['env']);

            assert.strictEqual(updateCalls.length, 0);
        });
    });
});
