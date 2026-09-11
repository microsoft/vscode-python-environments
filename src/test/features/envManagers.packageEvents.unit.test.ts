// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { Disposable, EventEmitter } from 'vscode';
import {
    DidChangeEnvironmentVariablesEventArgs,
    DidChangePackagesEventArgs,
    PackageChangeKind,
    PackageManager,
    PythonProject,
} from '../../api';
import { InlineScriptRoutingRegistry } from '../../common/inlineScript/routingRegistry';
import * as telemetry from '../../common/telemetry/sender';
import * as frameUtils from '../../common/utils/frameUtils';
import { PythonEnvironmentManagers } from '../../features/envManagers';
import { PythonEnvironmentApiImpl } from '../../features/pythonApi';
import { InternalDidChangePackagesEventArgs, PythonProjectManager } from '../../internal.api';
import { createMockPythonEnvironment } from '../mocks/pythonEnvironment';

for (const inlineEnabled of [false, true]) {
    suite(`Package event forwarding - inline routing ${inlineEnabled ? 'enabled' : 'disabled'}`, () => {
        const environment = createMockPythonEnvironment({
            envPath: path.join(process.cwd(), 'package-event-env'),
            managerId: 'test.environments:venv',
        });
        let clock: sinon.SinonFakeTimers;
        let managers: PythonEnvironmentManagers;
        let api: PythonEnvironmentApiImpl;
        let provider: PackageManager;
        let emitter: EventEmitter<DidChangePackagesEventArgs>;
        let routing: InlineScriptRoutingRegistry | undefined;
        let disposables: Disposable[];
        let internalEvents: InternalDidChangePackagesEventArgs[];
        let publicEvents: DidChangePackagesEventArgs[];
        let changes: DidChangePackagesEventArgs['changes'];

        setup(() => {
            clock = sinon.useFakeTimers({ toFake: ['setImmediate'] });
            sinon.stub(telemetry, 'sendTelemetryEvent');
            sinon.stub(frameUtils, 'getCallingExtension').returns('test.packages');
            disposables = [];
            internalEvents = [];
            publicEvents = [];
            const projectEvents = new EventEmitter<PythonProject[] | undefined>();
            const variableEvents = new EventEmitter<DidChangeEnvironmentVariablesEventArgs>();
            const projectManager: Partial<PythonProjectManager> = {
                getProjects: () => [],
                onDidChangeProjects: projectEvents.event,
            };
            routing = inlineEnabled ? new InlineScriptRoutingRegistry() : undefined;
            managers = new PythonEnvironmentManagers(projectManager as PythonProjectManager, routing);
            type ApiArgs = ConstructorParameters<typeof PythonEnvironmentApiImpl>;
            const variables: Partial<ApiArgs[4]> = { onDidChangeEnvironmentVariables: variableEvents.event };
            api = new PythonEnvironmentApiImpl(
                managers, projectManager as PythonProjectManager,
                {} as ApiArgs[2], {} as ApiArgs[3], variables as ApiArgs[4], disposables,
            );
            emitter = new EventEmitter<DidChangePackagesEventArgs>();
            provider = {
                name: 'custom',
                manage: async () => undefined,
                refresh: async () => undefined,
                getPackages: async () => [],
                onDidChangePackages: emitter.event,
            };
            disposables.push(
                projectEvents, variableEvents, emitter,
                api.registerPackageManager(provider, { extensionId: 'test.packages' }),
                managers.onDidChangePackages((event) => internalEvents.push(event)),
                api.onDidChangePackages((event) => publicEvents.push(event)),
            );
            changes = [{
                kind: PackageChangeKind.add,
                pkg: api.createPackageItem({ name: 'example', displayName: 'example', version: '1.0' }, environment, provider),
            }];
        });

        teardown(() => {
            disposables.forEach((disposable) => disposable.dispose());
            managers.dispose();
            routing?.dispose();
            clock.runAll();
            sinon.restore();
        });

        function verifyForwarding(event: DidChangePackagesEventArgs): void {
            emitter.fire(event);
            clock.runAll();

            assert.strictEqual(publicEvents.length, 1);
            assert.strictEqual(publicEvents[0], event, 'The public API must retain the original event and metadata');
            assert.strictEqual(internalEvents.length, 1);
            assert.strictEqual(internalEvents[0].environment, environment);
            assert.strictEqual(internalEvents[0].changes, changes);
            assert.strictEqual(internalEvents[0].manager, managers.packageManagers[0]);
            assert.deepStrictEqual(Object.keys(internalEvents[0]).sort(), ['changes', 'environment', 'manager']);
        }

        test('preserves plain event fields', () => {
            const event: DidChangePackagesEventArgs = { environment, manager: provider, changes };
            verifyForwarding(event);
        });

        test('preserves event fields implemented as prototype accessors', () => {
            const event = new class implements DidChangePackagesEventArgs {
                get environment() { return environment; }
                get manager() { return provider; }
                get changes() { return changes; }
            }();

            verifyForwarding(event);
        });

        test('does not materialize unrelated extension-private event properties', () => {
            const event: DidChangePackagesEventArgs = { environment, manager: provider, changes };
            Object.defineProperty(event, 'extensionPrivate', {
                enumerable: true,
                get: () => { throw new Error('Unrelated provider state was accessed'); },
            });

            verifyForwarding(event);
        });
    });
}
