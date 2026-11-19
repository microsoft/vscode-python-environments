import assert from 'assert';
import * as sinon from 'sinon';
import * as logging from '../../../common/logging';
import * as persistentState from '../../../common/persistentState';
import {
    clearSystemEnvCache,
    getSystemEnvForGlobal,
    setSystemEnvForGlobal,
    SYSTEM_GLOBAL_KEY,
    SYSTEM_WORKSPACE_KEY,
} from '../../../managers/builtin/cache';

suite('builtin cache - system global env two-tier lookup', () => {
    let workspaceMock: { get: sinon.SinonStub; set: sinon.SinonStub; clear: sinon.SinonStub };
    let globalMock: { get: sinon.SinonStub; set: sinon.SinonStub; clear: sinon.SinonStub };
    let getWorkspaceStub: sinon.SinonStub;
    let getGlobalStub: sinon.SinonStub;

    setup(() => {
        workspaceMock = {
            get: sinon.stub(),
            set: sinon.stub().resolves(),
            clear: sinon.stub().resolves(),
        };
        globalMock = {
            get: sinon.stub(),
            set: sinon.stub().resolves(),
            clear: sinon.stub().resolves(),
        };
        getWorkspaceStub = sinon
            .stub(persistentState, 'getWorkspacePersistentState')
            .resolves(workspaceMock as unknown as persistentState.PersistentState);
        getGlobalStub = sinon
            .stub(persistentState, 'getGlobalPersistentState')
            .resolves(globalMock as unknown as persistentState.PersistentState);
    });

    teardown(() => {
        sinon.restore();
    });

    suite('getSystemEnvForGlobal', () => {
        test('returns globalState value when present (canonical layer)', async () => {
            workspaceMock.get.withArgs(SYSTEM_GLOBAL_KEY).resolves('/ws/python');
            globalMock.get.withArgs(SYSTEM_GLOBAL_KEY).resolves('/global/python');

            const result = await getSystemEnvForGlobal();

            assert.strictEqual(result, '/global/python', 'globalState should take priority');
            assert.ok(globalMock.get.calledWith(SYSTEM_GLOBAL_KEY), 'should query globalState');
            assert.ok(workspaceMock.get.notCalled, 'should not query workspaceState when global has a value');
        });

        test('falls back to workspaceState when globalState is empty (cold global cache)', async () => {
            workspaceMock.get.withArgs(SYSTEM_GLOBAL_KEY).resolves('/ws/python');
            globalMock.get.withArgs(SYSTEM_GLOBAL_KEY).resolves(undefined);

            const result = await getSystemEnvForGlobal();

            assert.strictEqual(result, '/ws/python', 'should fall back to workspaceState');
            assert.ok(globalMock.get.calledWith(SYSTEM_GLOBAL_KEY), 'should query globalState first');
            assert.ok(workspaceMock.get.calledWith(SYSTEM_GLOBAL_KEY), 'should then query workspaceState');
        });

        test('returns undefined when both layers are empty (true cold cache)', async () => {
            workspaceMock.get.withArgs(SYSTEM_GLOBAL_KEY).resolves(undefined);
            globalMock.get.withArgs(SYSTEM_GLOBAL_KEY).resolves(undefined);

            const result = await getSystemEnvForGlobal();

            assert.strictEqual(result, undefined, 'should return undefined when nothing cached');
        });

        test('falls back to workspaceState when globalState value is empty string', async () => {
            workspaceMock.get.withArgs(SYSTEM_GLOBAL_KEY).resolves('/ws/python');
            globalMock.get.withArgs(SYSTEM_GLOBAL_KEY).resolves('');

            const result = await getSystemEnvForGlobal();

            assert.strictEqual(result, '/ws/python');
        });

        test('invokes workspace persistent state accessor when global cache is empty', async () => {
            workspaceMock.get.resolves('/ws/python');
            globalMock.get.resolves(undefined);
            await getSystemEnvForGlobal();
            assert.ok(getWorkspaceStub.called, 'workspace persistent state accessor invoked');
        });
    });

    suite('setSystemEnvForGlobal', () => {
        test('writes the same value to BOTH workspaceState and globalState', async () => {
            await setSystemEnvForGlobal('/some/python');

            assert.ok(
                workspaceMock.set.calledWith(SYSTEM_GLOBAL_KEY, '/some/python'),
                'workspaceState should receive the mirrored write',
            );
            assert.ok(
                globalMock.set.calledWith(SYSTEM_GLOBAL_KEY, '/some/python'),
                'globalState should receive the canonical write',
            );
            assert.ok(getWorkspaceStub.called && getGlobalStub.called, 'both persistent state accessors invoked');
        });

        test('invalidates BOTH layers when called with undefined (stale-path invalidation)', async () => {
            await setSystemEnvForGlobal(undefined);

            assert.ok(
                workspaceMock.set.calledWith(SYSTEM_GLOBAL_KEY, undefined),
                'workspaceState mirror should be cleared',
            );
            assert.ok(
                globalMock.set.calledWith(SYSTEM_GLOBAL_KEY, undefined),
                'globalState should be cleared',
            );
        });

        test('continues writing globalState if workspaceState write fails', async () => {
            const error = new Error('workspace write failed');
            const logError = sinon.stub(logging, 'traceError');
            workspaceMock.set.rejects(error);

            await setSystemEnvForGlobal('/some/python');

            assert.ok(globalMock.set.calledWith(SYSTEM_GLOBAL_KEY, '/some/python'));
            assert.ok(logError.calledOnceWithExactly('Failed to update workspace system Python cache:', error));
        });

        test('continues writing workspaceState if globalState write fails', async () => {
            const error = new Error('global write failed');
            const logError = sinon.stub(logging, 'traceError');
            globalMock.set.rejects(error);

            await setSystemEnvForGlobal('/some/python');

            assert.ok(workspaceMock.set.calledWith(SYSTEM_GLOBAL_KEY, '/some/python'));
            assert.ok(logError.calledOnceWithExactly('Failed to update global system Python cache:', error));
        });

        test('logs both failures without rejecting if both cache writes fail', async () => {
            const logError = sinon.stub(logging, 'traceError');
            workspaceMock.set.rejects(new Error('workspace write failed'));
            globalMock.set.rejects(new Error('global write failed'));

            await setSystemEnvForGlobal(undefined);

            assert.strictEqual(logError.callCount, 2);
            assert.ok(workspaceMock.set.calledWith(SYSTEM_GLOBAL_KEY, undefined));
            assert.ok(globalMock.set.calledWith(SYSTEM_GLOBAL_KEY, undefined));
        });

        test('continues writing globalState if workspaceState is unavailable', async () => {
            const error = new Error('workspace state unavailable');
            const logError = sinon.stub(logging, 'traceError');
            getWorkspaceStub.rejects(error);

            await setSystemEnvForGlobal('/some/python');

            assert.ok(globalMock.set.calledWith(SYSTEM_GLOBAL_KEY, '/some/python'));
            assert.ok(logError.calledOnceWithExactly('Failed to update workspace system Python cache:', error));
        });

        test('round-trip: after set, get returns the value written to both layers', async () => {
            // Simulate persistent state by wiring set to update get's resolved value.
            let workspaceStored: string | undefined;
            let globalStored: string | undefined;
            workspaceMock.set.callsFake(async (_key: string, value: string | undefined) => {
                workspaceStored = value;
            });
            globalMock.set.callsFake(async (_key: string, value: string | undefined) => {
                globalStored = value;
            });
            workspaceMock.get.withArgs(SYSTEM_GLOBAL_KEY).callsFake(async () => workspaceStored);
            globalMock.get.withArgs(SYSTEM_GLOBAL_KEY).callsFake(async () => globalStored);

            await setSystemEnvForGlobal('/round/trip/python');
            const result = await getSystemEnvForGlobal();

            assert.strictEqual(result, '/round/trip/python');
            assert.strictEqual(workspaceStored, '/round/trip/python');
            assert.strictEqual(globalStored, '/round/trip/python');
        });
    });

    suite('clearSystemEnvCache', () => {
        test('clears workspace-scoped key, workspace-mirrored global key, and globalState global key', async () => {
            await clearSystemEnvCache();

            assert.ok(workspaceMock.clear.calledOnce, 'workspaceState.clear should be called once');
            const workspaceClearedKeys = workspaceMock.clear.firstCall.args[0] as string[];
            assert.deepStrictEqual(
                [...workspaceClearedKeys].sort(),
                [SYSTEM_GLOBAL_KEY, SYSTEM_WORKSPACE_KEY].sort(),
                'workspaceState.clear should clear both the workspace map and the mirrored global key',
            );

            assert.ok(globalMock.clear.calledOnce, 'globalState.clear should be called once');
            assert.deepStrictEqual(
                globalMock.clear.firstCall.args[0],
                [SYSTEM_GLOBAL_KEY],
                'globalState.clear should clear the global key',
            );
        });

        test('after clear, get returns undefined (full invalidation through both layers)', async () => {
            // Simulate the in-memory backing for both layers.
            const workspaceBacking: { [key: string]: unknown } = {
                [SYSTEM_GLOBAL_KEY]: '/cached/ws/python',
                [SYSTEM_WORKSPACE_KEY]: { '/proj': '/cached/proj/python' },
            };
            const globalBacking: { [key: string]: unknown } = {
                [SYSTEM_GLOBAL_KEY]: '/cached/global/python',
            };
            workspaceMock.get.callsFake(async (key: string) => workspaceBacking[key]);
            globalMock.get.callsFake(async (key: string) => globalBacking[key]);
            workspaceMock.clear.callsFake(async (keys: string[]) => {
                for (const k of keys) {
                    delete workspaceBacking[k];
                }
            });
            globalMock.clear.callsFake(async (keys: string[]) => {
                for (const k of keys) {
                    delete globalBacking[k];
                }
            });

            // Pre-condition: get sees the canonical global value.
            assert.strictEqual(await getSystemEnvForGlobal(), '/cached/global/python');

            await clearSystemEnvCache();

            assert.strictEqual(
                await getSystemEnvForGlobal(),
                undefined,
                'both layers should be cleared, so global lookup is empty',
            );
        });

        test('clears globalState even when workspaceState clear fails', async () => {
            workspaceMock.clear.rejects(new Error('workspace clear failed'));

            await assert.rejects(clearSystemEnvCache(), /workspace clear failed/);

            assert.ok(globalMock.clear.calledOnce, 'globalState.clear should still be called');
        });
    });
});
