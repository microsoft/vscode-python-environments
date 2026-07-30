import assert from 'assert';
import * as sinon from 'sinon';
import { LogOutputChannel } from 'vscode';
import * as workspaceApis from '../../../common/workspace.apis';
import { PipAvailableVersionsCommand, UvAvailableVersionsCommand } from '../../../managers/builtin/commands/availableVersions';
import { PipInstallCommand, UvInstallCommand } from '../../../managers/builtin/commands/install';
import { PipListCommand, UvListCommand } from '../../../managers/builtin/commands/list';
import { PipListDirectNamesCommand, UvListDirectNamesCommand } from '../../../managers/builtin/commands/listDirectNames';
import { PipUninstallCommand, UvUninstallCommand } from '../../../managers/builtin/commands/uninstall';
import { PipVersionCommand, UvVersionCommand } from '../../../managers/builtin/commands/version';
import * as helpers from '../../../managers/builtin/helpers';
import { createMockLogOutputChannel } from '../../mocks/helper';

suite('Pip and UV commands', () => {
    let mockLog: LogOutputChannel;
    let runPythonStub: sinon.SinonStub;
    let runUvStub: sinon.SinonStub;

    setup(() => {
        mockLog = createMockLogOutputChannel();
        sinon.stub(workspaceApis, 'getConfiguration').returns({
            get: () => undefined,
        } as unknown as ReturnType<typeof workspaceApis.getConfiguration>);
        runPythonStub = sinon.stub(helpers, 'runPython').resolves('');
        runUvStub = sinon.stub(helpers, 'runUV').resolves('');
    });

    teardown(() => {
        sinon.restore();
    });

    // Mutation commands have no output to parse; unit coverage is a smoke test that
    // execute() resolves. Their concrete command strings are exercised by integration tests.
    suite('mutation commands execute without error', () => {
        test('PipInstallCommand', async () => {
            const command = new PipInstallCommand({ pythonExecutable: 'python', log: mockLog });
            await assert.doesNotReject(() => command.execute({ packages: [{ packageName: 'package' }] }));
        });

        test('UvInstallCommand', async () => {
            const command = new UvInstallCommand({ pythonExecutable: 'python', log: mockLog });
            await assert.doesNotReject(() => command.execute({ packages: [{ packageName: 'package' }] }));
        });

        test('PipUninstallCommand', async () => {
            const command = new PipUninstallCommand({ pythonExecutable: 'python', log: mockLog });
            await assert.doesNotReject(() => command.execute({ packages: [{ packageName: 'package' }] }));
        });

        test('UvUninstallCommand', async () => {
            const command = new UvUninstallCommand({ pythonExecutable: 'python', log: mockLog });
            await assert.doesNotReject(() => command.execute({ packages: [{ packageName: 'package' }] }));
        });
    });

    test('PipAvailableVersionsCommand parses versions and filters prereleases', async () => {
        runPythonStub.resolves(JSON.stringify({ versions: ['2.0.0rc1', '1.0.0'] }));
        const command = new PipAvailableVersionsCommand({ pythonExecutable: 'python', log: mockLog });

        const result = await command.execute({
            packageName: 'package',
            pythonVersion: '3.13.1',
            includePrerelease: false,
        });

        assert.deepStrictEqual(result.map((v) => v.public), ['1.0.0']);
    });

    test('UvAvailableVersionsCommand parses versions from embedded JSON', async () => {
        runUvStub.resolves(`Some preamble\n${JSON.stringify({ versions: ['1.0.0'] })}`);
        const command = new UvAvailableVersionsCommand({ pythonExecutable: 'python', log: mockLog });

        const result = await command.execute({ packageName: 'package', pythonVersion: '3.13.1' });

        assert.deepStrictEqual(result.map((v) => v.public), ['1.0.0']);
    });

    test('PipListCommand parses packages and drops entries missing a version', async () => {
        runPythonStub.resolves(JSON.stringify([{ name: 'package', version: '1.0.0' }, { name: 'broken' }]));
        const command = new PipListCommand({ pythonExecutable: 'python', log: mockLog });

        const result = await command.execute();

        assert.deepStrictEqual(
            result.map((p) => ({ name: p.name, version: p.version })),
            [{ name: 'package', version: '1.0.0' }],
        );
    });

    test('UvListCommand parses packages from JSON', async () => {
        runUvStub.resolves(JSON.stringify([{ name: 'package', version: '1.0.0' }]));
        const command = new UvListCommand({ pythonExecutable: 'python', log: mockLog });

        const result = await command.execute();

        assert.deepStrictEqual(
            result.map((p) => ({ name: p.name, version: p.version })),
            [{ name: 'package', version: '1.0.0' }],
        );
    });

    test('PipListDirectNamesCommand returns normalized names', async () => {
        runPythonStub.resolves(JSON.stringify([{ name: 'Flask_Thing', version: '1.0.0' }]));
        const command = new PipListDirectNamesCommand({ pythonExecutable: 'python', log: mockLog });

        const result = await command.execute();

        assert.deepStrictEqual([...result], ['flask-thing']);
    });

    test('UvListDirectNamesCommand keeps top-level packages and skips indented dependencies', async () => {
        runUvStub.resolves(['Flask_Thing 1.0.0', '├── dependency 2.0.0', '└── another-dep 3.0.0'].join('\n'));
        const command = new UvListDirectNamesCommand({ pythonExecutable: 'python', log: mockLog });

        const result = await command.execute();

        assert.deepStrictEqual([...result], ['flask-thing']);
    });

    test('PipVersionCommand parses the version from pip --version output', async () => {
        runPythonStub.resolves('pip 24.0 from /site-packages/pip (python 3.13)');
        const command = new PipVersionCommand({ pythonExecutable: 'python', log: mockLog });

        const result = await command.execute();

        assert.strictEqual(result?.public, '24.0');
    });

    test('UvVersionCommand parses the version from uv --version output', async () => {
        runUvStub.resolves('uv 0.4.20 (abcdef 2024-01-01)');
        const command = new UvVersionCommand({ pythonExecutable: 'python', log: mockLog });

        const result = await command.execute();

        assert.strictEqual(result?.public, '0.4.20');
    });
});
