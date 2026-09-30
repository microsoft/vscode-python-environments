import assert from 'node:assert';
import * as sinon from 'sinon';
import { QuickPickItemKind } from 'vscode';
import { PythonProjectCreator } from '../../api';
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
