// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { explain as parsePep440Version } from '@renovatebot/pep440';
import { Disposable, EventEmitter, Uri } from 'vscode';
import type {
    DidChangeEnvironmentVariablesEventArgs,
    EnvironmentManager,
    PackageManager,
    Pep440Version,
    PythonEnvironment,
    PythonProject,
} from '../api';
import { EnvironmentCapability, PackageCapability } from '../capabilities';
import type { CapabilityContext, Support } from '../capabilities';
import * as logging from '../common/logging';
import { EventNames } from '../common/telemetry/constants';
import * as telemetry from '../common/telemetry/sender';
import { allSupportedEnvironmentCapabilities, allSupportedPackageCapabilities } from './capabilityFixtures';
import * as extensionApis from '../common/extension.apis';
import * as frameUtils from '../common/utils/frameUtils';
import { createDeferred } from '../common/utils/deferred';
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
    let sendTelemetry: sinon.SinonStub;
    let environmentManagerVersion: sinon.SinonStub;
    let packageManagerVersion: sinon.SinonStub;
    let scopedPackageManagerVersion: sinon.SinonStub;
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
        sendTelemetry = sinon.stub(telemetry, 'sendTelemetryEvent');
        environmentManagerVersion = sinon.stub().resolves(parsePep440Version('2.0.0'));
        packageManagerVersion = sinon.stub().resolves(parsePep440Version('25.1'));
        scopedPackageManagerVersion = sinon.stub().resolves(parsePep440Version('2.1.0'));
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
            getVersion: environmentManagerVersion,
            capabilities: { ...allSupportedEnvironmentCapabilities, [EnvironmentCapability.List]: envProbe },
        };
        return managers.registerEnvironmentManager(provider, { extensionId });
    }

    function packageProvider(name = 'packages'): PackageManager {
        return {
            name,
            manage: async () => {},
            refresh: async () => {},
            getPackages: async () => [],
            getVersion: packageManagerVersion,
            capabilities: { ...allSupportedPackageCapabilities, [PackageCapability.List]: pkgProbe },
        };
    }

    function registerPackages(scoped = false, name = 'packages'): sinon.SinonStub | undefined {
        const provider = packageProvider(name);
        const create = scoped ? sinon.stub().callsFake(() => ({
            ...packageProvider(name),
            getVersion: scopedPackageManagerVersion,
            capabilities: { ...allSupportedPackageCapabilities, [PackageCapability.List]: scopedProbe },
        })) : undefined;
        managers.registerPackageManager({ ...provider, createForProject: create }, { extensionId });
        return create;
    }

    test('queries only the explicit registered environment manager', async () => {
        registerOwner();
        envProbe.resolves({ supported: true, isLegacy: true });
        const context = { environment, project, scope: project.uri };
        assert.deepStrictEqual(await api.getEnvironmentManagerCapability(ownerId, EnvironmentCapability.List, context), {
            supported: true,
            isLegacy: true,
        });
        await clock.tickAsync(0);
        assert.ok(envProbe.calledOnceWithExactly(context));
        assert.ok(sendTelemetry.calledWithExactly(EventNames.MANAGER_CAPABILITY_QUERY, undefined, {
            managerId: ownerId, managerKind: 'environment', managerVersion: '2.0.0',
            capability: EnvironmentCapability.List, outcome: 'supported',
            isLegacy: true,
        }));
        assert.ok(environmentManagerVersion.calledOnceWithExactly());
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('version lookup failures are logged without changing support results or probe errors', async () => {
        registerOwner();
        const versionError = new Error('Version lookup failed');
        const probeError = new Error('Probe failed');
        const trace = sinon.stub(logging, 'traceError');
        environmentManagerVersion.rejects(versionError);

        assert.deepStrictEqual(await api.getEnvironmentManagerCapability(ownerId, EnvironmentCapability.List), { supported: true });
        envProbe.rejects(probeError);
        await assert.rejects(api.getEnvironmentManagerCapability(ownerId, EnvironmentCapability.List), (error) => error === probeError);
        await clock.tickAsync(0);

        const events = sendTelemetry.getCalls().filter((call) => call.args[0] === EventNames.MANAGER_CAPABILITY_QUERY);
        assert.deepStrictEqual(events.map((call) => [call.args[2].managerVersion, call.args[2].outcome]), [
            ['unknown', 'supported'], ['unknown', 'error'],
        ]);
        assert.strictEqual(trace.callCount, 2);
        assert.strictEqual(trace.firstCall.args[1], versionError);
    });

    test('stalled version lookups cannot delay results or errors and emit unknown after one second', async () => {
        registerOwner();
        registerPackages();
        const version = createDeferred<Pep440Version | undefined>();
        environmentManagerVersion.returns(version.promise);
        packageManagerVersion.returns(version.promise);
        const trace = sinon.stub(logging, 'traceError');
        const events = sendTelemetry.withArgs(EventNames.MANAGER_CAPABILITY_QUERY);

        assert.deepStrictEqual(await api.getEnvironmentManagerCapability(ownerId, EnvironmentCapability.List), { supported: true });
        const probeError = new Error('Probe failed');
        envProbe.rejects(probeError);
        await assert.rejects(api.getEnvironmentManagerCapability(ownerId, EnvironmentCapability.List), (error) => error === probeError);
        assert.deepStrictEqual(await api.getPackageManagerCapability(environment, PackageCapability.List), { supported: true });
        assert.ok(events.notCalled);

        await clock.tickAsync(999);
        assert.ok(events.notCalled);
        await clock.tickAsync(1);
        assert.deepStrictEqual(events.getCalls().map((call) => [
            call.args[2].managerKind, call.args[2].managerVersion, call.args[2].outcome,
        ]), [
            ['environment', 'unknown', 'supported'],
            ['environment', 'unknown', 'error'],
            ['package', 'unknown', 'supported'],
        ]);
        assert.strictEqual(trace.callCount, 3);
        assert.strictEqual(clock.countTimers(), 0);

        version.reject(new Error('Late version failure'));
        await clock.tickAsync(0);
        assert.strictEqual(events.callCount, 3);
        assert.strictEqual(trace.callCount, 3);
    });

    test('rejects contradictory environment ownership before probing', async () => {
        registerOwner();
        await assert.rejects(api.getEnvironmentManagerCapability('other:manager', EnvironmentCapability.List, { environment }));
        assert.ok(envProbe.notCalled);
    });

    test('availability tracks the registration lifecycle rather than caching a stale result', async () => {
        const support = await api.getEnvironmentManagerCapability(ownerId, EnvironmentCapability.List);
        assert.ok(!support.supported && support.reason.includes(ownerId));
        assert.ok(sendTelemetry.calledWithExactly(EventNames.MANAGER_CAPABILITY_QUERY, undefined, {
            managerId: 'none', managerKind: 'environment', managerVersion: 'unknown',
            capability: EnvironmentCapability.List, outcome: 'unavailable',
            isLegacy: false,
        }));
        assert.ok(environmentManagerVersion.notCalled);
        assert.ok(envProbe.notCalled);
        assert.strictEqual(clock.countTimers(), 0);
        const registration = registerOwner();
        assert.deepStrictEqual(await api.getEnvironmentManagerCapability(ownerId, EnvironmentCapability.List), {
            supported: true,
        });
        envProbe.resetHistory();
        registration.dispose();
        assert.strictEqual((await api.getEnvironmentManagerCapability(ownerId, EnvironmentCapability.List)).supported, false);
        assert.ok(envProbe.notCalled);
    });

    test('provider probe failures reach the public caller', async () => {
        registerOwner();
        registerPackages();
        const failure = new Error('Provider probe failed');
        envProbe.rejects(failure);
        pkgProbe.rejects(failure);
        await assert.rejects(api.getEnvironmentManagerCapability(ownerId, EnvironmentCapability.List), (error) => error === failure);
        await assert.rejects(api.getPackageManagerCapability(environment, PackageCapability.List), (error) => error === failure);
    });

    test('explicit project selects its configured scoped provider without a registered owner', async () => {
        configuredPackage.returns(`${extensionId}:configured`);
        const create = registerPackages(true, 'configured');
        assert.strictEqual(await api.getPackageManagerCapability(environment, PackageCapability.List, project), scopedSupport);
        await clock.tickAsync(0);
        assert.ok(create?.calledOnceWithExactly(project));
        assert.ok(scopedProbe.calledOnceWithExactly({ environment, project }));
        assert.ok(pkgProbe.notCalled);
        assert.ok(configuredPackage.calledWithExactly(projectManager, project.uri));
        assert.ok(sendTelemetry.calledWithExactly(EventNames.MANAGER_CAPABILITY_QUERY, undefined, {
            managerId: `${extensionId}:configured`, managerKind: 'package', managerVersion: '2.1.0',
            capability: PackageCapability.List, outcome: 'unsupported',
            isLegacy: false,
        }));
        assert.ok(scopedPackageManagerVersion.calledOnceWithExactly(environment));
        assert.ok(packageManagerVersion.notCalled && environmentManagerVersion.notCalled);
    });

    test('environment-only package queries are unavailable until both providers register', async () => {
        const support = await api.getPackageManagerCapability(environment, PackageCapability.List);
        assert.ok(!support.supported && support.reason.length > 0);
        assert.strictEqual(clock.countTimers(), 0);
        registerOwner();
        assert.strictEqual((await api.getPackageManagerCapability(environment, PackageCapability.List)).supported, false);
        assert.strictEqual(clock.countTimers(), 0);
        assert.ok(pkgProbe.notCalled);
        registerPackages();
        assert.strictEqual((await api.getPackageManagerCapability(environment, PackageCapability.List)).supported, true);
    });

    test('an untracked explicit project never probes a root or a containing project provider', async () => {
        projects = [];
        const create = registerPackages(true);
        assert.strictEqual((await api.getPackageManagerCapability(environment, PackageCapability.List, project)).supported, false);

        projects = [project];
        const nestedProject: PythonProject = { name: 'nested', uri: Uri.joinPath(project.uri, 'nested') };
        sinon.stub(projectManager, 'get').returns(project);
        assert.strictEqual(projectManager.get(nestedProject.uri), project);
        assert.strictEqual((await api.getPackageManagerCapability(environment, PackageCapability.List, nestedProject)).supported, false);
        assert.ok(create?.notCalled);
        assert.ok(pkgProbe.notCalled);
        assert.ok(scopedProbe.notCalled);
    });

    test('a missing configured provider cannot fall back to the preferred root', async () => {
        registerOwner();
        const create = registerPackages(true);
        configuredPackage.returns(`${extensionId}:missing`);
        const support = await api.getPackageManagerCapability(environment, PackageCapability.List, project);
        assert.ok(!support.supported && support.reason.length > 0);
        assert.ok(create?.notCalled);
        assert.ok(pkgProbe.notCalled);
    });

    test('project factory errors reject rather than falling back to the root', async () => {
        const create = registerPackages(true);
        const failure = new Error('project factory failed');
        create?.throws(failure);
        await assert.rejects(api.getPackageManagerCapability(environment, PackageCapability.List, project), (e) => e === failure);
        assert.ok(pkgProbe.notCalled);
        assert.ok(scopedProbe.notCalled);
    });
});
