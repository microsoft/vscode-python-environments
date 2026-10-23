// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as logging from '../../../common/logging';
import * as persistentState from '../../../common/persistentState';
import { createDeferred } from '../../../common/utils/deferred';
import {
    clearSystemEnvCache,
    getSystemEnvForGlobal,
    invalidateSystemEnvForGlobal,
    setSystemEnvForGlobal,
    SYSTEM_GLOBAL_KEY,
    SYSTEM_GLOBAL_REVISION_KEY,
    SYSTEM_WORKSPACE_KEY,
} from '../../../managers/builtin/cache';

interface MockPersistentState {
    get: sinon.SinonStub;
    set: sinon.SinonStub;
    clear: sinon.SinonStub;
}

interface CacheEntry {
    readonly path?: string;
    readonly revision: string;
}

function entry(pathValue: string | undefined, revision: string): CacheEntry {
    return { path: pathValue, revision };
}

function createMemoryState(backing: Map<string, unknown>, sandbox: sinon.SinonSandbox): MockPersistentState {
    return {
        get: sandbox.stub().callsFake(async (key: string) => backing.get(key)),
        set: sandbox.stub().callsFake(async (key: string, value: unknown) => {
            if (value === undefined) {
                backing.delete(key);
            } else {
                backing.set(key, value);
            }
        }),
        clear: sandbox.stub().callsFake(async (keys?: string[]) => {
            (keys ?? [...backing.keys()]).forEach((key) => backing.delete(key));
        }),
    };
}

function getSetValue(state: MockPersistentState, key: string): unknown {
    const call = state.set.getCalls().find((candidate) => candidate.args[0] === key);
    assert.ok(call, `Expected ${key} to be written`);
    return call.args[1];
}

