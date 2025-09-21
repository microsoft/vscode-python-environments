import assert from 'node:assert';
import * as sinon from 'sinon';
import { pickProject } from '../../../common/pickers/projects';
import * as windowApis from '../../../common/window.apis';

suite('Quick Pick Back Button Tests', () => {
    let showQuickPickWithButtonsStub: sinon.SinonStub;

    setup(() => {
        showQuickPickWithButtonsStub = sinon.stub(windowApis, 'showQuickPickWithButtons');
    });

    teardown(() => {
        sinon.restore();
    });

    test('pickProject calls showQuickPickWithButtons with back button when showBackButton is true', async () => {
        // Arrange
        const mockProjects = [
            { name: 'project1', uri: { fsPath: '/path/to/project1' } },
            { name: 'project2', uri: { fsPath: '/path/to/project2' } }
        ] as any;
        
        showQuickPickWithButtonsStub.resolves(undefined); // User cancelled

        // Act
        await pickProject(mockProjects, true);

        // Assert
        assert.strictEqual(showQuickPickWithButtonsStub.calledOnce, true);
        const callArgs = showQuickPickWithButtonsStub.getCall(0).args;
        assert.strictEqual(callArgs[1].showBackButton, true);
        assert.ok(callArgs[1].placeHolder);
        assert.strictEqual(callArgs[1].ignoreFocusOut, true);
    });

    test('pickProject calls showQuickPickWithButtons without back button when showBackButton is false', async () => {
        // Arrange
        const mockProjects = [
            { name: 'project1', uri: { fsPath: '/path/to/project1' } },
            { name: 'project2', uri: { fsPath: '/path/to/project2' } }
        ] as any;
        
        showQuickPickWithButtonsStub.resolves(undefined);

        // Act
        await pickProject(mockProjects, false);

        // Assert
        assert.strictEqual(showQuickPickWithButtonsStub.calledOnce, true);
        const callArgs = showQuickPickWithButtonsStub.getCall(0).args;
        assert.strictEqual(callArgs[1].showBackButton, false);
    });

    test('pickProject returns undefined when showQuickPickWithButtons returns array', async () => {
        // Arrange
        const mockProjects = [
            { name: 'project1', uri: { fsPath: '/path/to/project1' } },
            { name: 'project2', uri: { fsPath: '/path/to/project2' } }
        ] as any;
        
        showQuickPickWithButtonsStub.resolves([{ project: mockProjects[0] }]); // Return array

        // Act
        const result = await pickProject(mockProjects, true);

        // Assert
        assert.strictEqual(result, undefined);
    });

    test('pickProject returns project when showQuickPickWithButtons returns single item', async () => {
        // Arrange
        const mockProjects = [
            { name: 'project1', uri: { fsPath: '/path/to/project1' } },
            { name: 'project2', uri: { fsPath: '/path/to/project2' } }
        ] as any;
        
        showQuickPickWithButtonsStub.resolves({ project: mockProjects[0] });

        // Act
        const result = await pickProject(mockProjects, true);

        // Assert
        assert.strictEqual(result, mockProjects[0]);
    });

    test('pickProject returns first project directly when only one project exists', async () => {
        // Arrange
        const mockProjects = [
            { name: 'project1', uri: { fsPath: '/path/to/project1' } }
        ] as any;

        // Act
        const result = await pickProject(mockProjects, true);

        // Assert - should not call showQuickPickWithButtons for single project
        assert.strictEqual(showQuickPickWithButtonsStub.called, false);
        assert.strictEqual(result, mockProjects[0]);
    });
});