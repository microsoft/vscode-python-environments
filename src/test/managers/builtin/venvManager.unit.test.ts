import * as assert from 'assert';
import * as sinon from 'sinon';
import { LogOutputChannel } from 'vscode';
import { VenvManager } from '../../../managers/builtin/venvManager';
import * as helpers from '../../../managers/builtin/helpers';
import { PythonEnvironmentApi } from '../../../api';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { EnvironmentManager } from '../../../api';

suite('VenvManager uv labeling tests', () => {
    let sandbox: sinon.SinonSandbox;
    
    setup(() => {
        sandbox = sinon.createSandbox();
    });
    
    teardown(() => {
        sandbox.restore();
    });

    test('should display "venv" when uv is not available', async () => {
        // Mock isUvInstalled to return false
        sandbox.stub(helpers, 'isUvInstalled').resolves(false);
        
        // Create mocks for required dependencies
        const mockNativeFinder = {} as NativePythonFinder;
        const mockApi = {} as PythonEnvironmentApi;
        const mockBaseManager = {} as EnvironmentManager;
        const mockLog = {} as LogOutputChannel;
        
        const mockInternalRefresh = sandbox.stub(VenvManager.prototype, 'internalRefresh' as keyof VenvManager).resolves();
        
        const manager = new VenvManager(mockNativeFinder, mockApi, mockBaseManager, mockLog);
        
        // Verify initial state
        assert.strictEqual(manager.displayName, 'venv');
        
        await manager.initialize();
        
        // Verify displayName remains unchanged when uv is not available
        assert.strictEqual(manager.displayName, 'venv');
        assert.ok(mockInternalRefresh.calledOnce);
    });

    test('should display "venv [uv]" when uv is available', async () => {
        // Mock isUvInstalled to return true
        sandbox.stub(helpers, 'isUvInstalled').resolves(true);
        
        // Create mocks for required dependencies
        const mockNativeFinder = {} as NativePythonFinder;
        const mockApi = {} as PythonEnvironmentApi;
        const mockBaseManager = {} as EnvironmentManager;
        const mockLog = {
            info: sandbox.stub()
        } as unknown as LogOutputChannel;
        
        const mockInternalRefresh = sandbox.stub(VenvManager.prototype, 'internalRefresh' as keyof VenvManager).resolves();
        
        const manager = new VenvManager(mockNativeFinder, mockApi, mockBaseManager, mockLog);
        
        // Verify initial state
        assert.strictEqual(manager.displayName, 'venv');
        
        await manager.initialize();
        
        // Verify displayName is updated when uv is available
        assert.strictEqual(manager.displayName, 'venv [uv]');
        assert.ok(mockInternalRefresh.calledOnce);
        assert.ok((mockLog as unknown as { info: sinon.SinonStub }).info.calledWith('uv detected - updating venv manager display name'));
    });

    test('should only initialize once and preserve displayName', async () => {
        // Mock isUvInstalled to return true
        sandbox.stub(helpers, 'isUvInstalled').resolves(true);
        
        // Create mocks for required dependencies
        const mockNativeFinder = {} as NativePythonFinder;
        const mockApi = {} as PythonEnvironmentApi;
        const mockBaseManager = {} as EnvironmentManager;
        const mockLog = {
            info: sandbox.stub()
        } as unknown as LogOutputChannel;
        
        const mockInternalRefresh = sandbox.stub(VenvManager.prototype, 'internalRefresh' as keyof VenvManager).resolves();
        
        const manager = new VenvManager(mockNativeFinder, mockApi, mockBaseManager, mockLog);
        
        // Initialize multiple times
        await manager.initialize();
        await manager.initialize();
        
        // Verify displayName is set correctly and internal refresh is called only once
        assert.strictEqual(manager.displayName, 'venv [uv]');
        assert.ok(mockInternalRefresh.calledOnce);
        assert.ok((mockLog as unknown as { info: sinon.SinonStub }).info.calledOnce);
    });
});