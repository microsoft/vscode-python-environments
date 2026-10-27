import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventEmitter, Uri } from 'vscode';
import {
    EnvironmentManager,
    PackageManagementOptions,
    PythonEnvironment,
    PythonProject,
} from '../api';
import { EnvironmentCapability, PackageCapability } from '../capabilities';
import * as logging from '../common/logging';
import { createDeferred } from '../common/utils/deferred';
import { EventNames } from '../common/telemetry/constants';
import * as telemetry from '../common/telemetry/sender';
import * as managerReady from '../features/common/managerReady';
import { PythonEnvironmentApiImpl } from '../extensionApi';
import type { PythonProjectManager } from '../features/projectManager';
import { InternalEnvironmentManager, InternalPackageManager } from '../managers/common/registeredManagers';
import { createMockPythonEnvironment } from './mocks/pythonEnvironment';

suite('PythonEnvironmentApiImpl - onDidChangePythonProjects', () => {
    test('fires event with correct added and removed projects', () => {
        const onDidChangeProjectsEmitter = new EventEmitter<void>();
        let currentProjects: PythonProject[] = [];
        const mockProjectManager = {
            getProjects: () => currentProjects,
            onDidChangeProjects: onDidChangeProjectsEmitter.event,
        } as unknown as PythonProjectManager;

        type ApiArgs = ConstructorParameters<typeof PythonEnvironmentApiImpl>;
        const mockEnvManagers = {
            onDidChangeActiveEnvironment: new EventEmitter().event,
            onDidChangePackageProviderPackages: new EventEmitter().event,
        } as unknown as ApiArgs[0];
        const mockProjectCreators = {} as unknown as ApiArgs[2];
        const mockTerminalManager = {} as unknown as ApiArgs[3];
        const mockEnvVarManager = { onDidChangeEnvironmentVariables: new EventEmitter().event } as unknown as ApiArgs[4];

        const api = new PythonEnvironmentApiImpl(
            mockEnvManagers,
            mockProjectManager,
            mockProjectCreators,
            mockTerminalManager,
            mockEnvVarManager,
        );
        assert.strictEqual(api.__pythonTools.version, 1);
        assert.strictEqual(typeof api.getEnvironment, 'function');

        let firedEventPayload: unknown = null;
        api.onDidChangePythonProjects((event: unknown) => {
            firedEventPayload = event;
        });

        const newProject = { uri: Uri.joinPath(Uri.file(process.cwd()), 'fake', 'path') } as unknown as PythonProject;
        currentProjects = [newProject];
        onDidChangeProjectsEmitter.fire();

        assert.ok(firedEventPayload, 'Event should have fired');
        assert.strictEqual((firedEventPayload as { added: PythonProject[] }).added.length, 1);
        assert.strictEqual((firedEventPayload as { added: PythonProject[] }).added[0].uri.fsPath, newProject.uri.fsPath);
        assert.strictEqual((firedEventPayload as { removed: PythonProject[] }).removed.length, 0);

        firedEventPayload = null;
        currentProjects = [];
        onDidChangeProjectsEmitter.fire();

        assert.ok(firedEventPayload, 'Event should have fired');
        assert.strictEqual((firedEventPayload as { added: PythonProject[] }).added.length, 0);
        assert.strictEqual((firedEventPayload as { removed: PythonProject[] }).removed.length, 1);
        assert.strictEqual(
            (firedEventPayload as { removed: PythonProject[] }).removed[0].uri.fsPath,
            newProject.uri.fsPath,
        );
    });
});

