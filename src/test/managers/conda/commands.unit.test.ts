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

    // Mutation commands have no output to parse; unit coverage is a smoke test that
    // execute() resolves. Their concrete command strings are exercised by integration tests.
    suite('mutation commands execute without error', () => {
        test('CondaInstallCommand', async () => {
            const command = new CondaInstallCommand({
                pythonExecutable: 'conda',
                condaEnvironmentPath: 'environment',
                log: mockLog,
            });
            await assert.doesNotReject(() => command.execute({ packages: [{ packageName: 'package' }] }));
        });

        test('CondaUninstallCommand', async () => {
            const command = new CondaUninstallCommand({
                pythonExecutable: 'conda',
                condaEnvironmentPath: 'environment',
                log: mockLog,
            });
            await assert.doesNotReject(() => command.execute({ packages: [{ packageName: 'package' }] }));
        });
    });

    test('CondaAvailableVersionsCommand parses versions keyed by package name', async () => {
        runCondaStub.resolves(JSON.stringify({ package: [{ version: '1.0.0' }, { version: '2.0.0' }] }));
        const command = new CondaAvailableVersionsCommand({ pythonExecutable: 'conda', log: mockLog });

        const result = await command.execute({ packageName: 'package', pythonVersion: '' });

        assert.deepStrictEqual(result.map((v) => v.public), ['1.0.0', '2.0.0']);
    });

    test('CondaListCommand parses packages and drops entries missing a version', async () => {
        runCondaStub.resolves(JSON.stringify([{ name: 'package', version: '1.0.0' }, { name: 'broken' }]));
        const command = new CondaListCommand({
            pythonExecutable: 'conda',
            condaEnvironmentPath: 'environment',
            log: mockLog,
        });

        const result = await command.execute();

        assert.deepStrictEqual(
            result.map((p) => ({ name: p.name, version: p.version })),
            [{ name: 'package', version: '1.0.0' }],
        );
    });

    test('CondaVersionCommand parses the version from conda --version output', async () => {
        runCondaStub.resolves('conda 24.1.2');
        const command = new CondaVersionCommand({ pythonExecutable: 'conda', log: mockLog });

        const result = await command.execute();

        assert.strictEqual(result?.public, '24.1.2');
    });
});
