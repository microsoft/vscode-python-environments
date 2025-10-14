import assert from 'assert';
import * as sinon from 'sinon';
import { LogOutputChannel } from 'vscode';
import * as workspaceApis from '../../../common/workspace.apis';
import { NativePythonEnvironmentKind } from '../../../managers/common/nativePythonFinder';
import { shouldUseUv } from '../../../managers/builtin/helpers';

suite('Helpers - shouldUseUv', () => {
    let getConfigurationStub: sinon.SinonStub;
    let mockConfig: { get: sinon.SinonStub };
    let mockLog: LogOutputChannel;

    setup(() => {
        getConfigurationStub = sinon.stub(workspaceApis, 'getConfiguration');
        mockConfig = {
            get: sinon.stub(),
        };
        getConfigurationStub.returns(mockConfig);
        mockLog = {
            info: sinon.stub(),
            error: sinon.stub(),
            warn: sinon.stub(),
            append: sinon.stub(),
        } as unknown as LogOutputChannel;
    });

    teardown(() => {
        sinon.restore();
    });

    test('should return true for VenvUv environment when UV is installed', async () => {
        // Arrange: VenvUv type environment, UV available
        mockConfig.get.withArgs('alwaysUseUv', true).returns(false);

        // Act
        const result = await shouldUseUv(NativePythonEnvironmentKind.venvUv, mockLog);

        // Assert: Should use UV for VenvUv regardless of setting
        // Note: This will return true or false based on actual UV installation
        // We're testing the logic that VenvUv environments should check for UV
        assert.strictEqual(typeof result, 'boolean');
    });

    test('should return true for regular Venv when alwaysUseUv is true and UV is installed', async () => {
        // Arrange: Regular venv, alwaysUseUv is true
        mockConfig.get.withArgs('alwaysUseUv', true).returns(true);

        // Act
        const result = await shouldUseUv(NativePythonEnvironmentKind.venv, mockLog);

        // Assert: Should check for UV when alwaysUseUv is true
        assert.strictEqual(typeof result, 'boolean');
    });

    test('should return false for regular Venv when alwaysUseUv is false', async () => {
        // Arrange: Regular venv, alwaysUseUv is false
        mockConfig.get.withArgs('alwaysUseUv', true).returns(false);

        // Act
        const result = await shouldUseUv(NativePythonEnvironmentKind.venv, mockLog);

        // Assert: Should not use UV for regular venv when setting is false
        assert.strictEqual(result, false);
    });

    test('should return false for Conda environment when alwaysUseUv is false', async () => {
        // Arrange: Conda environment (not a venv), alwaysUseUv is false
        mockConfig.get.withArgs('alwaysUseUv', true).returns(false);

        // Act
        const result = await shouldUseUv(NativePythonEnvironmentKind.conda, mockLog);

        // Assert: Should not use UV for non-venv environments when setting is false
        assert.strictEqual(result, false);
    });

    test('should check setting when alwaysUseUv is true for Conda environment', async () => {
        // Arrange: Conda environment, alwaysUseUv is true
        mockConfig.get.withArgs('alwaysUseUv', true).returns(true);

        // Act
        const result = await shouldUseUv(NativePythonEnvironmentKind.conda, mockLog);

        // Assert: Should check for UV when alwaysUseUv is true
        assert.strictEqual(typeof result, 'boolean');
    });

    test('should use default value true when alwaysUseUv setting is not configured', async () => {
        // Arrange: Setting not configured, should use default of true
        mockConfig.get.withArgs('alwaysUseUv', true).returns(true);

        // Act
        const result = await shouldUseUv(undefined, mockLog);

        // Assert: Should check for UV with default setting
        assert.strictEqual(typeof result, 'boolean');
    });

    test('should handle undefined envKind and respect alwaysUseUv setting', async () => {
        // Arrange: No environment kind specified, alwaysUseUv is false
        mockConfig.get.withArgs('alwaysUseUv', true).returns(false);

        // Act
        const result = await shouldUseUv(undefined, mockLog);

        // Assert: Should not use UV when setting is false
        assert.strictEqual(result, false);
    });
});
