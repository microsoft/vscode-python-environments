// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { PYTHON_ENVIRONMENTS_ENABLED_CONTEXT_KEY } from '../common/constants';

type ConditionalContribution = {
    command?: string;
    enablement?: string;
    id?: string;
    when?: string;
};

type PackageJson = {
    contributes: {
        commands: ConditionalContribution[];
        menus: {
            commandPalette: ConditionalContribution[];
        };
        viewsContainers: {
            activitybar: ConditionalContribution[];
        };
        views: {
            python: ConditionalContribution[];
        };
    };
};

const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'),
) as PackageJson;

suite('Contribution visibility', () => {
    test('gates environment commands on the activation-owned context key', () => {
        const commandIds = ['python-envs.setEnvManager', 'python-envs.runPetInTerminal'];
        const commandPaletteIds = [
            'python-envs.setEnvManager',
            'python-envs.packages',
            'python-envs.set',
            'python-envs.setPkgManager',
            'python-envs.runAsTask',
            'python-envs.createNewProjectFromTemplate',
            'python-envs.terminal.revertStartupScriptChanges',
            'python-envs.reportIssue',
        ];

        for (const commandId of commandIds) {
            const contribution = packageJson.contributes.commands.find(({ command }) => command === commandId);
            assert.ok(contribution, `Missing command contribution for ${commandId}`);
            assert.strictEqual(contribution.enablement, PYTHON_ENVIRONMENTS_ENABLED_CONTEXT_KEY);
        }

        for (const commandId of commandPaletteIds) {
            const contribution = packageJson.contributes.menus.commandPalette.find(
                ({ command }) => command === commandId,
            );
            assert.ok(contribution, `Missing Command Palette contribution for ${commandId}`);
            assert.strictEqual(contribution.when, PYTHON_ENVIRONMENTS_ENABLED_CONTEXT_KEY);
        }

        assert.ok(
            !JSON.stringify(packageJson.contributes).includes('config.python.useEnvironmentsExtension'),
            'Contribution visibility must not evaluate the raw setting independently of activation',
        );
    });

    test('gates the Python views on activation and Python workspace contexts', () => {
        const when = `${PYTHON_ENVIRONMENTS_ENABLED_CONTEXT_KEY} && python-envs.workspaceHasPython`;
        const activityBar = packageJson.contributes.viewsContainers.activitybar.find(({ id }) => id === 'python');
        const pythonProjects = packageJson.contributes.views.python.find(({ id }) => id === 'python-projects');
        const environmentManagers = packageJson.contributes.views.python.find(({ id }) => id === 'env-managers');

        assert.ok(activityBar, 'Missing Python activity bar contribution');
        assert.ok(pythonProjects, 'Missing Python Projects view contribution');
        assert.ok(environmentManagers, 'Missing Environment Managers view contribution');
        assert.strictEqual(activityBar.when, when);
        assert.strictEqual(pythonProjects.when, when);
        assert.strictEqual(environmentManagers.when, when);
    });
});
