// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { explain } from '@renovatebot/pep440';
import assert from 'assert';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as sinon from 'sinon';
import { LogOutputChannel } from 'vscode';
import * as workspaceApis from '../../../common/workspace.apis';
import {
    PipAvailableVersionsCommand,
    UvAvailableVersionsCommand,
} from '../../../managers/builtin/commands/availableVersions';
import { PipListCommand, UvListCommand } from '../../../managers/builtin/commands/list';
import { PipListDirectNamesCommand, UvListDirectNamesCommand } from '../../../managers/builtin/commands/listDirectNames';
import * as helpers from '../../../managers/builtin/helpers';
import { EXTENSION_TEST_ROOT } from '../../constants';
import { createMockLogOutputChannel } from '../../mocks/helper';

suite('Pip and UV command parsing', () => {
    const testDataRoot = path.join(EXTENSION_TEST_ROOT, 'managers', 'builtin');
    let log: LogOutputChannel;
    let runPythonStub: sinon.SinonStub;
    let runUvStub: sinon.SinonStub;

    setup(() => {
        log = createMockLogOutputChannel();
        sinon.stub(workspaceApis, 'getConfiguration').returns({
            get: () => undefined,
        } as unknown as ReturnType<typeof workspaceApis.getConfiguration>);
        runPythonStub = sinon.stub(helpers, 'runPython').resolves('');
        runUvStub = sinon.stub(helpers, 'runUV').resolves('');
    });

    teardown(() => {
        sinon.restore();
    });

    for (const testName of ['piplist1', 'piplist2', 'piplist3']) {
        test(`PipListCommand parses ${testName}`, async () => {
            const expected = JSON.parse(
                await fs.readFile(path.join(testDataRoot, `${testName}.expected.json`), 'utf8'),
            ) as { packages: { name: string; version: string }[] };
            runPythonStub.resolves(JSON.stringify(expected.packages));
            const command = new PipListCommand({ pythonExecutable: 'python', log });

            const packages = await command.execute();

            assert.deepStrictEqual(
                packages,
                expected.packages.map(({ name, version }) => ({
                    name,
                    version,
                    displayName: name,
                    description: version,
                })),
            );
        });
    }

    test('PipListCommand returns no packages and logs malformed JSON', async () => {
        runPythonStub.resolves('not json');
        const command = new PipListCommand({ pythonExecutable: 'python', log });

        assert.deepStrictEqual(await command.execute(), []);
        assert.strictEqual((log.error as sinon.SinonStub).callCount, 1);
    });

    test('PipListCommand rejects non-array output and incomplete entries', async () => {
        const command = new PipListCommand({ pythonExecutable: 'python', log });
        runPythonStub.resolves('{"name":"pip","version":"24.0"}');
        assert.deepStrictEqual(await command.execute(), []);

        runPythonStub.resolves(
            JSON.stringify([{ name: 'pip', version: '24.0' }, { name: 'setuptools' }, { version: '1.0' }]),
        );
        assert.deepStrictEqual(await command.execute(), [
            {
                name: 'pip',
                version: '24.0',
                displayName: 'pip',
                description: '24.0',
            },
        ]);
    });

    test('UvListCommand handles valid and malformed JSON', async () => {
        const command = new UvListCommand({ pythonExecutable: 'python', log });
        runUvStub.resolves(JSON.stringify([{ name: 'pip', version: '24.0' }]));
        assert.deepStrictEqual(await command.execute(), [
            {
                name: 'pip',
                version: '24.0',
                displayName: 'pip',
                description: '24.0',
            },
        ]);

        runUvStub.resolves('not json');
        assert.deepStrictEqual(await command.execute(), []);
    });

    test('PipListDirectNamesCommand normalizes names and ignores invalid entries', async () => {
        runPythonStub.resolves(JSON.stringify([{ name: 'My_Package' }, { version: '1.0' }, { name: '' }]));
        const command = new PipListDirectNamesCommand({ pythonExecutable: 'python', log });

        assert.deepStrictEqual(await command.execute(), new Set(['my-package']));
    });

    test('UvListDirectNamesCommand parses top-level packages only', async () => {
        runUvStub.resolves(
            [
                'My_Package v1.0.0',
                '├── dependency v2.0.0',
                '│   └── nested-dependency v3.0.0',
                'another.package v4.0.0',
                '',
            ].join('\n'),
        );
        const command = new UvListDirectNamesCommand({ pythonExecutable: 'python', log });

        assert.deepStrictEqual(await command.execute(), new Set(['my-package', 'another-package']));
    });

    test('UvListDirectNamesCommand handles empty and indented-only output', async () => {
        const command = new UvListDirectNamesCommand({ pythonExecutable: 'python', log });
        runUvStub.resolves('');
        assert.deepStrictEqual(await command.execute(), new Set());

        runUvStub.resolves('  indented v1.0.0\n└── dependency v2.0.0');
        assert.deepStrictEqual(await command.execute(), new Set());
    });

    test('PipAvailableVersionsCommand parses, deduplicates, and filters versions', async () => {
        runPythonStub.resolves(
            `warning before JSON\n${JSON.stringify({
                versions: ['2.0.0', '2.0.0', '2.1.0rc1', ' invalid ', '1.0.0'],
            })}\nwarning after JSON`,
        );
        const command = new PipAvailableVersionsCommand({ pythonExecutable: 'python', log });

        const versions = await command.execute({
            packageName: 'package',
            pythonVersion: '3.13',
            includePrerelease: false,
        });

        assert.deepStrictEqual(
            versions.map((version) => version.public),
            ['2.0.0', '1.0.0'],
        );
    });

    test('PipAvailableVersionsCommand handles malformed output', async () => {
        const command = new PipAvailableVersionsCommand({ pythonExecutable: 'python', log });
        runPythonStub.resolves('no JSON here');
        assert.deepStrictEqual(
            await command.execute({ packageName: 'package', pythonVersion: '3.13' }),
            [],
        );

        runPythonStub.resolves('{not valid JSON}');
        assert.deepStrictEqual(
            await command.execute({ packageName: 'package', pythonVersion: '3.13' }),
            [],
        );

        runPythonStub.resolves(JSON.stringify({ versions: '1.0.0' }));
        assert.deepStrictEqual(
            await command.execute({ packageName: 'package', pythonVersion: '3.13' }),
            [],
        );
    });

    test('UvAvailableVersionsCommand returns parsed prerelease versions when requested', async () => {
        runUvStub.resolves(JSON.stringify({ versions: ['1.0.0', '2.0.0rc1'] }));
        const command = new UvAvailableVersionsCommand({ pythonExecutable: 'python', log });

        const versions = await command.execute({
            packageName: 'package',
            pythonVersion: '3.13',
            includePrerelease: true,
        });

        assert.deepStrictEqual(versions, [explain('1.0.0'), explain('2.0.0rc1')]);
    });
});
