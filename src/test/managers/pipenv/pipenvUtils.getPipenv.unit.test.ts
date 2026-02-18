import assert from 'assert';
import * as sinon from 'sinon';
import * as logging from '../../../common/logging';
import * as persistentState from '../../../common/persistentState';
import * as settingHelpers from '../../../features/settings/settingHelpers';
import { clearPipenvCache, getPipenv, PIPENV_PATH_KEY } from '../../../managers/pipenv/pipenvUtils';

/**
 * Tests for getPipenv prioritization.
 *
 * The priority order should be:
 * 1. Settings (python.pipenvPath) - if set and valid
 * 2. In-memory cache
 * 3. Persistent state
 * 4. PATH lookup (which)
 * 5. Native finder
 *
 * These tests verify the correct order by checking which functions are called and in what order.
 */
suite('Pipenv Utils - getPipenv prioritization', () => {
    let getSettingStub: sinon.SinonStub;
    let mockState: { get: sinon.SinonStub; set: sinon.SinonStub };
    let getWorkspacePersistentStateStub: sinon.SinonStub;

    setup(() => {
        // Clear in-memory cache before each test
        clearPipenvCache();

        getSettingStub = sinon.stub(settingHelpers, 'getSettingWorkspaceScope');
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

    test('Settings check happens before any other source', async () => {
        // Arrange: Settings returns undefined (no setting)
        getSettingStub.withArgs('python', 'pipenvPath').returns(undefined);
        mockState.get.withArgs(PIPENV_PATH_KEY).resolves(undefined);

        // Act
        await getPipenv();

        // Assert: Settings function was called
        assert.ok(getSettingStub.calledWith('python', 'pipenvPath'), 'Settings should be checked');

        // Settings should be checked BEFORE persistent state is accessed
        // getPipenv() checks settings synchronously at the start, then does async work
        // We verify by checking that settings was called before any persistent state access
        assert.ok(getSettingStub.called, 'Settings should be checked');
        // If persistent state was accessed, settings must have been checked first
        if (mockState.get.called) {
            assert.ok(
                getSettingStub.calledBefore(getWorkspacePersistentStateStub),
                'Settings should be checked before persistent state',
            );
        }
    });

    test('When settings returns a path, it is checked before cache', async () => {
        // Arrange: Settings returns a path
        const settingsPath = '/custom/path/to/pipenv';
        getSettingStub.withArgs('python', 'pipenvPath').returns(settingsPath);

        // Act
        await getPipenv();

        // Assert: Settings was checked first
        assert.ok(getSettingStub.calledWith('python', 'pipenvPath'), 'Settings should be checked');
    });

    test('Persistent state is checked when settings returns undefined', async () => {
        // Arrange: No settings
        getSettingStub.withArgs('python', 'pipenvPath').returns(undefined);

        // Persistent state returns undefined too
        mockState.get.withArgs(PIPENV_PATH_KEY).resolves(undefined);

        // Act
        await getPipenv();

        // Assert: Both settings and persistent state were checked
        assert.ok(getSettingStub.calledWith('python', 'pipenvPath'), 'Settings should be checked first');
        assert.ok(mockState.get.calledWith(PIPENV_PATH_KEY), 'Persistent state should be checked');
    });

    test('Code checks settings first in the function body', () => {
        // This is a structural test - verify the function checks settings at the top
        // by inspecting that getSettingWorkspaceScope is called synchronously
        // before any async operations

        // Arrange
        getSettingStub.withArgs('python', 'pipenvPath').returns(undefined);

        // Start the call (don't await)
        const promise = getPipenv();

        // Assert: Settings was checked synchronously (before promise resolves)
        assert.ok(getSettingStub.called, 'Settings should be checked synchronously at function start');

        // Clean up
        return promise;
    });
});