suite('PythonEnvironmentApiImpl - getEnvironment timeout fallback', () => {
    let clock: sinon.SinonFakeTimers;

    setup(() => {
        clock = sinon.useFakeTimers();
        sinon.stub(managerReady, 'waitForEnvManager').resolves();
    });

    teardown(() => {
        sinon.restore();
    });

    test('returns the last-known environment while a slower lookup continues in the background', async () => {
        const scope = Uri.file('/workspace/script.py');
        const lastKnown: PythonEnvironment = {
            envId: { id: 'default', managerId: 'ms-python.python:venv' },
            name: 'default',
            displayName: 'default',
            displayPath: '/env/default',
            version: '3.11.0',
            environmentPath: Uri.file('/env/default'),
            execInfo: { run: { executable: '/env/default/python', args: [] } },
            sysPrefix: '/env/default',
        };
        let resolveEnvironment: ((value: PythonEnvironment | undefined) => void) | undefined;

        const mockProjectManager = {
            getProjects: () => [],
            onDidChangeProjects: new EventEmitter<void>().event,
        } as unknown as PythonProjectManager;

        type ApiArgs = ConstructorParameters<typeof PythonEnvironmentApiImpl>;
        const mockEnvManagers = {
            onDidChangeActiveEnvironment: new EventEmitter().event,
            onDidChangePackageProviderPackages: new EventEmitter().event,
            getEnvironment: sinon.stub().returns(
                new Promise<PythonEnvironment | undefined>((resolve) => {
                    resolveEnvironment = resolve;
                }),
            ),
            getLastKnownEnvironment: sinon.stub().withArgs(scope).returns(lastKnown),
            getEnvironmentManager: sinon.stub().returns({
                id: 'ms-python.python:venv',
                getCapability: sinon.stub().resolves({ supported: true }),
                getVersion: sinon.stub().resolves(undefined),
            }),
        } as unknown as ApiArgs[0];
        const mockProjectCreators = {} as unknown as ApiArgs[2];
        const mockTerminalManager = {} as unknown as ApiArgs[3];
        const mockEnvVarManager = { onDidChangeEnvironmentVariables: new EventEmitter().event } as unknown as ApiArgs[4];

        const api = new PythonEnvironmentApiImpl(
            mockEnvManagers,
            mockProjectManager,
            mockProjectCreators,
            mockTerminalManager,
            mockEnvVarManager,
        );

        const pending = api.getEnvironment(scope);
        await clock.tickAsync(1_000);

        assert.strictEqual(await pending, lastKnown);
        resolveEnvironment?.(undefined);
    });

    test('waits for the real resolution for inline-script scopes instead of serving last-known', async () => {
        const scope = Uri.file('/w/script.py');
        const lastKnown = {
            name: 'stale',
            displayName: 'stale',
            displayPath: '/env/stale',
            version: '3.12.0',
            environmentPath: Uri.file('/env/stale'),
            execInfo: { run: { executable: '/env/stale/python', args: [] } },
            sysPrefix: '/env/stale',
        } as unknown as PythonEnvironment;
        let resolveEnvironment: ((value: PythonEnvironment | undefined) => void) | undefined;

        type ApiArgs = ConstructorParameters<typeof PythonEnvironmentApiImpl>;
        const mockEnvManagers = {
            onDidChangeActiveEnvironment: new EventEmitter().event,
            onDidChangePackageProviderPackages: new EventEmitter().event,
            getEnvironment: sinon.stub().returns(
                new Promise<PythonEnvironment | undefined>((resolve) => {
                    resolveEnvironment = resolve;
                }),
            ),
            getLastKnownEnvironment: sinon.stub().returns(lastKnown),
            getEnvironmentManager: sinon.stub().returns({
                id: 'ms-python.python:inline-script',
                getCapability: sinon.stub().resolves({ supported: true }),
                getVersion: sinon.stub().resolves(undefined),
            }),
        } as unknown as ApiArgs[0];

        const api = new PythonEnvironmentApiImpl(
            mockEnvManagers,
            { getProjects: () => [], onDidChangeProjects: new EventEmitter<void>().event } as unknown as ApiArgs[1],
            {} as unknown as ApiArgs[2],
            {} as unknown as ApiArgs[3],
            { onDidChangeEnvironmentVariables: new EventEmitter().event } as unknown as ApiArgs[4],
        );

        const pending = api.getEnvironment(scope);
        await clock.tickAsync(2_000);
        // The manager withheld the environment; serving last-known would hand back exactly the
        // descriptor that decision rejected.
        resolveEnvironment?.(undefined);

        assert.strictEqual(await pending, undefined);
    });
});

