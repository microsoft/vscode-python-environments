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

    test('PipAvailableVersionsCommand executes without error', async () => {
        runPythonStub.resolves(JSON.stringify({ versions: ['1.0.0'] }));
        const command = new PipAvailableVersionsCommand({ pythonExecutable: 'python', log: mockLog });

        await assert.doesNotReject(() => command.execute({ packageName: 'package', pythonVersion: '3.13.1' }));
    });

    test('UvAvailableVersionsCommand executes without error', async () => {
        runUvStub.resolves(JSON.stringify({ versions: ['1.0.0'] }));
        const command = new UvAvailableVersionsCommand({ pythonExecutable: 'python', log: mockLog });

        await assert.doesNotReject(() => command.execute({ packageName: 'package', pythonVersion: '3.13.1' }));
    });

    test('PipInstallCommand executes without error', async () => {
        const command = new PipInstallCommand({ pythonExecutable: 'python', log: mockLog });

        await assert.doesNotReject(() => command.execute({ packages: [{ packageName: 'package' }] }));
    });

    test('UvInstallCommand executes without error', async () => {
        const command = new UvInstallCommand({ pythonExecutable: 'python', log: mockLog });

        await assert.doesNotReject(() => command.execute({ packages: [{ packageName: 'package' }] }));
    });

    test('PipUninstallCommand executes without error', async () => {
        const command = new PipUninstallCommand({ pythonExecutable: 'python', log: mockLog });

        await assert.doesNotReject(() => command.execute({ packages: [{ packageName: 'package' }] }));
    });

    test('UvUninstallCommand executes without error', async () => {
        const command = new UvUninstallCommand({ pythonExecutable: 'python', log: mockLog });

        await assert.doesNotReject(() => command.execute({ packages: [{ packageName: 'package' }] }));
    });

    test('PipListCommand executes without error', async () => {
        runPythonStub.resolves(JSON.stringify([{ name: 'package', version: '1.0.0' }]));
        const command = new PipListCommand({ pythonExecutable: 'python', log: mockLog });

        await assert.doesNotReject(() => command.execute());
    });

    test('UvListCommand executes without error', async () => {
        runUvStub.resolves(JSON.stringify([{ name: 'package', version: '1.0.0' }]));
        const command = new UvListCommand({ pythonExecutable: 'python', log: mockLog });

        await assert.doesNotReject(() => command.execute());
    });

    test('PipListDirectNamesCommand executes without error', async () => {
        runPythonStub.resolves(JSON.stringify([{ name: 'package', version: '1.0.0' }]));
        const command = new PipListDirectNamesCommand({ pythonExecutable: 'python', log: mockLog });

        await assert.doesNotReject(() => command.execute());
    });

    test('UvListDirectNamesCommand executes without error', async () => {
        runUvStub.resolves('package 1.0.0');
        const command = new UvListDirectNamesCommand({ pythonExecutable: 'python', log: mockLog });

        await assert.doesNotReject(() => command.execute());
    });

    test('PipVersionCommand executes without error', async () => {
        runPythonStub.resolves('pip 24.0 from site-packages');
        const command = new PipVersionCommand({ pythonExecutable: 'python', log: mockLog });

        await assert.doesNotReject(() => command.execute());
    });

    test('UvVersionCommand executes without error', async () => {
        runUvStub.resolves('uv 0.4.20');
        const command = new UvVersionCommand({ pythonExecutable: 'python', log: mockLog });

        await assert.doesNotReject(() => command.execute());
    });
});