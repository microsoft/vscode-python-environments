import * as sinon from 'sinon';
import * as envApis from '../../../common/env.apis';
import { copyPathToClipboard } from '../../../features/envCommands';
import { initializeCopyFeedbackManager, disposeCopyFeedbackManager, getCopyFeedbackManager } from '../../../features/copyFeedback';
import {
    ProjectItem,
    ProjectEnvironment,
    PythonEnvTreeItem,
    EnvManagerTreeItem,
} from '../../../features/views/treeViewItems';
import { Uri } from 'vscode';
import { PythonEnvironment } from '../../../api';
import { InternalEnvironmentManager } from '../../../internal.api';

suite('Copy Path To Clipboard', () => {
    let clipboardWriteTextStub: sinon.SinonStub;

    setup(() => {
        clipboardWriteTextStub = sinon.stub(envApis, 'clipboardWriteText');
        clipboardWriteTextStub.resolves();
        // Initialize copy feedback manager for tests
        initializeCopyFeedbackManager();
    });

    teardown(() => {
        sinon.restore();
        disposeCopyFeedbackManager();
    });

    test('Copy project path to clipboard', async () => {
        const uri = Uri.file('/test');
        const item = new ProjectItem({ name: 'test', uri });
        await copyPathToClipboard(item);

        sinon.assert.calledOnce(clipboardWriteTextStub);
        sinon.assert.calledWith(clipboardWriteTextStub, uri.fsPath);
    });

    test('Copy env path to clipboard: project view', async () => {
        const uri = Uri.file('/test');
        const item = new ProjectEnvironment(new ProjectItem({ name: 'test', uri }), {
            envId: { managerId: 'test-manager', id: 'env1' },
            name: 'env1',
            displayName: 'Environment 1',
            displayPath: '/test-env',
            execInfo: { run: { executable: '/test-env/bin/test', args: ['-m', 'env'] } },
        } as PythonEnvironment);

        await copyPathToClipboard(item);

        sinon.assert.calledOnce(clipboardWriteTextStub);
        sinon.assert.calledWith(clipboardWriteTextStub, '/test-env/bin/test -m env');
    });

    test('Copy env path to clipboard: env manager view', async () => {
        const item = new PythonEnvTreeItem(
            {
                envId: { managerId: 'test-manager', id: 'env1' },
                name: 'env1',
                displayName: 'Environment 1',
                displayPath: '/test-env',
                execInfo: { run: { executable: '/test-env/bin/test', args: ['-m', 'env'] } },
            } as PythonEnvironment,
            new EnvManagerTreeItem({ name: 'test-manager', id: 'test-manager' } as InternalEnvironmentManager),
        );

        await copyPathToClipboard(item);

        sinon.assert.calledOnce(clipboardWriteTextStub);
        sinon.assert.calledWith(clipboardWriteTextStub, '/test-env/bin/test -m env');
    });

    test('Copy project path marks item as copied', async () => {
        const uri = Uri.file('/test');
        const item = new ProjectItem({ name: 'test', uri });
        const copyFeedbackManager = getCopyFeedbackManager();

        await copyPathToClipboard(item);

        // Verify item is marked as copied
        const isMarked = copyFeedbackManager.isRecentlyCopied(item.id);
        sinon.assert.match(isMarked, true);
    });

    test('Copy environment path marks item as copied: project view', async () => {
        const uri = Uri.file('/test');
        const item = new ProjectEnvironment(new ProjectItem({ name: 'test', uri }), {
            envId: { managerId: 'test-manager', id: 'env1' },
            name: 'env1',
            displayName: 'Environment 1',
            displayPath: '/test-env',
            execInfo: { run: { executable: '/test-env/bin/test', args: ['-m', 'env'] } },
        } as PythonEnvironment);
        const copyFeedbackManager = getCopyFeedbackManager();

        await copyPathToClipboard(item);

        // Verify item is marked as copied
        const isMarked = copyFeedbackManager.isRecentlyCopied(item.id);
        sinon.assert.match(isMarked, true);
    });

    test('Copy environment path marks item as copied: env manager view', async () => {
        const environment = {
            envId: { managerId: 'test-manager', id: 'env1' },
            name: 'env1',
            displayName: 'Environment 1',
            displayPath: '/test-env',
            execInfo: { run: { executable: '/test-env/bin/test', args: ['-m', 'env'] } },
        } as PythonEnvironment;
        const item = new PythonEnvTreeItem(
            environment,
            new EnvManagerTreeItem({ name: 'test-manager', id: 'test-manager' } as InternalEnvironmentManager),
        );
        const copyFeedbackManager = getCopyFeedbackManager();

        await copyPathToClipboard(item);

        // Verify item is marked as copied using the expected ID format
        const expectedItemId = `env-${environment.envId.id}`;
        const isMarked = copyFeedbackManager.isRecentlyCopied(expectedItemId);
        sinon.assert.match(isMarked, true);
    });
});
