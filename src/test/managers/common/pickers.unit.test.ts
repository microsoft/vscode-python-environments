import assert from 'node:assert';
import * as sinon from 'sinon';
import { QuickInputButtons } from 'vscode';
import * as windowApis from '../../../common/window.apis';
import { selectFromCommonPackagesToInstall } from '../../../managers/common/pickers';
import { Installable } from '../../../managers/common/types';

suite('Typed common package picker', () => {
    const common: Installable[] = [
        { name: 'pytest', displayName: 'pytest' },
        { name: 'ruff', displayName: 'ruff' },
    ];

    teardown(() => sinon.restore());

    test('returns selected packages and unselected installed packages', async () => {
        sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async (items) => [
            ...items.filter((item) => item.label === 'ruff'),
        ]);

        assert.deepStrictEqual(await selectFromCommonPackagesToInstall(common, ['pytest']), {
            install: ['ruff'],
            uninstall: ['pytest'],
        });
    });

    test('preserves cancellation', async () => {
        sinon.stub(windowApis, 'showQuickPickWithButtons').resolves(undefined);

        assert.strictEqual(await selectFromCommonPackagesToInstall(common, []), undefined);
    });

    test('propagates the back button', async () => {
        sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async () => {
            throw QuickInputButtons.Back;
        });

        await assert.rejects(selectFromCommonPackagesToInstall(common, []), (error) => error === QuickInputButtons.Back);
    });

    for (const selection of ['single', 'multiple', 'empty'] as const) {
        test(`handles edit-arguments events with ${selection} selection`, async () => {
            sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async (items, options) => {
                const item = items.find((candidate) => candidate.label === 'pytest');
                assert.ok(item);
                assert.ok(options?.buttons?.[0]);
                const event = {
                    button: options.buttons[0],
                    item: selection === 'single' ? item : selection === 'multiple' ? [item] : [],
                };
                throw event;
            });
            const input = sinon.stub(windowApis, 'showInputBoxWithButtons').resolves('pytest ruff');

            assert.deepStrictEqual(await selectFromCommonPackagesToInstall(common, ['pytest']), {
                install: ['pytest', 'ruff'],
                uninstall: [],
            });
            assert.strictEqual(input.callCount, 1);
        });
    }

    test('restores selection after going back from manual package entry', async () => {
        const picker = sinon.stub(windowApis, 'showQuickPickWithButtons');
        picker.onFirstCall().callsFake(async (items, options) => {
            const item = items.find((candidate) => candidate.label === 'ruff');
            assert.ok(item);
            assert.ok(options?.buttons?.[0]);
            const event = { button: options.buttons[0], item: [item] };
            throw event;
        });
        picker.onSecondCall().callsFake(async (_items, options) => {
            assert.deepStrictEqual(options?.selected?.map((item) => item.label), ['ruff']);
            return options?.selected;
        });
        sinon.stub(windowApis, 'showInputBoxWithButtons').callsFake(async () => {
            throw QuickInputButtons.Back;
        });

        assert.deepStrictEqual(await selectFromCommonPackagesToInstall(common, ['pytest']), {
            install: ['ruff'],
            uninstall: ['pytest'],
        });
    });

    for (const failure of [new Error('picker failed'), null, 'picker failed']) {
        test(`propagates unexpected rejection: ${String(failure)}`, async () => {
            sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async () => {
                throw failure;
            });

            await assert.rejects(selectFromCommonPackagesToInstall(common, []), (error) => error === failure);
        });
    }

    test('rejects edit-arguments events containing items outside the picker', async () => {
        let failure: object;
        sinon.stub(windowApis, 'showQuickPickWithButtons').callsFake(async (_items, options) => {
            assert.ok(options?.buttons?.[0]);
            failure = { button: options.buttons[0], item: [{ label: 'invalid', id: 'invalid' }] };
            throw failure;
        });

        await assert.rejects(selectFromCommonPackagesToInstall(common, []), (error) => error === failure);
    });
});
