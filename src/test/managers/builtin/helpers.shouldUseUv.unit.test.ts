import assert from 'assert';
import * as sinon from 'sinon';
import { LogOutputChannel } from 'vscode';
import * as persistentState from '../../../common/persistentState';
import * as workspaceApis from '../../../common/workspace.apis';
import * as helpers from '../../../managers/builtin/helpers';
import { shouldUseUv } from '../../../managers/builtin/helpers';
import * as uvEnvironments from '../../../managers/builtin/uvEnvironments';

suite('Helpers - shouldUseUv', () => {
    let getConfigurationStub: sinon.SinonStub;
    let mockConfig: { get: sinon.SinonStub };
    let mockLog: LogOutputChannel;
    let getWorkspacePersistentStateStub: sinon.SinonStub;
    let mockPersistentState: { get: sinon.SinonStub; set: sinon.SinonStub; clear: sinon.SinonStub };
    let isUvInstalledStub: sinon.SinonStub;
    let getUvEnvironmentsStub: sinon.SinonStub;

    setup(() => {
        getConfigurationStub = sinon.stub(workspaceApis, 'getConfiguration');
        mockConfig = {
            get: sinon.stub(),
        };
        getConfigurationStub.withArgs('python-envs').returns(mockConfig);

        // Mock persistent state
        getWorkspacePersistentStateStub = sinon.stub(persistentState, 'getWorkspacePersistentState');
        mockPersistentState = {
            get: sinon.stub(),
            set: sinon.stub(),
            clear: sinon.stub(),
        };
        getWorkspacePersistentStateStub.returns(Promise.resolve(mockPersistentState));
        // By default, return empty UV environments list
        mockPersistentState.get.resolves([]);

        // Mock UV-related functions
        isUvInstalledStub = sinon.stub(helpers, 'isUvInstalled');
        getUvEnvironmentsStub = sinon.stub(uvEnvironments, 'getUvEnvironments');

        // Set default behaviors
        isUvInstalledStub.resolves(false); // Default to UV not installed
        getUvEnvironmentsStub.resolves([]); // Default to no UV environments
        // Create a more complete mock for LogOutputChannel
        mockLog = {
            info: sinon.stub(),
            error: sinon.stub(),
            warn: sinon.stub(),
            append: sinon.stub(),
            debug: sinon.stub(),
            trace: sinon.stub(),
            show: sinon.stub(),
            hide: sinon.stub(),
            dispose: sinon.stub(),
            clear: sinon.stub(),
            replace: sinon.stub(),
            appendLine: sinon.stub(),
            name: 'test-log',
            logLevel: 1,
            onDidChangeLogLevel: sinon.stub() as LogOutputChannel['onDidChangeLogLevel'],
        } as unknown as LogOutputChannel;
    });

    teardown(() => {
        sinon.restore();
    });

    test('should return true when alwaysUseUv is true and UV is installed', async () => {
        // Arrange: alwaysUseUv is true and UV is installed
        mockConfig.get.withArgs('alwaysUseUv', true).returns(true);
        isUvInstalledStub.resolves(true);

        // Act
        const result = await shouldUseUv(mockLog);

        // Assert: Should return true when setting is true and UV is installed
        assert.strictEqual(result, true);
    });

    test('should return false when alwaysUseUv is false', async () => {
        // Arrange: alwaysUseUv is false
        mockConfig.get.withArgs('alwaysUseUv', true).returns(false);

        // Act
        const result = await shouldUseUv(mockLog);

        // Assert: Should not use UV when setting is false
        assert.strictEqual(result, false);
    });

    test('should return true for UV environment path when UV is installed', async () => {
        // Arrange: Mock UV environments list with test path and UV is installed
        const uvEnvPath = '/path/to/uv/env';
        getUvEnvironmentsStub.resolves([uvEnvPath]); // Mock the UV env in the list
        isUvInstalledStub.resolves(true); // Mock UV as installed
        mockConfig.get.withArgs('alwaysUseUv', true).returns(false);

        // Act
        const result = await shouldUseUv(mockLog, uvEnvPath);

        // Assert: Should return true for UV environments when UV is installed
        assert.strictEqual(result, true);
    });

    test('should return false for non-UV environment when alwaysUseUv is false', async () => {
        // Arrange: Non-UV environment, alwaysUseUv is false
        const nonUvEnvPath = '/path/to/regular/env';
        mockConfig.get.withArgs('alwaysUseUv', true).returns(false);

        // Act
        const result = await shouldUseUv(mockLog, nonUvEnvPath);

        // Assert: Should not use UV for non-UV environments when setting is false
        assert.strictEqual(result, false);
    });

    test('should check setting when alwaysUseUv is true for non-UV environment', async () => {
        // Arrange: Non-UV environment, alwaysUseUv is true, UV is installed
        const nonUvEnvPath = '/path/to/regular/env';
        mockConfig.get.withArgs('alwaysUseUv', true).returns(true);
        isUvInstalledStub.resolves(true); // UV is installed
        getUvEnvironmentsStub.resolves([]); // No UV environments (so path is not UV)

        // Act
        const result = await shouldUseUv(mockLog, nonUvEnvPath);

        // Assert: Should return true when alwaysUseUv is true and UV is installed
        assert.strictEqual(result, true);
    });

    test('should use default value true when alwaysUseUv setting is not configured', async () => {
        // Arrange: Setting not configured, should use default of true, UV is installed
        mockConfig.get.withArgs('alwaysUseUv', true).returns(true);
        isUvInstalledStub.resolves(true);

        // Act
        const result = await shouldUseUv(mockLog);

        // Assert: Should return true with default setting when UV is installed
        assert.strictEqual(result, true);
    });

    test('should respect alwaysUseUv setting when no environment path provided', async () => {
        // Arrange: No environment path specified, alwaysUseUv is false
        mockConfig.get.withArgs('alwaysUseUv', true).returns(false);

        // Act
        const result = await shouldUseUv(mockLog);

        // Assert: Should not use UV when setting is false
        assert.strictEqual(result, false);
    });
});
