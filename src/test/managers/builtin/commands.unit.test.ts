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

    test('PipInstallCommand builds upgrade and editable arguments', async () => {
        const command = new PipInstallCommand({ pythonExecutable: 'python', log: mockLog });

        await command.execute({
            packages: [{ packageName: '-e' }, { packageName: '.' }, { packageName: '-e' }, { packageName: '.[dev]' }],
            upgrade: true,
        });

        assert.deepStrictEqual(runPythonStub.firstCall.args[1], ['-m', 'pip', 'install', '--upgrade', '-e', '.[dev]']);
    });

    test('UvInstallCommand targets the selected interpreter', async () => {
        const command = new UvInstallCommand({ pythonExecutable: 'python', log: mockLog });

        await command.execute({ packages: [{ packageName: 'requests' }] });

        assert.deepStrictEqual(runUvStub.firstCall.args[0], ['pip', 'install', '--python', 'python', 'requests']);
    });

    test('PipUninstallCommand includes automatic confirmation', async () => {
        const command = new PipUninstallCommand({ pythonExecutable: 'python', log: mockLog });

        await command.execute({ packages: [{ packageName: 'requests' }] });

        assert.deepStrictEqual(runPythonStub.firstCall.args[1], ['-m', 'pip', 'uninstall', '-y', 'requests']);
    });

    test('UvUninstallCommand targets the selected interpreter', async () => {
        const command = new UvUninstallCommand({ pythonExecutable: 'python', log: mockLog });

        await command.execute({ packages: [{ packageName: 'requests' }] });

        assert.deepStrictEqual(runUvStub.firstCall.args[0], ['pip', 'uninstall', '--python', 'python', 'requests']);
    });

    test('PipAvailableVersionsCommand parses JSON output for Pip 25.1+', async () => {
        runPythonStub.resolves(JSON.stringify({ versions: ['2.0.0rc1', '1.0.0'] }));
        const command = new PipAvailableVersionsCommand({ pythonExecutable: 'python', log: mockLog });

        const result = await command.execute({
            packageName: 'package',
            pythonVersion: '3.13.1',
            includePrerelease: false,
            useJson: true,
        });

        assert.deepStrictEqual(runPythonStub.firstCall.args[1], [
            '-m',
            'pip',
            'index',
            'versions',
            'package',
            '--json',
            '--python-version',
            '3.13.1',
        ]);
        assert.deepStrictEqual(result.map((version) => version.public), ['1.0.0']);
    });

    test('PipAvailableVersionsCommand parses text output for Pip 21.2 through 25.0', async () => {
        runPythonStub.resolves('Available versions: 2.0.0rc1, 1.0.0');
        const command = new PipAvailableVersionsCommand({ pythonExecutable: 'python', log: mockLog });

        const result = await command.execute({
            packageName: 'package',
            pythonVersion: '3.13.1',
            includePrerelease: false,
            useJson: false,
        });

        assert.deepStrictEqual(runPythonStub.firstCall.args[1], [
            '-m',
            'pip',
            'index',
            'versions',
            'package',
            '--python-version',
            '3.13.1',
        ]);
        assert.deepStrictEqual(result.map((version) => version.public), ['1.0.0']);
    });

    test('UvAvailableVersionsCommand parses embedded JSON', async () => {
        runUvStub.resolves(`Some preamble\n${JSON.stringify({ versions: ['1.0.0'] })}`);
        const command = new UvAvailableVersionsCommand({ pythonExecutable: 'python', log: mockLog });

        const result = await command.execute({ packageName: 'package', pythonVersion: '3.13.1' });

        assert.deepStrictEqual(result.map((version) => version.public), ['1.0.0']);
    });

    test('PipListCommand parses packages and drops incomplete entries', async () => {
        runPythonStub.resolves(JSON.stringify([{ name: 'package', version: '1.0.0' }, { name: 'broken' }]));
        const command = new PipListCommand({ pythonExecutable: 'python', log: mockLog });

        const result = await command.execute();

        assert.deepStrictEqual(runPythonStub.firstCall.args[1], [
            '-m',
            'pip',
            'list',
            '--format=json',
            '--disable-pip-version-check',
        ]);
        assert.deepStrictEqual(
            result.map((pkg) => ({ name: pkg.name, version: pkg.version })),
            [{ name: 'package', version: '1.0.0' }],
        );
    });

    test('UvListCommand parses packages from JSON', async () => {
        runUvStub.resolves(JSON.stringify([{ name: 'package', version: '1.0.0' }]));
        const command = new UvListCommand({ pythonExecutable: 'python', log: mockLog });

        const result = await command.execute();

        assert.deepStrictEqual(runUvStub.firstCall.args[0], ['pip', 'list', '--format=json', '--python', 'python']);
        assert.deepStrictEqual(result.map((pkg) => pkg.name), ['package']);
    });

    test('direct-package commands normalize names and ignore UV dependencies', async () => {
        runPythonStub.resolves(JSON.stringify([{ name: 'Flask_Thing' }]));
        runUvStub.resolves(['Flask_Thing 1.0.0', '├── dependency 2.0.0'].join('\n'));

        const pipResult = await new PipListDirectNamesCommand({
            pythonExecutable: 'python',
            log: mockLog,
        }).execute();
        const uvResult = await new UvListDirectNamesCommand({
            pythonExecutable: 'python',
            log: mockLog,
        }).execute();

        assert.deepStrictEqual([...pipResult], ['flask-thing']);
        assert.deepStrictEqual([...uvResult], ['flask-thing']);
    });

    test('version commands parse tool versions', async () => {
        runPythonStub.resolves('pip 24.0 from /site-packages/pip (python 3.13)');
        runUvStub.resolves('uv 0.4.20 (abcdef 2024-01-01)');

        const pipVersion = await new PipVersionCommand({ pythonExecutable: 'python', log: mockLog }).execute();
        const uvVersion = await new UvVersionCommand({ pythonExecutable: 'python', log: mockLog }).execute();

        assert.strictEqual(pipVersion?.public, '24.0');
        assert.strictEqual(uvVersion?.public, '0.4.20');
    });
});