suite('PythonEnvironmentApiImpl - package resolution', () => {
    setup(() => {
        sinon.stub(managerReady, 'waitForEnvManagerId').resolves();
    });

    teardown(() => {
        sinon.restore();
    });

    function createApi(manager: InternalPackageManager | undefined): {
        api: PythonEnvironmentApiImpl;
        getPackageManager: sinon.SinonStub;
    } {
        type ApiArgs = ConstructorParameters<typeof PythonEnvironmentApiImpl>;
        const getPackageManager = sinon.stub().returns(manager);
        const envManagers = {
            onDidChangeActiveEnvironment: new EventEmitter().event,
            onDidChangePackageProviderPackages: new EventEmitter().event,
            getPackageManager,
        } as unknown as ApiArgs[0];
        const projectManager = {
            getProjects: () => [],
            onDidChangeProjects: new EventEmitter<void>().event,
        } as unknown as ApiArgs[1];
        return {
            api: new PythonEnvironmentApiImpl(
                envManagers,
                projectManager,
                {} as ApiArgs[2],
                {} as ApiArgs[3],
                { onDidChangeEnvironmentVariables: new EventEmitter().event } as unknown as ApiArgs[4],
            ),
            getPackageManager,
        };
    }

    const environment = {
        envId: { id: 'environment', managerId: 'environment-manager' },
    } as PythonEnvironment;

    function expectNoPackageManagerError(error: unknown): true {
        assert.ok(error instanceof Error, 'Expected an Error');
        assert.strictEqual(error.name, 'Error');
        assert.strictEqual(error.message, 'No package manager found');
        return true;
    }

    test('rejects mutations and refreshes when no package manager resolves', async () => {
        const { api } = createApi(undefined);

        await assert.rejects(api.managePackages(environment, { install: ['example'] }), expectNoPackageManagerError);
        await assert.rejects(api.refreshPackages(environment), expectNoPackageManagerError);
    });

    test('returns undefined for reads when no package manager resolves', async () => {
        const { api } = createApi(undefined);

        assert.strictEqual(await api.getPackages(environment), undefined);
    });

    test('delegates to the resolved manager', async () => {
        const manage = sinon.stub().resolves();
        const manager = {
            manage,
            getCapability: sinon.stub().resolves({ supported: true }),
            getVersion: sinon.stub().resolves(undefined),
        } as unknown as InternalPackageManager;
        const { api, getPackageManager } = createApi(manager);

        await api.managePackages(environment, { install: ['example'] });

        assert.ok(getPackageManager.calledWithExactly(environment));
        assert.ok(manage.calledOnceWithExactly(environment, { install: ['example'] }));
    });

});

