import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import { PythonProject } from '../../api';
import { pickProjectMany } from '../../common/pickers/projects';
import * as windowApis from '../../common/window.apis';

suite('Project multi-picker', () => {
    teardown(() => sinon.restore());

    test('preselects the requested projects', async () => {
        const projects: PythonProject[] = ['one', 'two', 'three'].map((name) => ({
            name,
            uri: Uri.file(path.join(process.cwd(), name)),
        }));
        const showQuickPick = sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async (items, options) => {
            assert.deepStrictEqual(options?.selected, [items[0], items[2]]);
            return options?.selected ?? [];
        });

        const selected = await pickProjectMany(projects, {
            showBackButton: true,
            selectedProjects: [projects[0], { ...projects[2] }],
        });

        assert.deepStrictEqual(selected, [projects[0], projects[2]]);
        assert.strictEqual(showQuickPick.firstCall.args[1]?.showBackButton, true);
    });

    test('retains the boolean back-button option for existing callers', async () => {
        const projects: PythonProject[] = ['one', 'two'].map((name) => ({
            name,
            uri: Uri.file(path.join(process.cwd(), name)),
        }));
        const showQuickPick = sinon.stub(windowApis, 'showQuickPickWithButtons').resolves(undefined);

        await pickProjectMany(projects, true);

        assert.strictEqual(showQuickPick.firstCall.args[1]?.showBackButton, true);
        assert.deepStrictEqual(showQuickPick.firstCall.args[1]?.selected, []);
    });

    test('can show and preselect a single project without changing the legacy shortcut', async () => {
        const project: PythonProject = {
            name: 'one',
            uri: Uri.file(path.join(process.cwd(), 'one')),
        };
        const showQuickPick = sinon.stub(windowApis, 'showQuickPickWithButtons').resolves([]);

        const selected = await pickProjectMany([project], {
            showPickerForSingleProject: true,
            selectedProjects: [project],
        });

        assert.deepStrictEqual(selected, []);
        assert.deepStrictEqual(showQuickPick.firstCall.args[1]?.selected, [showQuickPick.firstCall.args[0][0]]);

        showQuickPick.resetHistory();
        assert.deepStrictEqual(await pickProjectMany([project]), [project]);
        sinon.assert.notCalled(showQuickPick);
    });
});
