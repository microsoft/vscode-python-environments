// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { It, Mock } from 'typemoq';
import { Disposable, EventEmitter, Extension, Uri } from 'vscode';
import type {
    DidChangeEnvironmentVariablesEventArgs,
    EnvironmentManager,
    PackageManager,
    PythonEnvironment,
    PythonProject,
} from '../api';
import type { CapabilityContext, Support } from '../capabilities';
import * as extensionApis from '../common/extension.apis';
import * as frameUtils from '../common/utils/frameUtils';
import * as windowApis from '../common/window.apis';
import { createDeferred } from '../common/utils/deferred';
import { PythonEnvironmentApiImpl } from '../extensionApi';
import {
    _resetManagerReadyForTesting,
    createManagerReady,
    MANAGER_READY_TIMEOUT_MS,
    waitForEnvManagerId,
    waitForManagerForQuery,
} from '../features/common/managerReady';
import { PythonEnvironmentManagers } from '../features/envManagers';
import type { PythonProjectManager } from '../features/projectManager';
import * as settings from '../features/settings/settingHelpers';

suite('PythonEnvironmentApiImpl - capability queries', () => {
    const extensionId = 'test.capabilities';
    const ownerId = `${extensionId}:owner`;
    const packageId = `${extensionId}:packages`;
    const project: PythonProject = { name: 'project', uri: Uri.joinPath(Uri.file(process.cwd()), 'project') };
    const environment: PythonEnvironment = {
        envId: { managerId: ownerId, id: 'environment' },
        name: 'environment',
        displayName: 'environment',
        displayPath: process.cwd(),
        version: '3.12.0',
        environmentPath: Uri.file(process.cwd()),
        execInfo: { run: { executable: 'python' } },
        sysPrefix: process.cwd(),
    };
    let clock: sinon.SinonFakeTimers;
    let api: PythonEnvironmentApiImpl;
    let managers: PythonEnvironmentManagers;
    let projectManager: PythonProjectManager;
    let projects: PythonProject[];
    let disposables: Disposable[];
    let getExtension: sinon.SinonStub;
    let configuredPackage: sinon.SinonStub;
    let selectedEnvironment: sinon.SinonStub;
    let envProbe: sinon.SinonStub<[CapabilityContext], Promise<Support>>;
    let pkgProbe: sinon.SinonStub<[CapabilityContext], Promise<Support>>;

    setup(() => {
        clock = sinon.useFakeTimers();
        _resetManagerReadyForTesting();
        disposables = [];
        projects = [project];
        getExtension = sinon.stub(extensionApis, 'getExtension').returns(undefined);
        sinon.stub(frameUtils, 'getCallingExtension').returns(extensionId);
        sinon.stub(windowApis, 'showErrorMessage').resolves(undefined);
        sinon.stub(windowApis, 'showQuickPick').resolves(undefined);
        sinon.stub(settings, 'getDefaultEnvManagerSetting').returns(ownerId);
        configuredPackage = sinon.stub(settings, 'getDefaultPkgManagerSetting').returns(packageId);
        const projectChanges = new EventEmitter<PythonProject[]>();
        const variablesChanged = new EventEmitter<DidChangeEnvironmentVariablesEventArgs>();
        disposables.push(projectChanges, variablesChanged);
        const pm = Mock.ofType<PythonProjectManager>();
        pm.setup((m) => m.getProjects()).returns(() => projects);
        pm.setup((m) => m.get(It.isAny())).returns((uri: Uri) =>
            projects.find((candidate) => candidate.uri.toString() === uri.toString()),
        );
        pm.setup((m) => m.onDidChangeProjects).returns(() => projectChanges.event);
        projectManager = pm.object;
        managers = new PythonEnvironmentManagers(projectManager);
        selectedEnvironment = sinon.stub(managers, 'getLastKnownEnvironment').returns(environment);
        type ApiArgs = ConstructorParameters<typeof PythonEnvironmentApiImpl>;
        const variables = Mock.ofType<ApiArgs[4]>();
        variables.setup((m) => m.onDidChangeEnvironmentVariables).returns(() => variablesChanged.event);
        api = new PythonEnvironmentApiImpl(
            managers,
            projectManager,
            Mock.ofType<ApiArgs[2]>().object,
            Mock.ofType<ApiArgs[3]>().object,
            variables.object,
            disposables,
        );
        envProbe = sinon.stub<[CapabilityContext], Promise<Support>>().resolves({ supported: true });
        pkgProbe = sinon.stub<[CapabilityContext], Promise<Support>>().resolves({ supported: true });
    });

    teardown(() => {
        managers.dispose();
        disposables.forEach((item) => item.dispose());
        assert.ok((windowApis.showErrorMessage as sinon.SinonStub).notCalled);
        assert.ok((windowApis.showQuickPick as sinon.SinonStub).notCalled);
        sinon.restore();
        _resetManagerReadyForTesting();
    });

    function registerOwner(): Disposable {
        const provider: EnvironmentManager = {
            name: 'owner',
            preferredPackageManagerId: packageId,
            refresh: async () => {},
            getEnvironments: async () => [],
            get: async () => undefined,
            set: async () => {},
            resolve: async () => undefined,
            capabilities: { 'environments.list': envProbe },
        };
        return managers.registerEnvironmentManager(provider, { extensionId });
    }

    function packageProvider(name = 'packages'): PackageManager {
        return {
            name,
            manage: async () => {},
            refresh: async () => {},
            getPackages: async () => [],
            capabilities: { 'packages.list': pkgProbe },
        };
    }

    function registerPackages(scoped = false, name = 'packages'): sinon.SinonStub | undefined {
        const provider = packageProvider(name);
        const create = scoped ? sinon.stub().callsFake(() => packageProvider(name)) : undefined;
        managers.registerPackageManager({ ...provider, createForProject: create }, { extensionId });
        return create;
    }

    function installedExtension(activate: () => Promise<void>): void {
        const extension = Mock.ofType<Extension<void>>();
        extension.setup((e) => e.isActive).returns(() => false);
        extension.setup((e) => e.activate()).returns(activate);
        getExtension.returns(extension.object);
    }

    test('queries only the explicit environment manager before readiness initialization', async () => {
        registerOwner();
        const context = { environment, project, scope: project.uri };
        assert.deepStrictEqual(await api.getEnvironmentCapability(ownerId, 'environments.list', context), {
            supported: true,
        });
        assert.ok(envProbe.calledOnceWithExactly(context));
        assert.ok(getExtension.notCalled);
    });

    test('rejects contradictory environment ownership before waiting or probing', async () => {
        registerOwner();
        await assert.rejects(api.getEnvironmentCapability('other:manager', 'environments.list', { environment }));
        assert.ok(envProbe.notCalled);
        assert.ok(getExtension.notCalled);
    });

    test('missing environment manager returns a reason after a noninteractive bounded wait', async () => {
        const pending = api.getEnvironmentCapability(ownerId, 'environments.list');
        await clock.tickAsync(MANAGER_READY_TIMEOUT_MS);
        const support = await pending;
        assert.ok(!support.supported && support.reason.includes(ownerId));
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('waits for pending environment registration', async () => {
        const pending = api.getEnvironmentCapability(ownerId, 'environments.list');
        await clock.tickAsync(1);
        registerOwner();
        assert.deepStrictEqual(await pending, { supported: true });
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('activation failures reject even when the extension registers before rejecting', async () => {
        const failure = new Error('activation failed');
        installedExtension(async () => {
            registerOwner();
            throw failure;
        });
        await assert.rejects(api.getEnvironmentCapability(ownerId, 'environments.list'), (error) => error === failure);
        assert.ok(envProbe.notCalled);
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('a hung activation is bounded and a later query sees registration', async () => {
        const activation = createDeferred<void>();
        installedExtension(() => activation.promise);
        const pending = api.getEnvironmentCapability(ownerId, 'environments.list');
        await clock.tickAsync(MANAGER_READY_TIMEOUT_MS);
        assert.strictEqual((await pending).supported, false);
        registerOwner();
        assert.strictEqual((await api.getEnvironmentCapability(ownerId, 'environments.list')).supported, true);
        activation.resolve();
    });

    test('environment probes reject without converting the error to unsupported', async () => {
        registerOwner();
        const failure = new Error('probe failed');
        envProbe.rejects(failure);
        await assert.rejects(api.getEnvironmentCapability(ownerId, 'environments.list'), (error) => error === failure);
    });

    test('does not cache capability results', async () => {
        registerOwner();
        envProbe.onSecondCall().resolves({ supported: false, reason: 'tool removed' });
        assert.strictEqual((await api.getEnvironmentCapability(ownerId, 'environments.list')).supported, true);
        assert.deepStrictEqual(await api.getEnvironmentCapability(ownerId, 'environments.list'), {
            supported: false,
            reason: 'tool removed',
        });
    });

    test('queries the preferred non-project package provider without project inference', async () => {
        projects = [];
        registerOwner();
        registerPackages();
        assert.strictEqual((await api.getPackageCapability(environment, 'packages.list')).supported, true);
        assert.strictEqual(pkgProbe.firstCall.args[0].environment, environment);
        assert.ok(selectedEnvironment.notCalled);
    });

    test('explicit project selects its configured scoped provider without waiting for the owner', async () => {
        configuredPackage.returns(`${extensionId}:configured`);
        const create = registerPackages(true, 'configured');
        assert.strictEqual((await api.getPackageCapability(environment, 'packages.list', project)).supported, true);
        assert.ok(create?.calledOnceWithExactly(project));
        assert.strictEqual(pkgProbe.firstCall.args[0].project, project);
        assert.strictEqual(pkgProbe.firstCall.args[0].environment, environment);
        assert.ok(configuredPackage.calledWithExactly(projectManager, project.uri));
        assert.ok(getExtension.notCalled);
    });

    test('explicit project waits for its configured provider rather than the preferred root', async () => {
        configuredPackage.returns(`${extensionId}:configured`);
        const pending = api.getPackageCapability(environment, 'packages.list', project);
        await clock.tickAsync(1);
        registerPackages(true, 'configured');
        assert.strictEqual((await pending).supported, true);
        assert.strictEqual(pkgProbe.firstCall.args[0].project, project);
    });

    test('environment routing infers a unique project and waits for its different configured provider', async () => {
        registerOwner();
        const preferredFactory = registerPackages(true);
        configuredPackage.returns(`${extensionId}:configured`);
        const pending = api.getPackageCapability(environment, 'packages.list');
        await clock.tickAsync(1);
        assert.ok(pkgProbe.notCalled);
        const configuredFactory = registerPackages(true, 'configured');
        assert.strictEqual((await pending).supported, true);
        assert.ok(preferredFactory?.notCalled);
        assert.ok(configuredFactory?.calledOnceWithExactly(project));
        assert.strictEqual(pkgProbe.firstCall.args[0].project, project);
    });

    test('waits for both the owning environment manager and its preferred package manager', async () => {
        const pending = api.getPackageCapability(environment, 'packages.list');
        await clock.tickAsync(1);
        registerOwner();
        await clock.tickAsync(1);
        registerPackages();
        assert.strictEqual((await pending).supported, true);
    });

    for (const matchingProjects of [0, 2]) {
        test(`does not fall back to a project-aware root with ${matchingProjects} matching projects`, async () => {
            projects =
                matchingProjects === 0
                    ? []
                    : [project, { name: 'second', uri: Uri.joinPath(Uri.file(process.cwd()), 'second') }];
            registerOwner();
            const create = registerPackages(true);
            const support = await api.getPackageCapability(environment, 'packages.list');
            assert.ok(!support.supported && support.reason.length > 0);
            assert.ok(create?.notCalled);
            assert.ok(pkgProbe.notCalled);
        });
    }

    test('an untracked explicit project never probes a project-aware root', async () => {
        projects = [];
        registerPackages(true);
        assert.strictEqual((await api.getPackageCapability(environment, 'packages.list', project)).supported, false);
        assert.ok(pkgProbe.notCalled);
    });

    test('a missing configured provider returns unsupported without root fallback', async () => {
        registerOwner();
        const create = registerPackages(true);
        configuredPackage.returns(`${extensionId}:missing`);
        const pending = api.getPackageCapability(environment, 'packages.list');
        await clock.tickAsync(MANAGER_READY_TIMEOUT_MS);
        assert.strictEqual((await pending).supported, false);
        assert.ok(create?.notCalled);
        assert.ok(pkgProbe.notCalled);
    });

    test('package activation failures reject', async () => {
        const failure = new Error('package activation failed');
        installedExtension(async () => {
            throw failure;
        });
        await assert.rejects(api.getPackageCapability(environment, 'packages.list', project), (e) => e === failure);
    });

    test('package probe failures reject', async () => {
        registerPackages(true);
        const failure = new Error('package probe failed');
        pkgProbe.rejects(failure);
        await assert.rejects(api.getPackageCapability(environment, 'packages.list', project), (e) => e === failure);
    });

    test('scoped capability results are reevaluated without recreating the scoped manager', async () => {
        const create = registerPackages(true);
        pkgProbe.onSecondCall().resolves({ supported: false, reason: 'project changed' });
        assert.strictEqual((await api.getPackageCapability(environment, 'packages.list', project)).supported, true);
        assert.deepStrictEqual(await api.getPackageCapability(environment, 'packages.list', project), {
            supported: false,
            reason: 'project changed',
        });
        assert.ok(create?.calledOnce);
    });

    test('project factory errors reject rather than falling back to the root', async () => {
        const create = registerPackages(true);
        const failure = new Error('project factory failed');
        create?.throws(failure);
        await assert.rejects(api.getPackageCapability(environment, 'packages.list', project), (e) => e === failure);
        assert.ok(pkgProbe.notCalled);
    });

    test('readiness errors reject', async () => {
        const failure = new Error('registry lookup failed');
        sinon.stub(managers, 'getEnvironmentManager').throws(failure);
        await assert.rejects(api.getEnvironmentCapability(ownerId, 'environments.list'), (e) => e === failure);
    });

    test('query timeout does not complete a later operational readiness wait', async () => {
        createManagerReady(managers, projectManager, disposables);
        const pending = api.getEnvironmentCapability(ownerId, 'environments.list');
        await clock.tickAsync(MANAGER_READY_TIMEOUT_MS);
        assert.strictEqual((await pending).supported, false);
        let ready = false;
        const operation = waitForEnvManagerId([ownerId]).then(() => {
            ready = true;
        });
        await clock.tickAsync(1);
        assert.strictEqual(ready, false);
        registerOwner();
        await operation;
        assert.strictEqual(ready, true);
    });

    test('unregistering during activation never probes a stale provider', async () => {
        installedExtension(async () => {
            registerOwner().dispose();
        });
        assert.strictEqual((await api.getEnvironmentCapability(ownerId, 'environments.list')).supported, false);
        assert.ok(envProbe.notCalled);
    });

    test('a registration event followed by disposal does not report a stale manager ready', async () => {
        const pending = waitForManagerForQuery(managers, ownerId, 'environment');
        await clock.tickAsync(1);
        registerOwner().dispose();
        assert.strictEqual(await pending, false);
    });

    test('an unregistration event alone does not complete a query wait', async () => {
        const registration = registerOwner();
        registration.dispose();
        let completed = false;
        const pending = waitForManagerForQuery(managers, ownerId, 'environment').then((ready) => {
            completed = true;
            return ready;
        });
        await clock.tickAsync(1);
        assert.strictEqual(completed, false);
        registerOwner();
        assert.strictEqual(await pending, true);
    });

    test('a disposed registry cannot leave a query waiting indefinitely', async () => {
        const pending = waitForManagerForQuery(managers, ownerId, 'environment');
        managers.dispose();
        await clock.tickAsync(MANAGER_READY_TIMEOUT_MS);
        assert.strictEqual(await pending, false);
        assert.strictEqual(clock.countTimers(), 0);
    });
});