suite('PythonEnvironmentApiImpl - operational capability mapping', () => {
        const scope = Uri.file(process.cwd());
        const project: PythonProject = { name: 'project', uri: scope };
        const environment = createMockPythonEnvironment({ envPath: process.cwd(), managerId: 'test:environment' });
        let api: PythonEnvironmentApiImpl;
        let environmentManager: InternalEnvironmentManager;
        let packageManager: InternalPackageManager;
        let environmentProbe: sinon.SinonStub;
        let packageProbe: sinon.SinonStub;
        let getEnvironmentManager: sinon.SinonStub;
        let getPackageManager: sinon.SinonStub;
        let getSelected: sinon.SinonStub;
        let setSelected: sinon.SinonStub;
        let sendTelemetry: sinon.SinonStub;
        let disposables: { dispose(): void }[];

        setup(() => {
            sendTelemetry = sinon.stub(telemetry, 'sendTelemetryEvent');
            sinon.stub(managerReady, 'waitForEnvManager').resolves();
            sinon.stub(managerReady, 'waitForEnvManagerId').resolves();
            sinon.stub(managerReady, 'waitForAllEnvManagers').resolves();
            const provider: EnvironmentManager = {
                name: 'environment',
                preferredPackageManagerId: 'test:packages',
                create: sinon.stub().resolves(environment),
                remove: sinon.stub().resolves(),
                refresh: sinon.stub().resolves(),
                getEnvironments: sinon.stub().resolves([environment]),
                get: sinon.stub().resolves(environment),
                set: sinon.stub().resolves(),
                resolve: sinon.stub().resolves(environment),
            };
            environmentManager = new InternalEnvironmentManager('test:environment', provider);
            packageManager = new InternalPackageManager('test:packages', {
                name: 'packages',
                manage: sinon.stub().resolves(),
                refresh: sinon.stub().resolves(),
                getPackages: sinon.stub().resolves([]),
                getPackageAvailableVersions: sinon.stub().resolves([]),
            }, project);
            environmentProbe = sinon.stub(environmentManager, 'getCapability').resolves({ supported: true });
            packageProbe = sinon.stub(packageManager, 'getCapability').resolves({ supported: true });
            getEnvironmentManager = sinon.stub().returns(environmentManager);
            getPackageManager = sinon.stub().returns(packageManager);
            getSelected = sinon.stub().resolves(environment);
            setSelected = sinon.stub().resolves();
            const projectChanges = new EventEmitter<void>();
            const selectionChanges = new EventEmitter();
            const packageChanges = new EventEmitter();
            const variableChanges = new EventEmitter();
            disposables = [projectChanges, selectionChanges, packageChanges, variableChanges];
            type ApiArgs = ConstructorParameters<typeof PythonEnvironmentApiImpl>;
            api = new PythonEnvironmentApiImpl(
                {
                    managers: [environmentManager],
                    getEnvironmentManager,
                    getPackageManager,
                    getEnvironment: getSelected,
                    setEnvironment: setSelected,
                    onDidChangeActiveEnvironment: selectionChanges.event,
                    onDidChangePackageProviderPackages: packageChanges.event,
                } as unknown as ApiArgs[0],
                {
                    getProjects: () => [project],
                    onDidChangeProjects: projectChanges.event,
                } as unknown as ApiArgs[1],
                {} as ApiArgs[2],
                {} as ApiArgs[3],
                { onDidChangeEnvironmentVariables: variableChanges.event } as unknown as ApiArgs[4],
                disposables,
            );
        });

        teardown(() => {
            disposables.forEach((disposable) => disposable.dispose());
            sinon.restore();
        });

        test('maps environment operations to their capabilities before delegation', async () => {
            const cases = [
                {
                    run: () => api.createEnvironment(scope, undefined),
                    capability: EnvironmentCapability.Create,
                    context: { scope },
                    operation: 'create' as const,
                },
                {
                    run: () => api.removeEnvironment(environment),
                    capability: EnvironmentCapability.Remove,
                    context: { environment },
                    operation: 'remove' as const,
                },
                {
                    run: () => api.refreshEnvironments(undefined),
                    capability: EnvironmentCapability.List,
                    context: { scope: undefined },
                    operation: 'refresh' as const,
                },
                {
                    run: () => api.getEnvironments('all'),
                    capability: EnvironmentCapability.List,
                    context: { scope: 'all' },
                    operation: 'getEnvironments' as const,
                },
                {
                    run: () => api.setEnvironment([scope], environment),
                    capability: EnvironmentCapability.SetSelected,
                    context: { scope: [scope], environment },
                    operation: undefined,
                },
                {
                    run: () => api.getEnvironment(scope),
                    capability: EnvironmentCapability.GetSelected,
                    context: { scope },
                    operation: undefined,
                },
                {
                    run: () => api.resolveEnvironment(scope),
                    capability: EnvironmentCapability.Resolve,
                    context: undefined,
                    operation: 'resolve' as const,
                },
            ];
            for (const { run, capability, context, operation } of cases) {
                environmentProbe.resetHistory();
                const delegate = operation ? sinon.spy(environmentManager, operation)
                    : capability === EnvironmentCapability.SetSelected ? setSelected : getSelected;
                await run();
                assert.ok(environmentProbe.calledOnceWithExactly(capability, context), capability);
                assert.ok(environmentProbe.calledBefore(delegate), capability);
                if (operation) {
                    delegate.restore();
                }
            }
            assert.ok(getEnvironmentManager.calledWithExactly(environment));
            await new Promise<void>(setImmediate);
            assert.deepStrictEqual(
                sendTelemetry.withArgs(EventNames.MANAGER_CAPABILITY_QUERY).getCalls().map((call) => call.args[2]),
                cases.map(({ capability }) => ({
                    managerId: environmentManager.id,
                    managerKind: 'environment',
                    managerVersion: 'unknown',
                    capability,
                    outcome: 'supported',
                    isLegacy: false,
                })),
            );
        });

        test('maps package reads and requested mutations on the existing project-bound manager', async () => {
            await api.refreshPackages(environment);
            await api.getPackages(environment);
            await api.getPackageAvailableVersions(environment, 'example');
            assert.deepStrictEqual(packageProbe.getCalls().map((call) => call.args), [
                [PackageCapability.List, { environment, project }],
                [PackageCapability.List, { environment, project }],
                [PackageCapability.FetchAvailableVersions, { environment, project }],
            ]);

            const cases: [PackageManagementOptions, string[]][] = [
                [{ install: ['example'] }, [PackageCapability.Install]],
                [{ install: ['example'], upgrade: true }, [PackageCapability.Upgrade]],
                [{ uninstall: ['example'] }, [PackageCapability.Uninstall]],
                [{ install: ['one'], uninstall: ['two'] }, [PackageCapability.Install, PackageCapability.Uninstall]],
                [{ install: ['one'], uninstall: ['two'], upgrade: true }, [PackageCapability.Upgrade, PackageCapability.Uninstall]],
                [{ install: [] }, [PackageCapability.Install, PackageCapability.Uninstall]],
                [{ install: [], upgrade: true }, [PackageCapability.Upgrade, PackageCapability.Uninstall, PackageCapability.Install]],
            ];
            const manage = sinon.spy(packageManager, 'manage');
            for (const [options, capabilities] of cases) {
                packageProbe.resetHistory();
                manage.resetHistory();
                await api.managePackages(environment, options);
                assert.deepStrictEqual(packageProbe.getCalls().map((call) => call.args), capabilities.map(
                    (capability) => [capability, { environment, project }],
                ));
                assert.ok(packageProbe.calledBefore(manage));
                assert.ok(manage.calledOnceWithExactly(environment, options));
            }
            assert.ok(getPackageManager.calledWithExactly(environment));
            assert.ok(getPackageManager.calledWithExactly(project.uri));
            await new Promise<void>(setImmediate);
            assert.ok(sendTelemetry.calledWithExactly(
                EventNames.MANAGER_CAPABILITY_QUERY,
                undefined,
                sinon.match({ managerId: packageManager.id, managerKind: 'package', capability: PackageCapability.Install }),
            ));
        });

        test('capability probes cannot gate, delay, or replace operation results and errors', async () => {
            const trace = sinon.stub(logging, 'traceError');
            const pending = createDeferred<never>();
            environmentProbe.returns(pending.promise);
            packageProbe.resolves({ supported: false, reason: 'Not supported' });
            assert.strictEqual(await api.getEnvironment(scope), environment);
            assert.deepStrictEqual(await api.getPackages(environment), []);

            const probeFailure = new Error('Probe failed');
            environmentProbe.throws(probeFailure);
            packageProbe.rejects(probeFailure);
            assert.strictEqual(await api.getEnvironment(scope), environment);
            assert.deepStrictEqual(await api.getPackages(environment), []);
            assert.ok(trace.calledWith(sinon.match.string, probeFailure));

            const operationFailure = new Error('Operation failed');
            getSelected.rejects(operationFailure);
            await assert.rejects(api.getEnvironment(scope), (error) => error === operationFailure);
        });
});
