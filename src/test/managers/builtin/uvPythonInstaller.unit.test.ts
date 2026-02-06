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
    UV_INSTALL_PYTHON_DONT_ASK_KEY,
} from '../../../managers/builtin/uvPythonInstaller';
import { createMockLogOutputChannel } from '../../mocks/helper';

suite('uvPythonInstaller - promptInstallPythonViaUv', () => {
    let mockLog: LogOutputChannel;
    let isUvInstalledStub: sinon.SinonStub;
    let showInformationMessageStub: sinon.SinonStub;
    let sendTelemetryEventStub: sinon.SinonStub;
    let mockState: { get: sinon.SinonStub; set: sinon.SinonStub; clear: sinon.SinonStub };

    setup(() => {
        mockLog = createMockLogOutputChannel();

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

    test('should return undefined when "Don\'t ask again" is set', async () => {
        mockState.get.resolves(true);

        const result = await promptInstallPythonViaUv('activation', mockLog);

        assert.strictEqual(result, undefined);
        assert(showInformationMessageStub.notCalled, 'Should not show message when dont ask again is set');
        assert(sendTelemetryEventStub.notCalled, 'Should not send telemetry when skipping prompt');
    });

    test('should show correct prompt when uv is installed', async () => {
        mockState.get.resolves(false);
        isUvInstalledStub.resolves(true);
        showInformationMessageStub.resolves(undefined); // User dismissed

        await promptInstallPythonViaUv('activation', mockLog);

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

        await promptInstallPythonViaUv('activation', mockLog);

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

        const result = await promptInstallPythonViaUv('activation', mockLog);

        assert.strictEqual(result, undefined);
        assert(mockState.set.calledWith(UV_INSTALL_PYTHON_DONT_ASK_KEY, true), 'Should set dont ask flag');
    });

    test('should return undefined when user dismisses the dialog', async () => {
        mockState.get.resolves(false);
        isUvInstalledStub.resolves(true);
        showInformationMessageStub.resolves(undefined); // User dismissed

        const result = await promptInstallPythonViaUv('activation', mockLog);

        assert.strictEqual(result, undefined);
    });

    test('should send telemetry with correct trigger', async () => {
        mockState.get.resolves(false);
        isUvInstalledStub.resolves(true);
        showInformationMessageStub.resolves(undefined);

        await promptInstallPythonViaUv('createEnvironment', mockLog);

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

        assert(mockState.set.calledWith(UV_INSTALL_PYTHON_DONT_ASK_KEY, false), 'Should clear the flag');
    });
});

// NOTE: Installation functions (installUv, installPythonViaUv, installPythonWithUv) require
// VS Code's Task API which cannot be fully mocked in unit tests.
// These should be tested via integration tests in a real VS Code environment.