suite('System global environment cache persistence', () => {
    let sandbox: sinon.SinonSandbox;
    let workspaceState: MockPersistentState;
    let globalState: MockPersistentState;
    let getWorkspaceState: sinon.SinonStub;
    let getGlobalState: sinon.SinonStub;

    const workspacePath = path.resolve('cache-test', 'workspace-python');
    const globalPath = path.resolve('cache-test', 'global-python');

    setup(() => {
        sandbox = sinon.createSandbox();
        workspaceState = {
            get: sandbox.stub().resolves(undefined),
            set: sandbox.stub().resolves(),
            clear: sandbox.stub().resolves(),
        };
        globalState = {
            get: sandbox.stub().resolves(undefined),
            set: sandbox.stub().resolves(),
            clear: sandbox.stub().resolves(),
        };
        getWorkspaceState = sandbox
            .stub(persistentState, 'getWorkspacePersistentState')
            .resolves(workspaceState as unknown as persistentState.PersistentState);
        getGlobalState = sandbox
            .stub(persistentState, 'getGlobalPersistentState')
            .resolves(globalState as unknown as persistentState.PersistentState);
    });

    teardown(() => {
        sandbox.restore();
    });

    suite('getSystemEnvForGlobal', () => {
        test('prefers the workspace mirror over a different globalState value', async () => {
            workspaceState.get.withArgs(SYSTEM_GLOBAL_KEY).resolves(workspacePath);
            globalState.get.withArgs(SYSTEM_GLOBAL_KEY).resolves(globalPath);

            assert.strictEqual(await getSystemEnvForGlobal(), workspacePath);
            sinon.assert.calledWithExactly(workspaceState.get, SYSTEM_GLOBAL_KEY);
            sinon.assert.notCalled(getGlobalState);
        });

        test('falls back to a legacy globalState value when the workspace mirror is cold', async () => {
            globalState.get.withArgs(SYSTEM_GLOBAL_KEY).resolves(globalPath);

            assert.strictEqual(await getSystemEnvForGlobal(), globalPath);
            sinon.assert.calledWithExactly(workspaceState.get, SYSTEM_GLOBAL_KEY);
            sinon.assert.calledOnceWithExactly(globalState.get, SYSTEM_GLOBAL_KEY);
        });

        test('falls back to globalState when the workspaceState read fails', async () => {
            const failure = new Error('workspace read failed');
            const logError = sandbox.stub(logging, 'traceError');
            workspaceState.get.rejects(failure);
            globalState.get.withArgs(SYSTEM_GLOBAL_KEY).resolves(globalPath);

            assert.strictEqual(await getSystemEnvForGlobal(), globalPath);
            sinon.assert.calledOnceWithExactly(
                logError,
                'Failed to read workspaceState system Python cache:',
                failure,
            );
        });

        test('falls back to globalState when workspaceState is unavailable', async () => {
            const failure = new Error('workspace state unavailable');
            const logError = sandbox.stub(logging, 'traceError');
            getWorkspaceState.rejects(failure);
            globalState.get.withArgs(SYSTEM_GLOBAL_KEY).resolves(globalPath);

            assert.strictEqual(await getSystemEnvForGlobal(), globalPath);
            sinon.assert.calledOnceWithExactly(
                logError,
                'Failed to read workspaceState system Python cache:',
                failure,
            );
        });

        test('returns a cache miss and logs when the globalState fallback read fails', async () => {
            const failure = new Error('global read failed');
            const logError = sandbox.stub(logging, 'traceError');
            globalState.get.rejects(failure);

            assert.strictEqual(await getSystemEnvForGlobal(), undefined);
            sinon.assert.calledOnceWithExactly(logError, 'Failed to read globalState system Python cache:', failure);
        });

        test('uses a matching global revision to recover a failed workspace mirror update', async () => {
            workspaceState.get.withArgs(SYSTEM_GLOBAL_KEY).resolves(entry(workspacePath, 'old'));
            workspaceState.get.withArgs(SYSTEM_GLOBAL_REVISION_KEY).resolves('new');
            globalState.get.withArgs(SYSTEM_GLOBAL_KEY).resolves(entry(globalPath, 'new'));

            assert.strictEqual(await getSystemEnvForGlobal(), globalPath);
        });

        test('misses when neither layer completed the marked update', async () => {
            workspaceState.get.withArgs(SYSTEM_GLOBAL_KEY).resolves(entry(workspacePath, 'old'));
            workspaceState.get.withArgs(SYSTEM_GLOBAL_REVISION_KEY).resolves('new');
            globalState.get.withArgs(SYSTEM_GLOBAL_KEY).resolves(entry(workspacePath, 'old'));

            assert.strictEqual(await getSystemEnvForGlobal(), undefined);
        });

        test('honors a workspace tombstone without resurrecting an older global value', async () => {
            workspaceState.get.withArgs(SYSTEM_GLOBAL_KEY).resolves(entry(undefined, 'clear'));
            workspaceState.get.withArgs(SYSTEM_GLOBAL_REVISION_KEY).resolves('clear');
            globalState.get.withArgs(SYSTEM_GLOBAL_KEY).resolves(entry(workspacePath, 'old'));

            assert.strictEqual(await getSystemEnvForGlobal(), undefined);
            sinon.assert.notCalled(getGlobalState);
        });

        test('uses a matching global tombstone when the workspace clear failed', async () => {
            workspaceState.get.withArgs(SYSTEM_GLOBAL_KEY).resolves(entry(workspacePath, 'old'));
            workspaceState.get.withArgs(SYSTEM_GLOBAL_REVISION_KEY).resolves('clear');
            globalState.get.withArgs(SYSTEM_GLOBAL_KEY).resolves(entry(undefined, 'clear'));

            assert.strictEqual(await getSystemEnvForGlobal(), undefined);
        });

        test('does not resurrect a cleared workspace entry after globalState becomes cold', async () => {
            workspaceState.get.withArgs(SYSTEM_GLOBAL_KEY).resolves(entry(workspacePath, 'old'));
            workspaceState.get.withArgs(SYSTEM_GLOBAL_REVISION_KEY).resolves('clear');
            globalState.get.withArgs(SYSTEM_GLOBAL_KEY).resolves(undefined);

            assert.strictEqual(await getSystemEnvForGlobal(), undefined);
        });

        test('returns undefined without mutating storage when both layers are cold', async () => {
            assert.strictEqual(await getSystemEnvForGlobal(), undefined);
            sinon.assert.notCalled(workspaceState.set);
            sinon.assert.notCalled(globalState.set);
        });

        test('survives a cold globalState only for the same workspace', async () => {
            const globalBacking = new Map<string, unknown>();
            const workspaceBacking = new Map<string, unknown>();
            getGlobalState.resolves(
                createMemoryState(globalBacking, sandbox) as unknown as persistentState.PersistentState,
            );
            getWorkspaceState.resolves(
                createMemoryState(workspaceBacking, sandbox) as unknown as persistentState.PersistentState,
            );

            await setSystemEnvForGlobal(globalPath);
            globalBacking.delete(SYSTEM_GLOBAL_KEY);

            assert.strictEqual(await getSystemEnvForGlobal(), globalPath, 'same workspace should use its mirror');

            getWorkspaceState.resolves(
                createMemoryState(new Map<string, unknown>(), sandbox) as unknown as persistentState.PersistentState,
            );

            assert.strictEqual(
                await getSystemEnvForGlobal(),
                undefined,
                'a new workspace with cold globalState must still miss',
            );
        });
    });

    suite('invalidateSystemEnvForGlobal', () => {
        test('removes the matching stale path from both storage layers', async () => {
            workspaceState.get.withArgs(SYSTEM_GLOBAL_KEY).resolves(workspacePath);
            globalState.get.withArgs(SYSTEM_GLOBAL_KEY).resolves(workspacePath);

            await invalidateSystemEnvForGlobal(workspacePath);

            sinon.assert.calledOnceWithExactly(workspaceState.set, SYSTEM_GLOBAL_KEY, undefined);
            sinon.assert.calledOnceWithExactly(globalState.set, SYSTEM_GLOBAL_KEY, undefined);
        });

        test('removes only layers that still contain the stale path', async () => {
            workspaceState.get.withArgs(SYSTEM_GLOBAL_KEY).resolves(globalPath);
            globalState.get.withArgs(SYSTEM_GLOBAL_KEY).resolves(workspacePath);

            await invalidateSystemEnvForGlobal(workspacePath);

            sinon.assert.notCalled(workspaceState.set);
            sinon.assert.calledOnceWithExactly(globalState.set, SYSTEM_GLOBAL_KEY, undefined);
        });

        test('does not erase a newer selection queued before stale invalidation', async () => {
            const workspaceBacking = new Map<string, unknown>([[SYSTEM_GLOBAL_KEY, workspacePath]]);
            const globalBacking = new Map<string, unknown>([[SYSTEM_GLOBAL_KEY, workspacePath]]);
            getWorkspaceState.resolves(
                createMemoryState(workspaceBacking, sandbox) as unknown as persistentState.PersistentState,
            );
            getGlobalState.resolves(
                createMemoryState(globalBacking, sandbox) as unknown as persistentState.PersistentState,
            );

            const newerSelection = setSystemEnvForGlobal(globalPath);
            const staleInvalidation = invalidateSystemEnvForGlobal(workspacePath);
            await Promise.all([newerSelection, staleInvalidation]);

            assert.strictEqual(
                (workspaceBacking.get(SYSTEM_GLOBAL_KEY) as CacheEntry).path,
                globalPath,
            );
            assert.strictEqual((globalBacking.get(SYSTEM_GLOBAL_KEY) as CacheEntry).path, globalPath);
        });
    });

    suite('setSystemEnvForGlobal', () => {
        test('writes the same revisioned path to workspaceState and globalState', async () => {
            await setSystemEnvForGlobal(globalPath);

            const workspaceEntry = getSetValue(workspaceState, SYSTEM_GLOBAL_KEY) as CacheEntry;
            const globalEntry = getSetValue(globalState, SYSTEM_GLOBAL_KEY) as CacheEntry;
            const revision = getSetValue(workspaceState, SYSTEM_GLOBAL_REVISION_KEY);
            assert.strictEqual(workspaceEntry.path, globalPath);
            assert.strictEqual(globalEntry.path, globalPath);
            assert.strictEqual(workspaceEntry.revision, revision);
            assert.strictEqual(globalEntry.revision, revision);
        });

        test('writes matching tombstones to both layers when the selection is cleared', async () => {
            await setSystemEnvForGlobal(undefined);

            const workspaceEntry = getSetValue(workspaceState, SYSTEM_GLOBAL_KEY) as CacheEntry;
            const globalEntry = getSetValue(globalState, SYSTEM_GLOBAL_KEY) as CacheEntry;
            assert.strictEqual(workspaceEntry.path, undefined);
            assert.strictEqual(globalEntry.path, undefined);
            assert.strictEqual(workspaceEntry.revision, globalEntry.revision);
        });

        test('updates globalState when the workspace selection write fails', async () => {
            const failure = new Error('workspace write failed');
            const logError = sandbox.stub(logging, 'traceError');
            workspaceState.set.callsFake(async (key: string) => {
                if (key === SYSTEM_GLOBAL_KEY) {
                    throw failure;
                }
            });

            await setSystemEnvForGlobal(globalPath);

            assert.strictEqual((getSetValue(globalState, SYSTEM_GLOBAL_KEY) as CacheEntry).path, globalPath);
            sinon.assert.calledWithExactly(
                logError,
                'Failed to update workspaceState system Python cache:',
                failure,
            );
        });

        test('updates globalState when workspaceState is unavailable', async () => {
            const failure = new Error('workspace state unavailable');
            const logError = sandbox.stub(logging, 'traceError');
            getWorkspaceState.rejects(failure);

            await setSystemEnvForGlobal(globalPath);

            assert.strictEqual((getSetValue(globalState, SYSTEM_GLOBAL_KEY) as CacheEntry).path, globalPath);
            sinon.assert.calledWithExactly(
                logError,
                'Failed to update workspaceState system Python cache:',
                failure,
            );
        });

        test('updates workspaceState when the globalState write fails', async () => {
            const failure = new Error('global write failed');
            const logError = sandbox.stub(logging, 'traceError');
            globalState.set.rejects(failure);

            await setSystemEnvForGlobal(globalPath);

            assert.strictEqual((getSetValue(workspaceState, SYSTEM_GLOBAL_KEY) as CacheEntry).path, globalPath);
            sinon.assert.calledOnceWithExactly(
                logError,
                'Failed to update globalState system Python cache:',
                failure,
            );
        });

        test('reads the successful global update when the workspace mirror write fails', async () => {
            const workspaceBacking = new Map<string, unknown>([
                [SYSTEM_GLOBAL_KEY, entry(workspacePath, 'old')],
                [SYSTEM_GLOBAL_REVISION_KEY, 'old'],
            ]);
            const globalBacking = new Map<string, unknown>([[SYSTEM_GLOBAL_KEY, entry(workspacePath, 'old')]]);
            const failure = new Error('workspace selection write failed');
            workspaceState = createMemoryState(workspaceBacking, sandbox);
            globalState = createMemoryState(globalBacking, sandbox);
            workspaceState.set.callsFake(async (key: string, value: unknown) => {
                if (key === SYSTEM_GLOBAL_KEY) {
                    throw failure;
                }
                workspaceBacking.set(key, value);
            });
            getWorkspaceState.resolves(workspaceState as unknown as persistentState.PersistentState);
            getGlobalState.resolves(globalState as unknown as persistentState.PersistentState);

            await setSystemEnvForGlobal(globalPath);

            assert.strictEqual(await getSystemEnvForGlobal(), globalPath);
        });

        test('does not resurrect globalState when its tombstone write fails', async () => {
            const workspaceBacking = new Map<string, unknown>([
                [SYSTEM_GLOBAL_KEY, entry(workspacePath, 'old')],
                [SYSTEM_GLOBAL_REVISION_KEY, 'old'],
            ]);
            const globalBacking = new Map<string, unknown>([[SYSTEM_GLOBAL_KEY, entry(workspacePath, 'old')]]);
            workspaceState = createMemoryState(workspaceBacking, sandbox);
            globalState = createMemoryState(globalBacking, sandbox);
            globalState.set.rejects(new Error('global tombstone write failed'));
            getWorkspaceState.resolves(workspaceState as unknown as persistentState.PersistentState);
            getGlobalState.resolves(globalState as unknown as persistentState.PersistentState);

            await setSystemEnvForGlobal(undefined);

            assert.strictEqual(await getSystemEnvForGlobal(), undefined);
        });

        test('uses the global tombstone when the workspace tombstone write fails', async () => {
            const workspaceBacking = new Map<string, unknown>([
                [SYSTEM_GLOBAL_KEY, entry(workspacePath, 'old')],
                [SYSTEM_GLOBAL_REVISION_KEY, 'old'],
            ]);
            const globalBacking = new Map<string, unknown>([[SYSTEM_GLOBAL_KEY, entry(workspacePath, 'old')]]);
            workspaceState = createMemoryState(workspaceBacking, sandbox);
            globalState = createMemoryState(globalBacking, sandbox);
            workspaceState.set.callsFake(async (key: string, value: unknown) => {
                if (key === SYSTEM_GLOBAL_KEY) {
                    throw new Error('workspace tombstone write failed');
                }
                workspaceBacking.set(key, value);
            });
            getWorkspaceState.resolves(workspaceState as unknown as persistentState.PersistentState);
            getGlobalState.resolves(globalState as unknown as persistentState.PersistentState);

            await setSystemEnvForGlobal(undefined);

            assert.strictEqual(await getSystemEnvForGlobal(), undefined);
        });
        test('logs both selection failures without rejecting discovery', async () => {
            const workspaceFailure = new Error('workspace write failed');
            const globalFailure = new Error('global write failed');
            const logError = sandbox.stub(logging, 'traceError');
            workspaceState.set.callsFake(async (key: string) => {
                if (key === SYSTEM_GLOBAL_KEY) {
                    throw workspaceFailure;
                }
            });
            globalState.set.rejects(globalFailure);

            await setSystemEnvForGlobal(globalPath);

            sinon.assert.calledWithExactly(
                logError,
                'Failed to update workspaceState system Python cache:',
                workspaceFailure,
            );
            sinon.assert.calledWithExactly(
                logError,
                'Failed to update globalState system Python cache:',
                globalFailure,
            );
        });

        test('serializes overlapping updates so the latest selection wins in both layers', async () => {
            const workspaceBacking = new Map<string, unknown>();
            const globalBacking = new Map<string, unknown>();
            workspaceState = createMemoryState(workspaceBacking, sandbox);
            globalState = createMemoryState(globalBacking, sandbox);
            getWorkspaceState.resolves(workspaceState as unknown as persistentState.PersistentState);
            getGlobalState.resolves(globalState as unknown as persistentState.PersistentState);

            const firstWriteStarted = createDeferred<void>();
            const releaseFirstWrite = createDeferred<void>();
            workspaceState.set.callsFake(async (key: string, value: unknown) => {
                if (key === SYSTEM_GLOBAL_KEY && (value as CacheEntry).path === workspacePath) {
                    firstWriteStarted.resolve();
                    await releaseFirstWrite.promise;
                }
                if (value === undefined) {
                    workspaceBacking.delete(key);
                } else {
                    workspaceBacking.set(key, value);
                }
            });

            const first = setSystemEnvForGlobal(workspacePath);
            await firstWriteStarted.promise;
            const second = setSystemEnvForGlobal(undefined);
            await new Promise<void>((resolve) => setImmediate(resolve));

            try {
                assert.strictEqual(workspaceState.set.callCount, 2, 'second workspace write must remain queued');
                assert.strictEqual(globalState.set.callCount, 1, 'second global write must remain queued');
            } finally {
                releaseFirstWrite.resolve();
            }

            await Promise.all([first, second]);
            assert.strictEqual(await getSystemEnvForGlobal(), undefined);
            assert.strictEqual((workspaceBacking.get(SYSTEM_GLOBAL_KEY) as CacheEntry).path, undefined);
            assert.strictEqual((globalBacking.get(SYSTEM_GLOBAL_KEY) as CacheEntry).path, undefined);
        });
    });

    suite('clearSystemEnvCache', () => {
        test('clears workspace selections, mirror metadata, and the global cache', async () => {
            await clearSystemEnvCache();

            sinon.assert.calledOnceWithExactly(workspaceState.clear, [
                SYSTEM_WORKSPACE_KEY,
                SYSTEM_GLOBAL_KEY,
                SYSTEM_GLOBAL_REVISION_KEY,
            ]);
            sinon.assert.calledOnceWithExactly(globalState.clear, [SYSTEM_GLOBAL_KEY]);
        });

        test('clears globalState when the workspaceState clear fails', async () => {
            const failure = new Error('workspace clear failed');
            const logError = sandbox.stub(logging, 'traceError');
            workspaceState.clear.rejects(failure);

            await assert.rejects(clearSystemEnvCache, (error: unknown) => error === failure);

            sinon.assert.calledOnceWithExactly(globalState.clear, [SYSTEM_GLOBAL_KEY]);
            sinon.assert.calledOnceWithExactly(
                logError,
                'Failed to clear workspaceState system Python cache:',
                failure,
            );
        });

        test('clears globalState when workspaceState is unavailable', async () => {
            const failure = new Error('workspace state unavailable');
            const logError = sandbox.stub(logging, 'traceError');
            getWorkspaceState.rejects(failure);

            await assert.rejects(clearSystemEnvCache, (error: unknown) => error === failure);

            sinon.assert.calledOnceWithExactly(globalState.clear, [SYSTEM_GLOBAL_KEY]);
            sinon.assert.calledOnceWithExactly(
                logError,
                'Failed to clear workspaceState system Python cache:',
                failure,
            );
        });

        test('clears workspaceState when the globalState clear fails', async () => {
            const failure = new Error('global clear failed');
            const logError = sandbox.stub(logging, 'traceError');
            globalState.clear.rejects(failure);

            await assert.rejects(clearSystemEnvCache, (error: unknown) => error === failure);

            sinon.assert.calledOnceWithExactly(workspaceState.clear, [
                SYSTEM_WORKSPACE_KEY,
                SYSTEM_GLOBAL_KEY,
                SYSTEM_GLOBAL_REVISION_KEY,
            ]);
            sinon.assert.calledOnceWithExactly(
                logError,
                'Failed to clear globalState system Python cache:',
                failure,
            );
        });
    });
});
