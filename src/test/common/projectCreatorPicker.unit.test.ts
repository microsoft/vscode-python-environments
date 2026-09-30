import assert from 'node:assert';
import * as sinon from 'sinon';
import { QuickInputButtons, QuickPickItemKind } from 'vscode';
import { PythonProjectCreator } from '../../api';
import * as commandApis from '../../common/command.api';
import { newProjectSelection } from '../../common/pickers/managers';
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
