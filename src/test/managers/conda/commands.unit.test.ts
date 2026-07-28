import assert from 'assert';
import * as sinon from 'sinon';
import { LogOutputChannel } from 'vscode';
import * as workspaceApis from '../../../common/workspace.apis';
import { CondaAvailableVersionsCommand } from '../../../managers/conda/commands/availableVersions';
import { CondaInstallCommand } from '../../../managers/conda/commands/install';
import { CondaListCommand } from '../../../managers/conda/commands/list';
import { CondaUninstallCommand } from '../../../managers/conda/commands/uninstall';
import { CondaVersionCommand } from '../../../managers/conda/commands/version';
import * as condaUtils from '../../../managers/conda/condaUtils';
import { createMockLogOutputChannel } from '../../mocks/helper';

suite('Conda commands', () => {
    let mockLog: LogOutputChannel;
    let runCondaStub: sinon.SinonStub;

    setup(() => {
        mockLog = createMockLogOutputChannel();
        sinon.stub(workspaceApis, 'getConfiguration').returns({
            get: () => undefined,
        } as unknown as ReturnType<typeof workspaceApis.getConfiguration>);
        runCondaStub = sinon.stub(condaUtils, 'runCondaExecutable').resolves('');
    });

    teardown(() => {
        sinon.restore();
    });

    test('CondaAvailableVersionsCommand executes without error', async () => {
        runCondaStub.resolves(JSON.stringify({ package: [{ version: '1.0.0' }] }));
        const command = new CondaAvailableVersionsCommand({ pythonExecutable: 'conda', log: mockLog });

        await assert.doesNotReject(() => command.execute({ packageName: 'package', pythonVersion: '' }));
    });

    test('CondaInstallCommand executes without error', async () => {
        const command = new CondaInstallCommand({
            pythonExecutable: 'conda',
            condaEnvironmentPath: 'environment',
            log: mockLog,
        });

        await assert.doesNotReject(() => command.execute({ packages: [{ packageName: 'package' }] }));
    });

    test('CondaUninstallCommand executes without error', async () => {
        const command = new CondaUninstallCommand({
            pythonExecutable: 'conda',
            condaEnvironmentPath: 'environment',
            log: mockLog,
        });

        await assert.doesNotReject(() => command.execute({ packages: [{ packageName: 'package' }] }));
    });

    test('CondaListCommand executes without error', async () => {
        runCondaStub.resolves(JSON.stringify([{ name: 'package', version: '1.0.0' }]));
        const command = new CondaListCommand({
            pythonExecutable: 'conda',
            condaEnvironmentPath: 'environment',
            log: mockLog,
        });

        await assert.doesNotReject(() => command.execute());
    });

    test('CondaVersionCommand executes without error', async () => {
        runCondaStub.resolves('conda 24.1.2');
        const command = new CondaVersionCommand({ pythonExecutable: 'conda', log: mockLog });

        await assert.doesNotReject(() => command.execute());
    });
});