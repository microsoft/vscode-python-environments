import assert from 'assert';
import * as sinon from 'sinon';
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
        test('returns workspaceState value when present (primary layer)', async () => {
            workspaceMock.get.withArgs(SYSTEM_GLOBAL_KEY).resolves('/ws/python');
            globalMock.get.withArgs(SYSTEM_GLOBAL_KEY).resolves('/global/python');

            const result = await getSystemEnvForGlobal();

            assert.strictEqual(result, '/ws/python', 'workspaceState should take priority');
            assert.ok(workspaceMock.get.calledWith(SYSTEM_GLOBAL_KEY), 'should query workspaceState');
            assert.ok(globalMock.get.notCalled, 'should not query globalState when workspace has a value');
        });

        test('falls back to globalState when workspaceState is empty (cold workspace mirror)', async () => {
            workspaceMock.get.withArgs(SYSTEM_GLOBAL_KEY).resolves(undefined);
            globalMock.get.withArgs(SYSTEM_GLOBAL_KEY).resolves('/global/python');

            const result = await getSystemEnvForGlobal();

            assert.strictEqual(result, '/global/python', 'should fall back to globalState');
            assert.ok(workspaceMock.get.calledWith(SYSTEM_GLOBAL_KEY), 'should query workspaceState first');
            assert.ok(globalMock.get.calledWith(SYSTEM_GLOBAL_KEY), 'should then query globalState');
        });

        test('returns undefined when both layers are empty (true cold cache)', async () => {
            workspaceMock.get.withArgs(SYSTEM_GLOBAL_KEY).resolves(undefined);
            globalMock.get.withArgs(SYSTEM_GLOBAL_KEY).resolves(undefined);

            const result = await getSystemEnvForGlobal();

            assert.strictEqual(result, undefined, 'should return undefined when nothing cached');
        });

        test('falls back to globalState when workspaceState value is empty string', async () => {
            // An empty string is falsy and should not count as a cached selection.
            workspaceMock.get.withArgs(SYSTEM_GLOBAL_KEY).resolves('');
            globalMock.get.withArgs(SYSTEM_GLOBAL_KEY).resolves('/global/python');

            const result = await getSystemEnvForGlobal();

            assert.strictEqual(result, '/global/python');
        });

        test('does not interact with persistent state when called (sanity: lazy/awaited only)', async () => {
            // Smoke check that the deferred-resolved helpers are awaited.
            workspaceMock.get.resolves('/ws/python');
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

        test('round-trip: after set, get returns the value from workspaceState (primary)', async () => {
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

            // Pre-condition: get sees the workspace-mirrored value.
            assert.strictEqual(await getSystemEnvForGlobal(), '/cached/ws/python');

            await clearSystemEnvCache();

            assert.strictEqual(
                await getSystemEnvForGlobal(),
                undefined,
                'both layers should be cleared, so global lookup is empty',
            );
        });
    });
});
