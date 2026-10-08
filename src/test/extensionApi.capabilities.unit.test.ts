// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { Disposable, EventEmitter, Uri } from 'vscode';
import type {
    DidChangeEnvironmentVariablesEventArgs,
    EnvironmentManager,
    PackageManager,
    PythonEnvironment,
    PythonProject,
} from '../api';
import type { CapabilityContext, Support } from '../capabilities';
import { allSupportedEnvironmentCapabilities, allSupportedPackageCapabilities } from './capabilityFixtures';
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
    let envProbe: sinon.SinonStub<[CapabilityContext], Promise<Support>>;
    let pkgProbe: sinon.SinonStub<[CapabilityContext], Promise<Support>>;
    let scopedProbe: sinon.SinonStub<[CapabilityContext], Promise<Support>>;
    const scopedSupport: Support = { supported: false, reason: 'Scoped provider response' };

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
        projectManager = {
            getProjects: () => projects,
            get: (uri: Uri) => projects.find((candidate) => candidate.uri.toString() === uri.toString()),
            onDidChangeProjects: projectChanges.event,
        } as unknown as PythonProjectManager;
        managers = new PythonEnvironmentManagers(projectManager);
        type ApiArgs = ConstructorParameters<typeof PythonEnvironmentApiImpl>;
        api = new PythonEnvironmentApiImpl(
            managers,
            projectManager,
            {} as ApiArgs[2],
            {} as ApiArgs[3],
            { onDidChangeEnvironmentVariables: variablesChanged.event } as unknown as ApiArgs[4],
            disposables,
        );
        envProbe = sinon.stub<[CapabilityContext], Promise<Support>>().resolves({ supported: true });
        pkgProbe = sinon.stub<[CapabilityContext], Promise<Support>>().resolves({ supported: true });
        scopedProbe = sinon.stub<[CapabilityContext], Promise<Support>>().resolves(scopedSupport);
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
            capabilities: { ...allSupportedEnvironmentCapabilities, 'environments.list': envProbe },
        };
        return managers.registerEnvironmentManager(provider, { extensionId });
    }

    function packageProvider(name = 'packages'): PackageManager {
        return {
            name,
            manage: async () => {},
            refresh: async () => {},
            getPackages: async () => [],
            capabilities: { ...allSupportedPackageCapabilities, 'packages.list': pkgProbe },
        };
    }

    function registerPackages(scoped = false, name = 'packages'): sinon.SinonStub | undefined {
        const provider = packageProvider(name);
        const create = scoped ? sinon.stub().callsFake(() => ({
            ...packageProvider(name),
            capabilities: { ...allSupportedPackageCapabilities, 'packages.list': scopedProbe },
        })) : undefined;
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

    test('availability tracks the registration lifecycle rather than caching a stale result', async () => {
        const support = await api.getEnvironmentManagerCapability(ownerId, 'environments.list');
        assert.ok(!support.supported && support.reason.includes(ownerId));
        assert.ok(envProbe.notCalled);
        assert.strictEqual(clock.countTimers(), 0);
        const registration = registerOwner();
        assert.deepStrictEqual(await api.getEnvironmentManagerCapability(ownerId, 'environments.list'), {
            supported: true,
        });
        envProbe.resetHistory();
        registration.dispose();
        assert.strictEqual((await api.getEnvironmentManagerCapability(ownerId, 'environments.list')).supported, false);
        assert.ok(envProbe.notCalled);
    });

    test('provider probe failures reach the public caller', async () => {
        registerOwner();
        registerPackages();
        const failure = new Error('Provider probe failed');
        envProbe.rejects(failure);
        pkgProbe.rejects(failure);
        await assert.rejects(api.getEnvironmentManagerCapability(ownerId, 'environments.list'), (error) => error === failure);
        await assert.rejects(api.getPackageManagerCapability(environment, 'packages.list'), (error) => error === failure);
    });

    test('explicit project selects its configured scoped provider without a registered owner', async () => {
        configuredPackage.returns(`${extensionId}:configured`);
        const create = registerPackages(true, 'configured');
        assert.strictEqual(await api.getPackageManagerCapability(environment, 'packages.list', project), scopedSupport);
        assert.ok(create?.calledOnceWithExactly(project));
        assert.ok(scopedProbe.calledOnceWithExactly({ environment, project }));
        assert.ok(pkgProbe.notCalled);
        assert.ok(configuredPackage.calledWithExactly(projectManager, project.uri));
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

    test('an untracked explicit project never probes a project-aware root', async () => {
        projects = [];
        registerPackages(true);
        assert.strictEqual((await api.getPackageManagerCapability(environment, 'packages.list', project)).supported, false);
        assert.ok(pkgProbe.notCalled);
    });

    test('a missing configured provider cannot fall back to the preferred root', async () => {
        registerOwner();
        const create = registerPackages(true);
        configuredPackage.returns(`${extensionId}:missing`);
        const support = await api.getPackageManagerCapability(environment, 'packages.list', project);
        assert.ok(!support.supported && support.reason.length > 0);
        assert.ok(create?.notCalled);
        assert.ok(pkgProbe.notCalled);
    });

    test('project factory errors reject rather than falling back to the root', async () => {
        const create = registerPackages(true);
        const failure = new Error('project factory failed');
        create?.throws(failure);
        await assert.rejects(api.getPackageManagerCapability(environment, 'packages.list', project), (e) => e === failure);
        assert.ok(pkgProbe.notCalled);
        assert.ok(scopedProbe.notCalled);
    });
});
