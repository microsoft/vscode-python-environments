// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * Tests for PythonEnvironmentManagers.getLastKnownEnvironment, the synchronous accessor that
 * lets the public getEnvironment API serve a value promptly while a slow initial resolution
 * runs in the background (avoids blocking consumers such as Pylance's configuration handler).
 */

import { Extension } from 'vscode';

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as typeMoq from 'typemoq';
import { EventEmitter, Uri } from 'vscode';
import {
    DidChangeEnvironmentEventArgs,
    DidChangeEnvironmentsEventArgs,
    EnvironmentManager,
    GetEnvironmentScope,
    PythonEnvironment,
    PythonEnvironmentId,
    PythonProject,
} from '../../api';
import * as extensionApis from '../../common/extension.apis';
import { InlineScriptMetadata } from '../../common/inlineScript/metadata';
import { InlineScriptRoutingRegistry } from '../../common/inlineScript/routingRegistry';
import { PythonEnvironmentManagers } from '../../features/envManagers';
import * as settingHelpers from '../../features/settings/settingHelpers';
import { InternalPackageManager, PythonProjectManager } from '../../internal.api';
import { setupNonThenable } from '../mocks/helper';

suite('PythonEnvironmentManagers getLastKnownEnvironment', () => {
    let envManagers: PythonEnvironmentManagers;
    let projectManager: typeMoq.IMock<PythonProjectManager>;
    let projectsByUri: Map<string, PythonProject>;
    let defaultManagerId: string;
    let exactManagerSettings: Map<string, string>;
    let routingRegistry: InlineScriptRoutingRegistry;

    const INLINE_METADATA: InlineScriptMetadata = {
        requiresPython: '>=3.11',
        dependencies: ['requests'],
        range: { start: 0, end: 40 },
    };

    function makeEnv(id: string): PythonEnvironment {
        const envId: PythonEnvironmentId = { id, managerId: 'test-manager' };
        return {
            envId,
            name: id,
            displayName: id,
            displayPath: `/path/${id}`,
            version: '3.11.0',
            environmentPath: Uri.file(`/path/${id}`),
            execInfo: { run: { executable: `/path/${id}/python`, args: [] } },
            sysPrefix: `/path/${id}`,
        } as PythonEnvironment;
    }

    setup(() => {
        const mockPythonExtension = { id: 'ms-python.python', extensionPath: '/mock/python/extension' };
        const mockEnvsExtension = { id: 'ms-python.vscode-python-envs', extensionPath: '/mock/envs/extension' };

        const getExtensionStub = sinon.stub(extensionApis, 'getExtension');
        getExtensionStub.withArgs('ms-python.python').returns(mockPythonExtension as Extension<unknown>);
        getExtensionStub.withArgs('ms-python.vscode-python-envs').returns(mockEnvsExtension as Extension<unknown>);
        sinon
            .stub(extensionApis, 'allExtensions')
            .returns([mockPythonExtension, mockEnvsExtension] as Extension<unknown>[]);

        projectManager = typeMoq.Mock.ofType<PythonProjectManager>();
        setupNonThenable(projectManager);
        projectsByUri = new Map();
        exactManagerSettings = new Map();
        routingRegistry = new InlineScriptRoutingRegistry();
        projectManager
            .setup((pm) => pm.get(typeMoq.It.isAny()))
            .returns((uri) => projectsByUri.get(uri.toString()));

        envManagers = new PythonEnvironmentManagers(projectManager.object, routingRegistry);
        sinon.stub(settingHelpers, 'getDefaultEnvManagerSetting').callsFake(() => defaultManagerId);
        sinon
            .stub(settingHelpers, 'getProjectEnvironmentManagerSetting')
            .callsFake((_manager, uri) => exactManagerSettings.get(uri.toString()));
    });

    teardown(() => {
        sinon.restore();
        envManagers.dispose();
    });

    function registerManager(
        getImpl: (scope: GetEnvironmentScope) => Promise<PythonEnvironment | undefined>,
        setImpl: EnvironmentManager['set'] = async () => undefined,
        name = 'test-env-mgr',
    ): string {
        const onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
        const onDidChangeEnvironments = new EventEmitter<DidChangeEnvironmentsEventArgs>();
        const manager = {
            name,
            displayName: 'Test Env Manager',
            preferredPackageManagerId: 'ms-python.python:pip',
            onDidChangeEnvironment: onDidChangeEnvironment.event,
            onDidChangeEnvironments: onDidChangeEnvironments.event,
            get: getImpl,
            getEnvironments: async () => [],
            set: setImpl,
            resolve: async () => undefined,
            refresh: async () => undefined,
        } as unknown as EnvironmentManager;

        const managerIndex = envManagers.managers.length;
        envManagers.registerEnvironmentManager(manager);
        const id = envManagers.managers[managerIndex].id;
        defaultManagerId = id;
        return id;
    }

    function stubPackageManager(id = 'ms-python.python:pip'): void {
        const packageManager = typeMoq.Mock.ofType<InternalPackageManager>();
        setupNonThenable(packageManager);
        packageManager.setup((manager) => manager.id).returns(() => id);
        sinon.stub(envManagers, 'getPackageManager').returns(packageManager.object);
    }

    function markInlineScript(uri: Uri, associated: boolean = true, metadata: InlineScriptMetadata = INLINE_METADATA): void {
        routingRegistry.setMetadata(uri, metadata);
        routingRegistry.setValidatedAssociation(uri, associated);
    }

    function recreateEnvManagersWithoutRouting(): void {
        envManagers.dispose();
        envManagers = new PythonEnvironmentManagers(projectManager.object);
    }

    test('returns undefined before any environment has been resolved', () => {
        registerManager(async () => makeEnv('env1'));
        assert.strictEqual(envManagers.getLastKnownEnvironment(undefined), undefined);
    });

    test('returns the active environment after it has been resolved', async () => {
        const env = makeEnv('env1');
        registerManager(async () => env);

        // Refreshing the active selection populates the last-known cache.
        await envManagers.refreshEnvironment(undefined);

        // Now available synchronously without any await or refresh.
        assert.strictEqual(envManagers.getLastKnownEnvironment(undefined), env);
    });

    test('reflects the most recent environment after it changes', async () => {
        let current = makeEnv('env1');
        registerManager(async () => current);

        await envManagers.refreshEnvironment(undefined);
        assert.strictEqual(envManagers.getLastKnownEnvironment(undefined)?.envId.id, 'env1');

        current = makeEnv('env2');
        await envManagers.refreshEnvironment(undefined);
        assert.strictEqual(envManagers.getLastKnownEnvironment(undefined)?.envId.id, 'env2');
    });

    test('does not update selection, settings, or events when a registered manager rejects a selection', async () => {
        const scope = Uri.file('/workspace/script.py');
        const project = { name: 'script.py', uri: scope };
        projectsByUri.set(scope.toString(), project);
        const managerSet = sinon.stub().rejects(new Error('Inline-script environment is not an owned cache entry.'));
        const managerId = registerManager(async () => undefined, managerSet);
        const rejected = {
            ...makeEnv('unowned'),
            envId: { id: 'unowned', managerId },
        };
        const settings = sinon.stub(settingHelpers, 'setAllManagerSettings').resolves();
        const events: DidChangeEnvironmentEventArgs[] = [];
        envManagers.onDidChangeActiveEnvironment((event) => events.push(event));

        await assert.rejects(envManagers.setEnvironment(scope, rejected), /not an owned cache entry/);
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(envManagers.getLastKnownEnvironment(scope), undefined);
        assert.strictEqual(settings.callCount, 0);
        assert.strictEqual(events.length, 0);
    });

    test('does not publish batch or global selections when the manager rejects', async () => {
        const scope = Uri.file('/workspace/script.py');
        const managerSet = sinon.stub().rejects(new Error('selection rejected'));
        const managerId = registerManager(async () => undefined, managerSet);
        const rejected = {
            ...makeEnv('rejected'),
            envId: { id: 'rejected', managerId },
        };
        const settings = sinon.stub(settingHelpers, 'setAllManagerSettings').resolves();
        const events: DidChangeEnvironmentEventArgs[] = [];
        envManagers.onDidChangeActiveEnvironment((event) => events.push(event));

        await assert.rejects(envManagers.setEnvironments([scope], rejected, false), /selection rejected/);
        await assert.rejects(envManagers.setEnvironments('global', rejected, false), /selection rejected/);
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(envManagers.getLastKnownEnvironment(scope), undefined);
        assert.strictEqual(envManagers.getLastKnownEnvironment(undefined), undefined);
        assert.strictEqual(settings.callCount, 0);
        assert.strictEqual(events.length, 0);
    });

    test('passes same-manager batch unsets to the manager atomically', async () => {
        const first = Uri.file('/workspace/first.py');
        const second = Uri.file('/workspace/second.py');
        const managerSet = sinon.stub().resolves();
        registerManager(async () => undefined, managerSet);

        await envManagers.setEnvironments([first, second], undefined, false);

        sinon.assert.calledOnceWithExactly(managerSet, [first, second], undefined);
    });

    test('does not let an older same-manager refresh overwrite a newer selection', async () => {
        const initial = makeEnv('initial');
        let resolveStaleRefresh: ((environment: PythonEnvironment) => void) | undefined;
        const staleRefresh = new Promise<PythonEnvironment>((resolve) => {
            resolveStaleRefresh = resolve;
        });
        const managerGet = sinon.stub();
        managerGet.onFirstCall().resolves(initial);
        managerGet.onSecondCall().returns(staleRefresh);
        const managerId = registerManager(managerGet);
        const selected = {
            ...makeEnv('selected'),
            envId: { id: 'selected', managerId },
        };

        await envManagers.refreshEnvironment(undefined);
        const refresh = envManagers.refreshEnvironment(undefined);
        await envManagers.setEnvironment(undefined, selected, false);
        resolveStaleRefresh!(initial);
        await refresh;

        assert.strictEqual(envManagers.getLastKnownEnvironment(undefined), selected);
    });

    test('retains an in-flight refresh when a concurrent selection fails', async () => {
        const refreshed = makeEnv('refreshed');
        let resolveRefresh: ((environment: PythonEnvironment) => void) | undefined;
        const managerGet = sinon.stub().returns(
            new Promise<PythonEnvironment>((resolve) => {
                resolveRefresh = resolve;
            }),
        );
        const managerId = registerManager(managerGet, sinon.stub().rejects(new Error('selection rejected')));
        const rejected = {
            ...makeEnv('rejected'),
            envId: { id: 'rejected', managerId },
        };

        const refresh = envManagers.refreshEnvironment(undefined);
        await assert.rejects(envManagers.setEnvironment(undefined, rejected, false), /selection rejected/);
        resolveRefresh!(refreshed);
        await refresh;

        assert.strictEqual(envManagers.getLastKnownEnvironment(undefined), refreshed);
    });

    test('does not publish an older selection after a newer settings write finishes first', async () => {
        const scope = Uri.file('/workspace/script.py');
        const project = { name: 'script.py', uri: scope };
        projectsByUri.set(scope.toString(), project);
        const managerId = registerManager(async () => undefined, async () => undefined, 'inline-script');
        const first = { ...makeEnv('first'), envId: { id: 'first', managerId } };
        const second = { ...makeEnv('second'), envId: { id: 'second', managerId } };
        stubPackageManager();
        let releaseFirstWrite: (() => void) | undefined;
        let signalFirstWrite: (() => void) | undefined;
        const firstWriteStarted = new Promise<void>((resolve) => {
            signalFirstWrite = resolve;
        });
        const firstWrite = new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
        });
        const settings = sinon.stub(settingHelpers, 'setAllManagerSettings');
        settings.onFirstCall().callsFake(async () => {
            signalFirstWrite!();
            await firstWrite;
        });
        settings.onSecondCall().resolves();
        const events: DidChangeEnvironmentEventArgs[] = [];
        envManagers.onDidChangeActiveEnvironment((event) => events.push(event));
        markInlineScript(scope);

        const olderSelection = envManagers.setEnvironment(scope, first);
        await firstWriteStarted;
        await envManagers.setEnvironment(scope, second);
        releaseFirstWrite!();
        await olderSelection;

        assert.strictEqual(envManagers.getLastKnownEnvironment(scope), second);
        assert.deepStrictEqual(events.map((event) => event.new), [second]);
    });

    test('publishes inline environments with the same ID at different paths', async () => {
        const scope = Uri.file('/workspace/script.py');
        const managerId = registerManager(async () => undefined, async () => undefined, 'inline-script');
        const first = {
            ...makeEnv('duplicate'),
            envId: { id: 'duplicate', managerId },
            environmentPath: Uri.file('/env/first/python'),
        };
        const second = {
            ...makeEnv('duplicate'),
            envId: { id: 'duplicate', managerId },
            environmentPath: Uri.file('/env/second/python'),
        };
        const events: DidChangeEnvironmentEventArgs[] = [];
        envManagers.onDidChangeActiveEnvironment((event) => events.push(event));
        markInlineScript(scope);

        await envManagers.setEnvironment(scope, first, false);
        await envManagers.setEnvironment(scope, second, false);

        assert.strictEqual(envManagers.getLastKnownEnvironment(scope), second);
        assert.deepStrictEqual(events.map((event) => event.new), [first, second]);
    });

    test('publishes same-path inline rebuilds but ignores generated-ID-only changes', async () => {
        const scope = Uri.file('/workspace/script.py');
        const managerId = registerManager(async () => undefined, async () => undefined, 'inline-script');
        const environmentPath = Uri.file('/env/inline/python');
        const first = {
            ...makeEnv('first'),
            envId: { id: 'first', managerId },
            environmentPath,
            version: '3.12.0',
        };
        const regenerated = {
            ...first,
            envId: { id: 'regenerated', managerId },
        };
        const rebuilt = {
            ...regenerated,
            envId: { id: 'rebuilt', managerId },
            version: '3.13.0',
        };
        const events: DidChangeEnvironmentEventArgs[] = [];
        envManagers.onDidChangeActiveEnvironment((event) => events.push(event));
        markInlineScript(scope);

        await envManagers.setEnvironment(scope, first, false);
        await envManagers.setEnvironment(scope, regenerated, false);
        await envManagers.setEnvironment(scope, rebuilt, false);

        assert.strictEqual(envManagers.getLastKnownEnvironment(scope), rebuilt);
        assert.deepStrictEqual(events.map((event) => event.new), [first, rebuilt]);
    });

    test('publishes completed manager groups before a later group rejects', async () => {
        const firstScope = Uri.file('/workspace/first.py');
        const secondScope = Uri.file('/workspace/second.py');
        const firstProject = { name: 'first.py', uri: firstScope };
        const secondProject = { name: 'second.py', uri: secondScope };
        projectsByUri.set(firstScope.toString(), firstProject);
        projectsByUri.set(secondScope.toString(), secondProject);
        const firstSet = sinon.stub().resolves();
        const firstId = registerManager(async () => undefined, firstSet, 'first-manager');
        const secondSet = sinon.stub();
        secondSet.onFirstCall().resolves();
        secondSet.onSecondCall().rejects(new Error('second group rejected'));
        const secondId = registerManager(async () => undefined, secondSet, 'second-manager');
        const firstEnvironment = { ...makeEnv('first'), envId: { id: 'first', managerId: firstId } };
        const secondEnvironment = { ...makeEnv('second'), envId: { id: 'second', managerId: secondId } };
        await envManagers.setEnvironment(firstScope, firstEnvironment, false);
        await envManagers.setEnvironment(secondScope, secondEnvironment, false);
        exactManagerSettings.set(firstScope.toString(), firstId);
        exactManagerSettings.set(secondScope.toString(), secondId);
        const events: DidChangeEnvironmentEventArgs[] = [];
        envManagers.onDidChangeActiveEnvironment((event) => events.push(event));

        await assert.rejects(
            envManagers.setEnvironments([firstScope, secondScope], undefined, false),
            /second group rejected/,
        );

        assert.strictEqual(envManagers.getLastKnownEnvironment(firstScope), undefined);
        assert.strictEqual(envManagers.getLastKnownEnvironment(secondScope), secondEnvironment);
        assert.deepStrictEqual(events, [{ uri: firstScope, old: firstEnvironment, new: undefined }]);
    });

    test('tracks inline-script selections independently for scripts in the same project', async () => {
        const firstUri = Uri.file('/workspace/first.py');
        const secondUri = Uri.file('/workspace/second.py');
        const managerId = registerManager(async () => undefined, async () => undefined, 'inline-script');
        const first = { ...makeEnv('first'), envId: { id: 'first', managerId } };
        const second = { ...makeEnv('second'), envId: { id: 'second', managerId } };
        markInlineScript(firstUri);
        markInlineScript(secondUri);

        await envManagers.setEnvironment(firstUri, first, false);
        await envManagers.setEnvironment(secondUri, second, false);

        assert.strictEqual(envManagers.getLastKnownEnvironment(firstUri), first);
        assert.strictEqual(envManagers.getLastKnownEnvironment(secondUri), second);
    });

    test('does not route inline metadata without an associated environment', () => {
        const script = Uri.file('/workspace/project/script.py');
        projectsByUri.set(script.toString(), { name: 'project', uri: Uri.file('/workspace/project') });
        const defaultId = registerManager(async () => makeEnv('default'), async () => undefined, 'venv');
        registerManager(async () => makeEnv('inline'), async () => undefined, 'inline-script');
        defaultManagerId = defaultId;
        routingRegistry.setMetadata(script, INLINE_METADATA);

        assert.strictEqual(envManagers.getEnvironmentManager(script)?.id, defaultId);
    });

    test('does not route an associated inline environment without known metadata', () => {
        const script = Uri.file('/workspace/project/script.py');
        projectsByUri.set(script.toString(), { name: 'project', uri: Uri.file('/workspace/project') });
        const defaultId = registerManager(async () => makeEnv('default'), async () => undefined, 'venv');
        registerManager(async () => makeEnv('inline'), async () => undefined, 'inline-script');
        defaultManagerId = defaultId;
        routingRegistry.setValidatedAssociation(script, true);

        assert.strictEqual(envManagers.getEnvironmentManager(script)?.id, defaultId);
    });

    test('without a routing registry, does not route metadata-only inline associations', () => {
        recreateEnvManagersWithoutRouting();
        const shouldRouteSpy = sinon.spy(InlineScriptRoutingRegistry.prototype, 'shouldRoute');
        const script = Uri.file('/workspace/project/script.py');
        projectsByUri.set(script.toString(), { name: 'project', uri: Uri.file('/workspace/project') });
        const defaultId = registerManager(async () => makeEnv('default'), async () => undefined, 'venv');
        registerManager(async () => makeEnv('inline'), async () => undefined, 'inline-script');
        defaultManagerId = defaultId;
        routingRegistry.setMetadata(script, INLINE_METADATA);
        routingRegistry.setValidatedAssociation(script, true);

        assert.strictEqual(envManagers.getEnvironmentManager(script)?.id, defaultId);
        assert.strictEqual(shouldRouteSpy.called, false, 'off-mode should not consult inline routeability');
    });

    test('without a routing registry, keeps baseline cached inline selections without routeability checks', async () => {
        recreateEnvManagersWithoutRouting();
        const shouldRouteSpy = sinon.spy(InlineScriptRoutingRegistry.prototype, 'shouldRoute');
        const script = Uri.file('/workspace/project/script.py');
        projectsByUri.set(script.toString(), { name: 'project', uri: Uri.file('/workspace/project') });
        const defaultId = registerManager(async () => makeEnv('default'), async () => undefined, 'venv');
        let inlineEnvironment: PythonEnvironment;
        const inlineId = registerManager(async () => inlineEnvironment, async () => undefined, 'inline-script');
        inlineEnvironment = { ...makeEnv('inline'), envId: { id: 'inline', managerId: inlineId } };
        defaultManagerId = defaultId;

        await envManagers.setEnvironment(script, inlineEnvironment, false);

        assert.strictEqual(envManagers.getEnvironmentManager(script)?.id, inlineId);
        assert.strictEqual(await envManagers.getEnvironment(script), inlineEnvironment);
        assert.strictEqual(envManagers.getLastKnownEnvironment(script), inlineEnvironment);
        assert.strictEqual(shouldRouteSpy.called, false, 'off-mode should not consult inline routeability');
    });

    test('routes an active inline-script selection before the containing project default', async () => {
        const script = Uri.file('/workspace/project/script.py');
        projectsByUri.set(script.toString(), { name: 'project', uri: Uri.file('/workspace/project') });
        const defaultId = registerManager(async () => makeEnv('default'), async () => undefined, 'venv');
        let inlineEnvironment: PythonEnvironment;
        const inlineId = registerManager(async () => inlineEnvironment, async () => undefined, 'inline-script');
        inlineEnvironment = { ...makeEnv('inline'), envId: { id: 'inline', managerId: inlineId } };
        defaultManagerId = defaultId;
        markInlineScript(script);

        await envManagers.setEnvironment(script, inlineEnvironment, false);

        assert.strictEqual(envManagers.getEnvironmentManager(script)?.id, inlineId);
        assert.strictEqual(await envManagers.getEnvironment(script), inlineEnvironment);
    });

    test('lets an exact script project setting override an active inline selection', async () => {
        const script = Uri.file('/workspace/script.py');
        projectsByUri.set(script.toString(), { name: 'script.py', uri: script });
        const selectedId = registerManager(async () => makeEnv('selected'), async () => undefined, 'venv');
        let inlineEnvironment: PythonEnvironment;
        const inlineId = registerManager(async () => inlineEnvironment, async () => undefined, 'inline-script');
        inlineEnvironment = { ...makeEnv('inline'), envId: { id: 'inline', managerId: inlineId } };
        defaultManagerId = selectedId;
        markInlineScript(script);

        await envManagers.setEnvironment(script, inlineEnvironment, false);
        exactManagerSettings.set(script.toString(), selectedId);

        assert.strictEqual(envManagers.getEnvironmentManager(script)?.id, selectedId);
    });

    test('clears active inline routing after selecting a different manager', async () => {
        const script = Uri.file('/workspace/project/script.py');
        projectsByUri.set(script.toString(), { name: 'project', uri: Uri.file('/workspace/project') });
        let selectedEnvironment: PythonEnvironment;
        const selectedId = registerManager(async () => selectedEnvironment, async () => undefined, 'venv');
        let inlineEnvironment: PythonEnvironment;
        const inlineId = registerManager(async () => inlineEnvironment, async () => undefined, 'inline-script');
        selectedEnvironment = { ...makeEnv('selected'), envId: { id: 'selected', managerId: selectedId } };
        inlineEnvironment = { ...makeEnv('inline'), envId: { id: 'inline', managerId: inlineId } };
        defaultManagerId = selectedId;
        markInlineScript(script);

        await envManagers.setEnvironment(script, inlineEnvironment, false);
        await envManagers.setEnvironment(script, selectedEnvironment, false);

        assert.strictEqual(envManagers.getEnvironmentManager(script)?.id, selectedId);
    });

    test('ignores routeability changes while an explicit non-inline override wins', async () => {
        const script = Uri.file('/workspace/project/script.py');
        projectsByUri.set(script.toString(), { name: 'project', uri: Uri.file('/workspace/project') });
        let selectedEnvironment: PythonEnvironment;
        const selectedId = registerManager(async () => selectedEnvironment, async () => undefined, 'venv');
        let inlineEnvironment: PythonEnvironment;
        const inlineId = registerManager(async () => inlineEnvironment, async () => undefined, 'inline-script');
        selectedEnvironment = { ...makeEnv('selected'), envId: { id: 'selected', managerId: selectedId } };
        inlineEnvironment = { ...makeEnv('inline'), envId: { id: 'inline', managerId: inlineId } };
        defaultManagerId = selectedId;
        markInlineScript(script);

        await envManagers.setEnvironment(script, inlineEnvironment, false);
        await envManagers.setEnvironment(script, selectedEnvironment, false);
        await new Promise((resolve) => setImmediate(resolve));

        const events: DidChangeEnvironmentEventArgs[] = [];
        envManagers.onDidChangeActiveEnvironment((event) => events.push(event));
        routingRegistry.clearMetadata(script);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        assert.deepStrictEqual(events, []);
        assert.strictEqual(envManagers.getEnvironmentManager(script)?.id, selectedId);
        assert.strictEqual(envManagers.getLastKnownEnvironment(script), selectedEnvironment);
    });

    test('clears inline routing after a no-op inline refresh during settings persistence', async () => {
        const script = Uri.file('/workspace/project/script.py');
        projectsByUri.set(script.toString(), { name: 'project', uri: Uri.file('/workspace/project') });
        let selectedEnvironment: PythonEnvironment;
        const selectedId = registerManager(async () => selectedEnvironment, async () => undefined, 'venv');
        let inlineEnvironment: PythonEnvironment;
        const inlineId = registerManager(async () => inlineEnvironment, async () => undefined, 'inline-script');
        selectedEnvironment = { ...makeEnv('selected'), envId: { id: 'selected', managerId: selectedId } };
        inlineEnvironment = { ...makeEnv('inline'), envId: { id: 'inline', managerId: inlineId } };
        defaultManagerId = selectedId;
        markInlineScript(script);
        await envManagers.setEnvironment(script, inlineEnvironment, false);
        stubPackageManager();
        let releaseSettings: (() => void) | undefined;
        let signalSettings: (() => void) | undefined;
        const settingsStarted = new Promise<void>((resolve) => {
            signalSettings = resolve;
        });
        const settingsGate = new Promise<void>((resolve) => {
            releaseSettings = resolve;
        });
        sinon.stub(settingHelpers, 'setAllManagerSettings').callsFake(async () => {
            signalSettings!();
            await settingsGate;
        });

        const selection = envManagers.setEnvironment(script, selectedEnvironment);
        await settingsStarted;
        await envManagers.refreshEnvironment(script);
        releaseSettings!();
        await selection;

        assert.strictEqual(envManagers.getEnvironmentManager(script)?.id, selectedId);
        assert.strictEqual(envManagers.getLastKnownEnvironment(script), selectedEnvironment);
    });

    test('refreshes to the inline manager when a persisted association becomes routeable', async () => {
        const script = Uri.file('/workspace/project/script.py');
        projectsByUri.set(script.toString(), { name: 'project', uri: Uri.file('/workspace/project') });
        const defaultEnvironment = makeEnv('default');
        const defaultId = registerManager(async () => defaultEnvironment, async () => undefined, 'venv');
        let inlineEnvironment: PythonEnvironment;
        const inlineId = registerManager(async () => inlineEnvironment, async () => undefined, 'inline-script');
        inlineEnvironment = { ...makeEnv('inline'), envId: { id: 'inline', managerId: inlineId } };
        defaultManagerId = defaultId;
        routingRegistry.setMetadata(script, INLINE_METADATA);

        await envManagers.refreshEnvironment(script);
        routingRegistry.setValidatedAssociation(script, true);
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(envManagers.getEnvironmentManager(script)?.id, inlineId);
        assert.strictEqual(envManagers.getLastKnownEnvironment(script), inlineEnvironment);
    });

    test('does not publish an inline selection while routeability is false, then publishes once when it validates', async () => {
        const script = Uri.file('/workspace/project/script.py');
        const project = { name: 'project', uri: Uri.file('/workspace/project') };
        projectsByUri.set(script.toString(), project);
        const defaultEnvironment = makeEnv('default');
        const defaultId = registerManager(async () => defaultEnvironment, async () => undefined, 'venv');
        let inlineEnvironment: PythonEnvironment;
        const inlineId = registerManager(async () => inlineEnvironment, async () => undefined, 'inline-script');
        inlineEnvironment = { ...makeEnv('inline'), envId: { id: 'inline', managerId: inlineId } };
        defaultManagerId = defaultId;

        await envManagers.refreshEnvironment(script);
        await new Promise((resolve) => setImmediate(resolve));
        const events: DidChangeEnvironmentEventArgs[] = [];
        envManagers.onDidChangeActiveEnvironment((event) => events.push(event));

        await envManagers.setEnvironment(script, inlineEnvironment, false);
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(envManagers.getEnvironmentManager(script)?.id, defaultId);
        assert.strictEqual(envManagers.getLastKnownEnvironment(script), defaultEnvironment);
        assert.deepStrictEqual(events, []);

        routingRegistry.setMetadata(script, INLINE_METADATA);
        routingRegistry.setValidatedAssociation(script, true);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(envManagers.getEnvironmentManager(script)?.id, inlineId);
        assert.strictEqual(envManagers.getLastKnownEnvironment(script), inlineEnvironment);
        assert.deepStrictEqual(events, [{ uri: script, old: defaultEnvironment, new: inlineEnvironment }]);
    });

    test('does not publish batch inline selections until each script becomes routeable', async () => {
        const first = Uri.file('/workspace/project/first.py');
        const second = Uri.file('/workspace/project/second.py');
        const project = { name: 'project', uri: Uri.file('/workspace/project') };
        projectsByUri.set(first.toString(), project);
        projectsByUri.set(second.toString(), project);
        const defaultEnvironment = makeEnv('default');
        const defaultId = registerManager(async () => defaultEnvironment, async () => undefined, 'venv');
        let inlineEnvironment: PythonEnvironment;
        const inlineId = registerManager(async () => inlineEnvironment, async () => undefined, 'inline-script');
        inlineEnvironment = { ...makeEnv('inline'), envId: { id: 'inline', managerId: inlineId } };
        defaultManagerId = defaultId;

        await envManagers.refreshEnvironment(first);
        await envManagers.refreshEnvironment(second);
        await new Promise((resolve) => setImmediate(resolve));
        const events: DidChangeEnvironmentEventArgs[] = [];
        envManagers.onDidChangeActiveEnvironment((event) => events.push(event));

        await envManagers.setEnvironments([first, second], inlineEnvironment, false);
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(envManagers.getLastKnownEnvironment(first), defaultEnvironment);
        assert.strictEqual(envManagers.getLastKnownEnvironment(second), defaultEnvironment);
        assert.deepStrictEqual(events, []);

        routingRegistry.setMetadata(first, INLINE_METADATA);
        routingRegistry.setValidatedAssociation(first, true);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(envManagers.getLastKnownEnvironment(first), inlineEnvironment);
        assert.strictEqual(envManagers.getLastKnownEnvironment(second), defaultEnvironment);
        assert.deepStrictEqual(events, [{ uri: first, old: defaultEnvironment, new: inlineEnvironment }]);
    });

    test('falls back when inline-script metadata is invalidated after routing', async () => {
        const script = Uri.file('/workspace/project/script.py');
        const project = { name: 'project', uri: Uri.file('/workspace/project') };
        projectsByUri.set(script.toString(), project);
        const defaultEnvironment = makeEnv('default');
        const defaultId = registerManager(async () => defaultEnvironment, async () => undefined, 'venv');
        let inlineEnvironment: PythonEnvironment;
        const inlineId = registerManager(async () => inlineEnvironment, async () => undefined, 'inline-script');
        inlineEnvironment = { ...makeEnv('inline'), envId: { id: 'inline', managerId: inlineId } };
        defaultManagerId = defaultId;
        await envManagers.refreshEnvironment(script);
        markInlineScript(script);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        const events: DidChangeEnvironmentEventArgs[] = [];
        envManagers.onDidChangeActiveEnvironment((event) => events.push(event));
        routingRegistry.clearMetadata(script);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(envManagers.getEnvironmentManager(script)?.id, defaultId);
        assert.strictEqual(envManagers.getLastKnownEnvironment(script), defaultEnvironment);
        assert.deepStrictEqual(events[events.length - 1], {
            uri: project.uri,
            old: inlineEnvironment,
            new: defaultEnvironment,
        });
    });

    test('ignores routeable inline state when the inline manager is not registered', () => {
        const script = Uri.file('/workspace/project/script.py');
        projectsByUri.set(script.toString(), { name: 'project', uri: Uri.file('/workspace/project') });
        const defaultId = registerManager(async () => makeEnv('default'), async () => undefined, 'venv');
        defaultManagerId = defaultId;
        markInlineScript(script);

        assert.strictEqual(envManagers.getEnvironmentManager(script)?.id, defaultId);
    });

    test('does not persist an inline-script manager for the containing project', async () => {
        const script = Uri.file('/workspace/project/script.py');
        const containingProject = { name: 'project', uri: Uri.file('/workspace/project') };
        projectsByUri.set(script.toString(), containingProject);
        const managerId = registerManager(async () => undefined, async () => undefined, 'inline-script');
        const environment = { ...makeEnv('inline'), envId: { id: 'inline', managerId } };
        stubPackageManager();
        const settings = sinon.stub(settingHelpers, 'setAllManagerSettings').resolves();

        await envManagers.setEnvironment(script, environment);

        assert.strictEqual(settings.callCount, 0);
    });

    test('persists an inline-script manager when the script is its own project', async () => {
        const script = Uri.file('/workspace/script.py');
        const scriptProject = { name: 'script.py', uri: script };
        projectsByUri.set(script.toString(), scriptProject);
        const managerId = registerManager(async () => undefined, async () => undefined, 'inline-script');
        const environment = { ...makeEnv('inline'), envId: { id: 'inline', managerId } };
        stubPackageManager();
        const settings = sinon.stub(settingHelpers, 'setAllManagerSettings').resolves();

        await envManagers.setEnvironment(script, environment);

        sinon.assert.calledOnce(settings);
        assert.deepStrictEqual(settings.firstCall.args[0], [
            {
                project: scriptProject,
                envManager: managerId,
                packageManager: 'ms-python.python:pip',
            },
        ]);
    });

    test('persists batch inline settings only for scripts registered as exact projects', async () => {
        const exactScript = Uri.file('/workspace/exact.py');
        const nestedScript = Uri.file('/workspace/project/nested.py');
        const looseScript = Uri.file('/outside/loose.py');
        const exactProject = { name: 'exact.py', uri: exactScript };
        const containingProject = { name: 'project', uri: Uri.file('/workspace/project') };
        projectsByUri.set(exactScript.toString(), exactProject);
        projectsByUri.set(nestedScript.toString(), containingProject);
        const managerId = registerManager(async () => undefined, async () => undefined, 'inline-script');
        const environment = { ...makeEnv('inline'), envId: { id: 'inline', managerId } };
        const settings = sinon.stub(settingHelpers, 'setAllManagerSettings').resolves();

        await envManagers.setEnvironments([exactScript, nestedScript, looseScript], environment);

        sinon.assert.calledOnce(settings);
        assert.deepStrictEqual(settings.firstCall.args[0], [
            {
                project: exactProject,
                envManager: managerId,
                packageManager: 'ms-python.python:pip',
            },
        ]);
    });

    test('retains an earlier successful refresh when a later refresh fails', async () => {
        const refreshed = makeEnv('refreshed');
        let resolveFirst: ((environment: PythonEnvironment) => void) | undefined;
        const managerGet = sinon.stub();
        managerGet.onFirstCall().returns(
            new Promise<PythonEnvironment>((resolve) => {
                resolveFirst = resolve;
            }),
        );
        managerGet.onSecondCall().rejects(new Error('refresh rejected'));
        registerManager(managerGet);

        const first = envManagers.refreshEnvironment(undefined);
        await assert.rejects(envManagers.refreshEnvironment(undefined), /refresh rejected/);
        resolveFirst!(refreshed);
        await first;

        assert.strictEqual(envManagers.getLastKnownEnvironment(undefined), refreshed);
    });
});
