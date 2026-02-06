import assert from 'assert';
import * as sinon from 'sinon';
import { LogOutputChannel } from 'vscode';
import { UvInstallStrings } from '../../../common/localize';
import * as persistentState from '../../../common/persistentState';
import { EventNames } from '../../../common/telemetry/constants';
import * as telemetrySender from '../../../common/telemetry/sender';
import * as windowApis from '../../../common/window.apis';
import * as helpers from '../../../managers/builtin/helpers';
import {
    clearDontAskAgain,
    isDontAskAgainSet,
    promptInstallPythonViaUv,
} from '../../../managers/builtin/uvPythonInstaller';
import { createMockLogOutputChannel } from '../../mocks/helper';

suite('uvPythonInstaller - promptInstallPythonViaUv', () => {
    let mockLog: LogOutputChannel;
    let mockApi: { refreshEnvironments: sinon.SinonStub };
    let isUvInstalledStub: sinon.SinonStub;
    let showInformationMessageStub: sinon.SinonStub;
    let sendTelemetryEventStub: sinon.SinonStub;
    let mockState: { get: sinon.SinonStub; set: sinon.SinonStub; clear: sinon.SinonStub };

    setup(() => {
        mockLog = createMockLogOutputChannel();
        mockApi = { refreshEnvironments: sinon.stub().resolves() };

        mockState = {
            get: sinon.stub(),
            set: sinon.stub().resolves(),
            clear: sinon.stub().resolves(),
        };
        sinon.stub(persistentState, 'getGlobalPersistentState').resolves(mockState);
        isUvInstalledStub = sinon.stub(helpers, 'isUvInstalled');
        showInformationMessageStub = sinon.stub(windowApis, 'showInformationMessage');
        sendTelemetryEventStub = sinon.stub(telemetrySender, 'sendTelemetryEvent');
    });

    teardown(() => {
        sinon.restore();
    });

    test('should return false when "Don\'t ask again" is set', async () => {
        mockState.get.resolves(true);

        const result = await promptInstallPythonViaUv('activation', mockApi as any, mockLog);

        assert.strictEqual(result, false);
        assert(showInformationMessageStub.notCalled, 'Should not show message when dont ask again is set');
        assert(sendTelemetryEventStub.notCalled, 'Should not send telemetry when skipping prompt');
    });

    test('should show correct prompt when uv is installed', async () => {
        mockState.get.resolves(false);
        isUvInstalledStub.resolves(true);
        showInformationMessageStub.resolves(undefined); // User dismissed

        await promptInstallPythonViaUv('activation', mockApi as any, mockLog);

        assert(
            showInformationMessageStub.calledWith(
                UvInstallStrings.installPythonPrompt,
                UvInstallStrings.installPython,
                UvInstallStrings.dontAskAgain,
            ),
            'Should show install Python prompt when uv is installed',
        );
    });

    test('should show correct prompt when uv is NOT installed', async () => {
        mockState.get.resolves(false);
        isUvInstalledStub.resolves(false);
        showInformationMessageStub.resolves(undefined); // User dismissed

        await promptInstallPythonViaUv('activation', mockApi as any, mockLog);

        assert(
            showInformationMessageStub.calledWith(
                UvInstallStrings.installPythonAndUvPrompt,
                UvInstallStrings.installPython,
                UvInstallStrings.dontAskAgain,
            ),
            'Should show install Python AND uv prompt when uv is not installed',
        );
    });

    test('should set persistent state when user clicks "Don\'t ask again"', async () => {
        mockState.get.resolves(false);
        isUvInstalledStub.resolves(true);
        showInformationMessageStub.resolves(UvInstallStrings.dontAskAgain);

        const result = await promptInstallPythonViaUv('activation', mockApi as any, mockLog);

        assert.strictEqual(result, false);
        assert(mockState.set.calledWith('python-envs:uv:UV_INSTALL_PYTHON_DONT_ASK', true), 'Should set dont ask flag');
    });

    test('should return false when user dismisses the dialog', async () => {
        mockState.get.resolves(false);
        isUvInstalledStub.resolves(true);
        showInformationMessageStub.resolves(undefined); // User dismissed

        const result = await promptInstallPythonViaUv('activation', mockApi as any, mockLog);

        assert.strictEqual(result, false);
    });

    test('should send telemetry with correct trigger', async () => {
        mockState.get.resolves(false);
        isUvInstalledStub.resolves(true);
        showInformationMessageStub.resolves(undefined);

        await promptInstallPythonViaUv('createEnvironment', mockApi as any, mockLog);

        assert(
            sendTelemetryEventStub.calledWith(EventNames.UV_PYTHON_INSTALL_PROMPTED, undefined, {
                trigger: 'createEnvironment',
            }),
            'Should send telemetry with createEnvironment trigger',
        );
    });
});

suite('uvPythonInstaller - isDontAskAgainSet and clearDontAskAgain', () => {
    let mockState: { get: sinon.SinonStub; set: sinon.SinonStub; clear: sinon.SinonStub };

    setup(() => {
        mockState = {
            get: sinon.stub(),
            set: sinon.stub().resolves(),
            clear: sinon.stub().resolves(),
        };
        sinon.stub(persistentState, 'getGlobalPersistentState').resolves(mockState);
    });

    teardown(() => {
        sinon.restore();
    });

    test('isDontAskAgainSet should return true when flag is set', async () => {
        mockState.get.resolves(true);

        const result = await isDontAskAgainSet();

        assert.strictEqual(result, true);
    });

    test('isDontAskAgainSet should return false when flag is not set', async () => {
        mockState.get.resolves(false);

        const result = await isDontAskAgainSet();

        assert.strictEqual(result, false);
    });

    test('isDontAskAgainSet should return false when flag is undefined', async () => {
        mockState.get.resolves(undefined);

        const result = await isDontAskAgainSet();

        assert.strictEqual(result, false);
    });

    test('clearDontAskAgain should set flag to false', async () => {
        await clearDontAskAgain();

        assert(mockState.set.calledWith('python-envs:uv:UV_INSTALL_PYTHON_DONT_ASK', false), 'Should clear the flag');
    });
});
