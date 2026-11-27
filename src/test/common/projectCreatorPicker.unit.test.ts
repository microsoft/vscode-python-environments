import assert from 'node:assert';
import * as sinon from 'sinon';
import { QuickInputButtons, QuickPickItem, QuickPickItemKind, Uri } from 'vscode';
import { PythonProjectCreator } from '../../api';
import * as commandApis from '../../common/command.api';
import { pickCreator, newProjectSelection, ProjectCreatorPick } from '../../common/pickers/managers';
import * as windowApis from '../../common/window.apis';

suite('Typed project creator picker', () => {
    const creator: PythonProjectCreator = {
        name: 'test-creator',
        displayName: 'Test Creator',
        create: async () => undefined,
    };

    teardown(() => sinon.restore());

    test('returns the selected creator', async () => {
        sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async (items) => items[0]);

        assert.strictEqual(await newProjectSelection([creator]), creator);
    });

    test('returns the first selected creator from an array', async () => {
        sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async (items) => [...items]);

        assert.strictEqual(await newProjectSelection([creator]), creator);
    });

    test('preserves cancellation', async () => {
        sinon.stub(windowApis, 'showQuickPickWithButtons').resolves(undefined);

        assert.strictEqual(await newProjectSelection([creator]), undefined);
    });

    test('reopens project selection when the Back button rejects with multiple creators', async () => {
        const secondCreator: PythonProjectCreator = {
            name: 'second-creator',
            displayName: 'Second Creator',
            create: async () => undefined,
        };
        const picker = sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async (items, options) => {
            assert.deepStrictEqual(items.map((item) => item.label), [creator.displayName, secondCreator.displayName]);
            assert.strictEqual(options?.showBackButton, true);
            throw QuickInputButtons.Back;
        });
        const executeCommand = sinon.stub(commandApis, 'executeCommand').resolves(undefined);

        assert.strictEqual(await newProjectSelection([creator, secondCreator]), undefined);
        sinon.assert.calledOnce(picker);
        sinon.assert.calledOnceWithExactly(executeCommand, 'python-envs.addPythonProject');
    });

    for (const backItem of [
        { label: 'Back', kind: QuickPickItemKind.Separator },
        { label: 'Back', back: true },
    ]) {
        test(`preserves back navigation for ${'back' in backItem ? 'back marker' : 'separator'}`, async () => {
            sinon.stub(windowApis, 'showQuickPickWithButtons').resolves(backItem);

            assert.strictEqual(await newProjectSelection([creator]), creator);
        });
    }
});

suite('Add project quick pick', () => {
    const existing: PythonProjectCreator = {
        name: 'existingProjects',
        description: 'Select existing Python projects',
        create: async () => undefined,
    };
    const packageCreator: PythonProjectCreator = {
        name: 'newPackage',
        displayName: 'Package',
        create: async () => undefined,
    };
    const autoFind: PythonProjectCreator = {
        name: 'autoProjects',
        description: 'Automatically find Python projects',
        create: async () => undefined,
    };
    const creators = [autoFind, existing, packageCreator];
    const api = Uri.file('/repo/api');
    const web = Uri.file('/repo/web');
    const discovered = [
        { label: 'api', description: '/repo/api/pyproject.toml', uri: api },
        { label: 'web', description: '/repo/web/setup.py', uri: web },
    ];

    function selectableLabels(items: readonly QuickPickItem[]): string[] {
        return items.filter((item) => item.kind !== QuickPickItemKind.Separator).map((item) => item.label);
    }

    teardown(() => sinon.restore());

    test('omits Auto Find when nothing was discovered', async () => {
        const picker = sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async (items, options) => {
            assert.deepStrictEqual(selectableLabels(items), ['Select Existing', 'Create New']);
            assert.ok(!selectableLabels(items).includes('Auto Find'));
            assert.strictEqual(options?.placeHolder, 'Select a project creator');
            assert.strictEqual(options?.matchOnDescription, false);
            return undefined;
        });

        assert.strictEqual(await pickCreator(creators, []), undefined);
        sinon.assert.calledOnce(picker);
    });

    test('lists discovered projects in the same quick pick', async () => {
        sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async (items, options) => {
            assert.deepStrictEqual(selectableLabels(items), [
                'api',
                'web',
                'Add all discovered projects',
                'Select Existing',
                'Create New',
            ]);
            assert.ok(!selectableLabels(items).includes('Auto Find'));
            assert.strictEqual(options?.placeHolder, 'Select a project');
            assert.strictEqual(options?.matchOnDescription, true);
            assert.strictEqual(options?.showBackButton, true);
            return items.find((item) => item.label === 'api');
        });

        const result = await pickCreator(creators, discovered);
        assert.deepStrictEqual(projectPaths(result), [api.fsPath]);
    });

    test('does not offer add-all when only one project was discovered', async () => {
        sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async (items) => {
            assert.deepStrictEqual(selectableLabels(items), ['api', 'Select Existing', 'Create New']);
            return items.find((item) => item.label === 'api');
        });

        const result = await pickCreator(creators, [discovered[0]]);
        assert.deepStrictEqual(projectPaths(result), [api.fsPath]);
    });

    test('adds every discovered project from the same quick pick', async () => {
        sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async (items) =>
            items.find((item) => item.label === 'Add all discovered projects'),
        );

        const result = await pickCreator(creators, discovered);
        assert.deepStrictEqual(projectPaths(result), [api.fsPath, web.fsPath]);
    });

    test('still selects an existing project or a new template', async () => {
        const picker = sinon.stub(windowApis, 'showQuickPickWithButtons');
        picker.onFirstCall().callsFake(async (items) => items.find((item) => item.label === 'Select Existing'));
        assert.deepStrictEqual(await pickCreator(creators, discovered), { kind: 'creator', creator: existing });

        picker.reset();
        picker.onFirstCall().callsFake(async (items) => items.find((item) => item.label === 'Create New'));
        picker.onSecondCall().callsFake(async (items) => items[0]);
        assert.deepStrictEqual(await pickCreator(creators, []), { kind: 'creator', creator: packageCreator });
    });

    test('returns a single non-discovery creator without a quick pick', async () => {
        const picker = sinon.stub(windowApis, 'showQuickPickWithButtons');

        assert.deepStrictEqual(await pickCreator([packageCreator]), { kind: 'creator', creator: packageCreator });
        sinon.assert.notCalled(picker);
    });

    test('does not open a quick pick when Auto Find is the only creator and nothing was discovered', async () => {
        const picker = sinon.stub(windowApis, 'showQuickPickWithButtons');

        assert.strictEqual(await pickCreator([autoFind], []), undefined);
        sinon.assert.notCalled(picker);
    });
});

function projectPaths(result: ProjectCreatorPick | undefined): string[] {
    assert.ok(result?.kind === 'discovered');
    return result.uris.map((uri) => uri.fsPath);
}
