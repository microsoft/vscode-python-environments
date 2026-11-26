// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

type Contribution = { command?: string; id?: string; when?: string };

function collectWhens(value: unknown, whens: string[]): void {
    if (Array.isArray(value)) {
        value.forEach((item) => collectWhens(item, whens));
    } else if (value !== null && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
            if (key === 'when' && typeof item === 'string') {
                whens.push(item);
            }
            collectWhens(item, whens);
        }
    }
}

suite('Enabled context key contributions', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    const contributes = packageJson.contributes;

    test('no when clause uses the broken != false comparison on the setting', () => {
        const whens: string[] = [];
        collectWhens(contributes, whens);
        assert.ok(whens.length > 0);
        assert.deepStrictEqual(
            whens.filter((when) => when.includes('useEnvironmentsExtension != false')),
            [],
        );
    });

    test('views and view container follow the enabled context key', () => {
        const container: Contribution[] = contributes.viewsContainers.activitybar;
        assert.strictEqual(container.length, 1);
        assert.ok(container[0].when?.includes('pythonEnvs.enabled'));

        const views: Contribution[] = contributes.views.python;
        assert.deepStrictEqual(
            views.map((view) => view.id),
            ['python-projects', 'env-managers'],
        );
        for (const view of views) {
            assert.ok(view.when?.includes('pythonEnvs.enabled'), `${view.id} should use pythonEnvs.enabled`);
        }
    });

    test('command contributions follow the enabled context key', () => {
        const commands: Contribution[] = contributes.commands;
        const gated = commands.filter((entry) => entry.when !== undefined);
        assert.deepStrictEqual(gated.map((entry) => entry.command).sort(), [
            'python-envs.runPetInTerminal',
            'python-envs.setEnvManager',
        ]);
        for (const entry of gated) {
            assert.ok(entry.when?.includes('pythonEnvs.enabled'), `${entry.command} should use pythonEnvs.enabled`);
        }
    });

    test('command palette entries follow the enabled context key', () => {
        const palette: Contribution[] = contributes.menus.commandPalette;
        const gated = palette.filter((entry) => entry.when?.includes('pythonEnvs.enabled'));
        assert.deepStrictEqual(gated.map((entry) => entry.command).sort(), [
            'python-envs.createNewProjectFromTemplate',
            'python-envs.packages',
            'python-envs.reportIssue',
            'python-envs.runAsTask',
            'python-envs.set',
            'python-envs.setEnvManager',
            'python-envs.setPkgManager',
            'python-envs.terminal.revertStartupScriptChanges',
        ]);
    });
});
