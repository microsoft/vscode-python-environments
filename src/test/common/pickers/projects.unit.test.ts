import * as assert from 'assert';
import * as sinon from 'sinon';
import { QuickPickItemKind, Uri } from 'vscode';
import { PythonProject } from '../../../api';
import { Pickers } from '../../../common/localize';
import {
    ADD_PROJECT_ACTION,
    CURRENT_FILE_ACTION,
    pickProjectWithCurrentFile,
} from '../../../common/pickers/projects';
import * as windowApis from '../../../common/window.apis';

suite('pickProjectWithCurrentFile', () => {
    let showQuickPickWithButtonsStub: sinon.SinonStub;

    const project1: PythonProject = {
        uri: Uri.file('/workspace/project1'),
        name: 'project1',
    };
    const project2: PythonProject = {
        uri: Uri.file('/workspace/project2'),
        name: 'project2',
    };
    const activeFileUri = Uri.file('/workspace/project1/main.py');

    setup(() => {
        showQuickPickWithButtonsStub = sinon.stub(windowApis, 'showQuickPickWithButtons');
    });

    teardown(() => {
        sinon.restore();
    });

    test('should show current file items and project items', async () => {
        showQuickPickWithButtonsStub.resolves(undefined);

        await pickProjectWithCurrentFile([project1, project2], activeFileUri);

        assert.ok(showQuickPickWithButtonsStub.calledOnce, 'showQuickPickWithButtons should be called once');
        const items = showQuickPickWithButtonsStub.firstCall.args[0];

        // Should have: separator + 2 action items + separator + 2 project items = 6 items
        assert.strictEqual(items.length, 6, 'Should have 6 items total');

        // First item: current file separator
        assert.strictEqual(items[0].kind, QuickPickItemKind.Separator);
        assert.strictEqual(items[0].label, Pickers.Project.currentFileSection);

        // Second item: "Set for current file"
        assert.ok(items[1].label.includes(Pickers.Project.setForCurrentFile));
        assert.strictEqual(items[1].action, CURRENT_FILE_ACTION);
        assert.strictEqual(items[1].fileUri, activeFileUri);

        // Third item: "Add current file as project..."
        assert.ok(items[2].label.includes(Pickers.Project.addCurrentFileAsProject));
        assert.strictEqual(items[2].action, ADD_PROJECT_ACTION);
        assert.strictEqual(items[2].fileUri, activeFileUri);

        // Fourth item: projects separator
        assert.strictEqual(items[3].kind, QuickPickItemKind.Separator);
        assert.strictEqual(items[3].label, Pickers.Project.projectsSection);

        // Fifth and sixth items: projects
        assert.strictEqual(items[4].project, project1);
        assert.strictEqual(items[5].project, project2);
    });

    test('should return currentFile result when "Set for current file" is selected', async () => {
        showQuickPickWithButtonsStub.callsFake((items: unknown[]) => {
            // Simulate selecting the "Set for current file" item
            return Promise.resolve(items[1]);
        });

        const result = await pickProjectWithCurrentFile([project1], activeFileUri);

        assert.ok(result, 'Result should not be undefined');
        assert.strictEqual(result!.action, CURRENT_FILE_ACTION);
        if (result!.action === CURRENT_FILE_ACTION) {
            assert.strictEqual(result!.fileUri, activeFileUri);
        }
    });

    test('should return addProject result when "Add current file as project..." is selected', async () => {
        showQuickPickWithButtonsStub.callsFake((items: unknown[]) => {
            // Simulate selecting the "Add current file as project..." item
            return Promise.resolve(items[2]);
        });

        const result = await pickProjectWithCurrentFile([project1], activeFileUri);

        assert.ok(result, 'Result should not be undefined');
        assert.strictEqual(result!.action, ADD_PROJECT_ACTION);
        if (result!.action === ADD_PROJECT_ACTION) {
            assert.strictEqual(result!.fileUri, activeFileUri);
        }
    });

    test('should return projects result when a project is selected', async () => {
        showQuickPickWithButtonsStub.callsFake((items: unknown[]) => {
            // Simulate selecting the first project item (index 4, after separators + action items)
            return Promise.resolve(items[4]);
        });

        const result = await pickProjectWithCurrentFile([project1, project2], activeFileUri);

        assert.ok(result, 'Result should not be undefined');
        assert.strictEqual(result!.action, 'projects');
        if (result!.action === 'projects') {
            assert.strictEqual(result!.projects.length, 1);
            assert.strictEqual(result!.projects[0], project1);
        }
    });

    test('should return undefined when picker is cancelled', async () => {
        showQuickPickWithButtonsStub.resolves(undefined);

        const result = await pickProjectWithCurrentFile([project1], activeFileUri);

        assert.strictEqual(result, undefined, 'Should return undefined when cancelled');
    });

    test('should use ignoreFocusOut in picker options', async () => {
        showQuickPickWithButtonsStub.resolves(undefined);

        await pickProjectWithCurrentFile([project1], activeFileUri);

        const options = showQuickPickWithButtonsStub.firstCall.args[1];
        assert.strictEqual(options.ignoreFocusOut, true, 'ignoreFocusOut should be true');
    });

    test('should not use canPickMany', async () => {
        showQuickPickWithButtonsStub.resolves(undefined);

        await pickProjectWithCurrentFile([project1], activeFileUri);

        const options = showQuickPickWithButtonsStub.firstCall.args[1];
        assert.strictEqual(options.canPickMany, undefined, 'canPickMany should not be set');
    });
});
