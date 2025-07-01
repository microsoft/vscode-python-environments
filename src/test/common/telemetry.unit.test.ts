import * as assert from 'assert';
import * as sinon from 'sinon';
import { sendPackageChangeTelemetry } from '../../common/telemetry/helpers';
import { EventNames } from '../../common/telemetry/constants';
import * as telemetrySender from '../../common/telemetry/sender';
import { PackageChangeKind } from '../../api';
import { InternalDidChangePackagesEventArgs } from '../../internal.api';

suite('Package Change Telemetry Tests', () => {
    let sendTelemetryStub: sinon.SinonStub;

    setup(() => {
        sendTelemetryStub = sinon.stub(telemetrySender, 'sendTelemetryEvent');
    });

    teardown(() => {
        sendTelemetryStub.restore();
    });

    test('should send telemetry for conda environment package installs', () => {
        const eventArgs: InternalDidChangePackagesEventArgs = {
            environment: {
                envId: { id: 'conda-env-123', managerId: 'conda-manager' },
            } as any,
            manager: { id: 'ms-python:conda' } as any,
            changes: [
                { kind: PackageChangeKind.add, pkg: { name: 'numpy' } as any },
                { kind: PackageChangeKind.add, pkg: { name: 'pandas' } as any },
            ],
        };

        sendPackageChangeTelemetry(eventArgs);

        assert.strictEqual(sendTelemetryStub.callCount, 1);
        const [eventName, measures, properties] = sendTelemetryStub.getCall(0).args;
        
        assert.strictEqual(eventName, EventNames.PACKAGE_CHANGES);
        assert.strictEqual(measures, undefined);
        assert.deepStrictEqual(properties, {
            environmentType: 'conda',
            action: 'install',
            packageManager: 'ms-python:conda',
            packageCount: 2,
        });
    });

    test('should send telemetry for venv environment package uninstalls', () => {
        const eventArgs: InternalDidChangePackagesEventArgs = {
            environment: {
                envId: { id: 'venv-env-456', managerId: 'venv-manager' },
            } as any,
            manager: { id: 'ms-python:pip' } as any,
            changes: [
                { kind: PackageChangeKind.remove, pkg: { name: 'old-package' } as any },
            ],
        };

        sendPackageChangeTelemetry(eventArgs);

        assert.strictEqual(sendTelemetryStub.callCount, 1);
        const [eventName, measures, properties] = sendTelemetryStub.getCall(0).args;
        
        assert.strictEqual(eventName, EventNames.PACKAGE_CHANGES);
        assert.strictEqual(measures, undefined);
        assert.deepStrictEqual(properties, {
            environmentType: 'venv',
            action: 'uninstall',
            packageManager: 'ms-python:pip',
            packageCount: 1,
        });
    });

    test('should send telemetry for mixed package changes (upgrade scenario)', () => {
        const eventArgs: InternalDidChangePackagesEventArgs = {
            environment: {
                envId: { id: 'system-python', managerId: 'system-manager' },
            } as any,
            manager: { id: 'ms-python:pip' } as any,
            changes: [
                { kind: PackageChangeKind.remove, pkg: { name: 'requests', version: '2.25.1' } as any },
                { kind: PackageChangeKind.add, pkg: { name: 'requests', version: '2.28.0' } as any },
            ],
        };

        sendPackageChangeTelemetry(eventArgs);

        assert.strictEqual(sendTelemetryStub.callCount, 1);
        const [eventName, measures, properties] = sendTelemetryStub.getCall(0).args;
        
        assert.strictEqual(eventName, EventNames.PACKAGE_CHANGES);
        assert.strictEqual(measures, undefined);
        assert.deepStrictEqual(properties, {
            environmentType: 'venv', // Falls back to venv for pip manager
            action: 'change',
            packageManager: 'ms-python:pip',
            packageCount: 2,
        });
    });

    test('should handle poetry environment correctly', () => {
        const eventArgs: InternalDidChangePackagesEventArgs = {
            environment: {
                envId: { id: 'poetry-env-789', managerId: 'poetry-manager' },
            } as any,
            manager: { id: 'ms-python:poetry' } as any,
            changes: [
                { kind: PackageChangeKind.add, pkg: { name: 'fastapi' } as any },
            ],
        };

        sendPackageChangeTelemetry(eventArgs);

        assert.strictEqual(sendTelemetryStub.callCount, 1);
        const [eventName, measures, properties] = sendTelemetryStub.getCall(0).args;
        
        assert.strictEqual(eventName, EventNames.PACKAGE_CHANGES);
        assert.strictEqual(measures, undefined);
        assert.deepStrictEqual(properties, {
            environmentType: 'poetry',
            action: 'install',
            packageManager: 'ms-python:poetry',
            packageCount: 1,
        });
    });

    test('should fallback to system environment type for unknown environments', () => {
        const eventArgs: InternalDidChangePackagesEventArgs = {
            environment: {
                envId: { id: 'unknown-env-type', managerId: 'unknown-manager' },
            } as any,
            manager: { id: 'unknown:package-manager' } as any,
            changes: [
                { kind: PackageChangeKind.add, pkg: { name: 'test-package' } as any },
            ],
        };

        sendPackageChangeTelemetry(eventArgs);

        assert.strictEqual(sendTelemetryStub.callCount, 1);
        const [eventName, measures, properties] = sendTelemetryStub.getCall(0).args;
        
        assert.strictEqual(eventName, EventNames.PACKAGE_CHANGES);
        assert.strictEqual(measures, undefined);
        assert.deepStrictEqual(properties, {
            environmentType: 'system',
            action: 'install',
            packageManager: 'unknown:package-manager',
            packageCount: 1,
        });
    });
});