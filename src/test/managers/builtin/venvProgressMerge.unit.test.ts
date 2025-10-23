import assert from 'assert';
import * as sinon from 'sinon';
import { CancellationToken, LogOutputChannel, Progress, ProgressLocation, Uri } from 'vscode';
import { EnvironmentManager, PythonEnvironment, PythonEnvironmentApi } from '../../../api';
import * as winapi from '../../../common/window.apis';
import { createWithProgress } from '../../../managers/builtin/venvUtils';

suite('Venv Progress Merge Tests', () => {
    let mockWithProgress: sinon.SinonStub;
    let mockManagePackages: sinon.SinonStub;
    let mockNativeFinder: {
        resolve: sinon.SinonStub;
        refresh: sinon.SinonStub;
        dispose: sinon.SinonStub;
    };
    // Minimal mock that only implements the methods we need for this test
    // Using type assertion to satisfy TypeScript since we only need createPythonEnvironmentItem and managePackages
    let mockApi: {
        createPythonEnvironmentItem: sinon.SinonStub;
        managePackages: sinon.SinonStub;
    };
    let mockLog: LogOutputChannel;
    let mockManager: EnvironmentManager;
    let mockBasePython: PythonEnvironment;
    let progressReportStub: sinon.SinonStub;

    setup(() => {
        // Stub withProgress to capture the progress callback
        progressReportStub = sinon.stub();
        mockWithProgress = sinon.stub(winapi, 'withProgress');
        mockWithProgress.callsFake(
            async (_options: { location: ProgressLocation; title: string }, callback: Function) => {
                const mockProgress: Progress<{ message?: string; increment?: number }> = {
                    report: progressReportStub,
                };
                const mockToken: CancellationToken = {
                    isCancellationRequested: false,
                    onCancellationRequested: sinon.stub(),
                };
                return await callback(mockProgress, mockToken);
            },
        );

        // Create minimal mocks
        mockNativeFinder = {
            resolve: sinon.stub().resolves({
                executable: '/test/venv/bin/python',
                version: '3.11.0',
                prefix: '/test/venv',
                kind: 'venv',
            }),
            refresh: sinon.stub().resolves([]),
            dispose: sinon.stub(),
        };
        mockApi = {
            createPythonEnvironmentItem: sinon.stub().returns({
                envId: { id: 'new-env', managerId: 'test-manager' },
                name: 'New Venv',
                version: '3.11.0',
                environmentPath: Uri.file('/test/venv'),
            }),
            managePackages: sinon.stub().resolves(),
        };
        mockLog = {} as LogOutputChannel;
        mockManager = { log: mockLog } as EnvironmentManager;

        // Mock base Python environment
        mockBasePython = {
            envId: { id: 'test-env', managerId: 'test-manager' },
            name: 'Test Python',
            version: '3.11.0',
            environmentPath: Uri.file('/test/python'),
            execInfo: {
                run: { executable: '/test/python/bin/python' },
            },
        } as PythonEnvironment;

        // Mock managePackages - this is the key method we're testing
        mockManagePackages = mockApi.managePackages;
    });

    teardown(() => {
        sinon.restore();
    });

    test('should update progress message when installing packages', async () => {
        // Mock file system check
        const fsapi = require('fs-extra');
        sinon.stub(fsapi, 'pathExists').resolves(true);

        // Mock the Python run function
        const helpers = require('../../../managers/builtin/helpers');
        sinon.stub(helpers, 'isUvInstalled').resolves(false);
        sinon.stub(helpers, 'runPython').resolves();

        await createWithProgress(
            mockNativeFinder,
            mockApi as unknown as PythonEnvironmentApi,
            mockLog,
            mockManager,
            mockBasePython,
            Uri.file('/test'),
            '/test/venv',
            { install: ['numpy', 'pandas'], uninstall: [] },
        );

        // Verify the progress.report was called with the installing packages message
        assert(progressReportStub.called, 'progress.report should have been called');
        const reportCalls = progressReportStub.getCalls();
        const installingPackagesCall = reportCalls.find((call) =>
            call.args[0]?.message?.includes('Installing packages'),
        );
        assert(installingPackagesCall, 'progress.report should have been called with "Installing packages" message');
    });

    test('should pass suppressProgress:true when calling managePackages', async () => {
        // Mock file system check
        const fsapi = require('fs-extra');
        sinon.stub(fsapi, 'pathExists').resolves(true);

        // Mock the Python run function
        const helpers = require('../../../managers/builtin/helpers');
        sinon.stub(helpers, 'isUvInstalled').resolves(false);
        sinon.stub(helpers, 'runPython').resolves();

        await createWithProgress(
            mockNativeFinder,
            mockApi as unknown as PythonEnvironmentApi,
            mockLog,
            mockManager,
            mockBasePython,
            Uri.file('/test'),
            '/test/venv',
            { install: ['numpy'], uninstall: [] },
        );

        // Verify managePackages was called with suppressProgress:true
        assert(mockManagePackages.called, 'managePackages should have been called');
        const managePackagesCall = mockManagePackages.getCall(0);
        assert.strictEqual(
            managePackagesCall.args[1].suppressProgress,
            true,
            'managePackages should be called with suppressProgress:true',
        );
    });

    test('should not call managePackages when no packages to install', async () => {
        // Mock file system check
        const fsapi = require('fs-extra');
        sinon.stub(fsapi, 'pathExists').resolves(true);

        // Mock the Python run function
        const helpers = require('../../../managers/builtin/helpers');
        sinon.stub(helpers, 'isUvInstalled').resolves(false);
        sinon.stub(helpers, 'runPython').resolves();

        await createWithProgress(
            mockNativeFinder,
            mockApi as unknown as PythonEnvironmentApi,
            mockLog,
            mockManager,
            mockBasePython,
            Uri.file('/test'),
            '/test/venv',
            { install: [], uninstall: [] },
        );

        // Verify managePackages was NOT called when there are no packages
        assert(!mockManagePackages.called, 'managePackages should not be called when no packages to install');
    });
});
