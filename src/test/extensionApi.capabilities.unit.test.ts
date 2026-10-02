// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { It, Mock } from 'typemoq';
import { Disposable, EventEmitter, Uri } from 'vscode';
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
import { PythonEnvironmentApiImpl } from '../extensionApi';
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
        try {
            managers.dispose();
            disposables.forEach((item) => item.dispose());
            assert.ok((windowApis.showErrorMessage as sinon.SinonStub).notCalled);
            assert.ok((windowApis.showQuickPick as sinon.SinonStub).notCalled);
            assert.ok(getExtension.notCalled);
        } finally {
            sinon.restore();
        }
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

    test('queries only the explicit registered environment manager', async () => {
        registerOwner();
        const context = { environment, project, scope: project.uri };
        assert.deepStrictEqual(await api.getEnvironmentManagerCapability(ownerId, 'environments.list', context), {
            supported: true,
        });
        assert.ok(envProbe.calledOnceWithExactly(context));
    });

    test('rejects contradictory environment ownership before probing', async () => {
        registerOwner();
        await assert.rejects(api.getEnvironmentManagerCapability('other:manager', 'environments.list', { environment }));
        assert.ok(envProbe.notCalled);
    });

    test('missing environment manager is unavailable immediately and can be queried after registration', async () => {
        const support = await api.getEnvironmentManagerCapability(ownerId, 'environments.list');
        assert.ok(!support.supported && support.reason.includes(ownerId));
        assert.ok(envProbe.notCalled);
        assert.strictEqual(clock.countTimers(), 0);
        registerOwner();
        assert.deepStrictEqual(await api.getEnvironmentManagerCapability(ownerId, 'environments.list'), {
            supported: true,
        });
    });

    test('environment probes reject without converting the error to unsupported', async () => {
        registerOwner();
        const failure = new Error('probe failed');
        envProbe.rejects(failure);
        await assert.rejects(api.getEnvironmentManagerCapability(ownerId, 'environments.list'), (error) => error === failure);
    });

    test('does not cache capability results', async () => {
        registerOwner();
        envProbe.onSecondCall().resolves({ supported: false, reason: 'tool removed' });
        assert.strictEqual((await api.getEnvironmentManagerCapability(ownerId, 'environments.list')).supported, true);
        assert.deepStrictEqual(await api.getEnvironmentManagerCapability(ownerId, 'environments.list'), {
            supported: false,
            reason: 'tool removed',
        });
    });

    test('queries the preferred non-project package provider without project inference', async () => {
        projects = [];
        registerOwner();
        registerPackages();
        assert.strictEqual((await api.getPackageManagerCapability(environment, 'packages.list')).supported, true);
        assert.strictEqual(pkgProbe.firstCall.args[0].environment, environment);
        assert.ok(selectedEnvironment.notCalled);
    });

    test('explicit project selects its configured scoped provider without a registered owner', async () => {
        configuredPackage.returns(`${extensionId}:configured`);
        const create = registerPackages(true, 'configured');
        assert.strictEqual((await api.getPackageManagerCapability(environment, 'packages.list', project)).supported, true);
        assert.ok(create?.calledOnceWithExactly(project));
        assert.strictEqual(pkgProbe.firstCall.args[0].project, project);
        assert.strictEqual(pkgProbe.firstCall.args[0].environment, environment);
        assert.ok(configuredPackage.calledWithExactly(projectManager, project.uri));
    });

    test('explicit project is unavailable until its configured provider registers', async () => {
        registerOwner();
        registerPackages();
        configuredPackage.returns(`${extensionId}:configured`);
        assert.strictEqual((await api.getPackageManagerCapability(environment, 'packages.list', project)).supported, false);
        assert.ok(pkgProbe.notCalled);
        registerPackages(true, 'configured');
        assert.strictEqual((await api.getPackageManagerCapability(environment, 'packages.list', project)).supported, true);
        assert.strictEqual(pkgProbe.firstCall.args[0].project, project);
    });

    test('environment routing infers a unique project and selects its different configured provider', async () => {
        registerOwner();
        const preferredFactory = registerPackages(true);
        configuredPackage.returns(`${extensionId}:configured`);
        const configuredFactory = registerPackages(true, 'configured');
        assert.strictEqual((await api.getPackageManagerCapability(environment, 'packages.list')).supported, true);
        assert.ok(preferredFactory?.notCalled);
        assert.ok(configuredFactory?.calledOnceWithExactly(project));
        assert.strictEqual(pkgProbe.firstCall.args[0].project, project);
    });

    test('environment-only package queries are unavailable until both providers register', async () => {
        const support = await api.getPackageManagerCapability(environment, 'packages.list');
        assert.ok(!support.supported && support.reason.length > 0);
        assert.strictEqual(clock.countTimers(), 0);
        registerOwner();
        assert.strictEqual((await api.getPackageManagerCapability(environment, 'packages.list')).supported, false);
        assert.strictEqual(clock.countTimers(), 0);
        assert.ok(pkgProbe.notCalled);
        registerPackages();
        assert.strictEqual((await api.getPackageManagerCapability(environment, 'packages.list')).supported, true);
    });

    for (const matchingProjects of [0, 2]) {
        test(`does not fall back to a project-aware root with ${matchingProjects} matching projects`, async () => {
            projects =
                matchingProjects === 0
                    ? []
                    : [project, { name: 'second', uri: Uri.joinPath(Uri.file(process.cwd()), 'second') }];
            registerOwner();
            const create = registerPackages(true);
            const support = await api.getPackageManagerCapability(environment, 'packages.list');
            assert.ok(!support.supported && support.reason.length > 0);
            assert.ok(create?.notCalled);
            assert.ok(pkgProbe.notCalled);
        });
    }

    test('an untracked explicit project never probes a project-aware root', async () => {
        projects = [];
        registerPackages(true);
        assert.strictEqual((await api.getPackageManagerCapability(environment, 'packages.list', project)).supported, false);
        assert.ok(pkgProbe.notCalled);
    });

    test('a missing configured provider returns unsupported without root fallback', async () => {
        registerOwner();
        const create = registerPackages(true);
        configuredPackage.returns(`${extensionId}:missing`);
        assert.strictEqual((await api.getPackageManagerCapability(environment, 'packages.list')).supported, false);
        assert.ok(create?.notCalled);
        assert.ok(pkgProbe.notCalled);
    });

    test('package probe failures reject', async () => {
        registerPackages(true);
        const failure = new Error('package probe failed');
        pkgProbe.rejects(failure);
        await assert.rejects(api.getPackageManagerCapability(environment, 'packages.list', project), (e) => e === failure);
    });

    test('scoped capability results are reevaluated without recreating the scoped manager', async () => {
        const create = registerPackages(true);
        pkgProbe.onSecondCall().resolves({ supported: false, reason: 'project changed' });
        assert.strictEqual((await api.getPackageManagerCapability(environment, 'packages.list', project)).supported, true);
        assert.deepStrictEqual(await api.getPackageManagerCapability(environment, 'packages.list', project), {
            supported: false,
            reason: 'project changed',
        });
        assert.ok(create?.calledOnce);
    });

    test('project factory errors reject rather than falling back to the root', async () => {
        const create = registerPackages(true);
        const failure = new Error('project factory failed');
        create?.throws(failure);
        await assert.rejects(api.getPackageManagerCapability(environment, 'packages.list', project), (e) => e === failure);
        assert.ok(pkgProbe.notCalled);
    });

    test('registry lookup errors reject', async () => {
        const failure = new Error('registry lookup failed');
        sinon.stub(managers, 'getEnvironmentManager').throws(failure);
        await assert.rejects(api.getEnvironmentManagerCapability(ownerId, 'environments.list'), (e) => e === failure);
    });

    test('unregistered environment managers are unavailable rather than cached', async () => {
        const registration = registerOwner();
        assert.strictEqual((await api.getEnvironmentManagerCapability(ownerId, 'environments.list')).supported, true);
        envProbe.resetHistory();
        registration.dispose();
        assert.strictEqual((await api.getEnvironmentManagerCapability(ownerId, 'environments.list')).supported, false);
        assert.ok(envProbe.notCalled);
    });
});
