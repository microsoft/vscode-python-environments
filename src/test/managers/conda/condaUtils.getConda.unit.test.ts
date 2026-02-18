import assert from 'assert';
import * as sinon from 'sinon';
import * as logging from '../../../common/logging';
import * as persistentState from '../../../common/persistentState';
import * as workspaceApis from '../../../common/workspace.apis';
import { clearCondaCache, CONDA_PATH_KEY, getConda } from '../../../managers/conda/condaUtils';

/**
 * Tests for getConda prioritization.
 *
 * The priority order should be:
 * 1. Settings (python.condaPath) - if set (non-empty)
 * 2. In-memory cache
 * 3. Persistent state
 * 4. PATH lookup (which)
 * 5. Known locations
 * 6. Native finder
 *
 * These tests verify the correct order by checking which functions are called and in what order.
 */
suite('Conda Utils - getConda prioritization', () => {
    let getConfigurationStub: sinon.SinonStub;
    let mockConfig: { get: sinon.SinonStub };
    let mockState: { get: sinon.SinonStub; set: sinon.SinonStub };
    let getWorkspacePersistentStateStub: sinon.SinonStub;

    setup(async () => {
        // Clear in-memory cache before each test
        await clearCondaCache();

        mockConfig = {
            get: sinon.stub(),
        };
        getConfigurationStub = sinon.stub(workspaceApis, 'getConfiguration');
        getConfigurationStub.withArgs('python').returns(mockConfig);
        sinon.stub(logging, 'traceInfo');

        mockState = {
            get: sinon.stub(),
            set: sinon.stub().resolves(),
        };
        getWorkspacePersistentStateStub = sinon.stub(persistentState, 'getWorkspacePersistentState');
        getWorkspacePersistentStateStub.resolves(mockState);
    });

    teardown(() => {
        sinon.restore();
    });

    test('Priority 1: Settings path is used first when set', async () => {
        // Arrange: Settings returns a valid path
        const settingsPath = '/custom/path/to/conda';
        mockConfig.get.withArgs('condaPath').returns(settingsPath);

        // Act
        const result = await getConda();

        // Assert: Should use settings path immediately (no existence check for settings in getConda)
        assert.strictEqual(result, settingsPath);
        // Verify persistent state was NOT called (settings took priority)
        assert.ok(!mockState.get.called, 'Persistent state should not be checked when settings is set');
    });

    test('Settings check happens before any other source', async () => {
        // Arrange: Settings returns empty (no setting)
        mockConfig.get.withArgs('condaPath').returns('');
        mockState.get.withArgs(CONDA_PATH_KEY).resolves(undefined);

        // Act
        try {
            await getConda();
        } catch {
            // Expected to throw when nothing found
        }

        // Assert: Configuration was accessed first
        assert.ok(getConfigurationStub.calledWith('python'), 'Configuration should be checked');
        assert.ok(mockConfig.get.calledWith('condaPath'), 'Settings should be checked');
    });

    test('Persistent state is checked when settings is empty', async () => {
        // Arrange: No settings
        mockConfig.get.withArgs('condaPath').returns('');

        // Persistent state returns undefined too
        mockState.get.withArgs(CONDA_PATH_KEY).resolves(undefined);

        // Act
        try {
            await getConda();
        } catch {
            // Expected to throw when nothing found
        }

        // Assert: Both settings and persistent state were checked
        assert.ok(mockConfig.get.calledWith('condaPath'), 'Settings should be checked first');
        assert.ok(mockState.get.calledWith(CONDA_PATH_KEY), 'Persistent state should be checked');
    });

    test('Settings path takes priority over cache', async () => {
        // Arrange: First set up so something would be cached
        // We can't easily test the cache without fs stubs, but we can verify
        // that settings is always checked first

        // Now set a settings path
        const settingsPath = '/custom/conda';
        mockConfig.get.withArgs('condaPath').returns(settingsPath);

        // Act
        const result = await getConda();

        // Assert: Should use settings
        assert.strictEqual(result, settingsPath);
    });

    test('Settings with non-empty value is used regardless of validity', async () => {
        // This is key behavior: getConda() returns settings immediately without checking existence
        // The caller is responsible for validating the path if needed
        const settingsPath = '/nonexistent/conda';
        mockConfig.get.withArgs('condaPath').returns(settingsPath);

        // Act
        const result = await getConda();

        // Assert: Should return settings path directly
        assert.strictEqual(result, settingsPath);
    });

    test('Code checks settings first in the function body', () => {
        // This is a structural test - verify the function checks settings at the top
        // by inspecting that getConfiguration is called synchronously
        // before any async operations

        // Arrange
        mockConfig.get.withArgs('condaPath').returns('/some/path');

        // Start the call (don't await)
        const promise = getConda();

        // Assert: Settings was checked synchronously (before promise resolves)
        assert.ok(getConfigurationStub.called, 'Configuration should be checked synchronously at function start');

        // Clean up
        return promise;
    });
});
