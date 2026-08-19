import assert from 'assert';
import * as sinon from 'sinon';
import { LogOutputChannel, Uri } from 'vscode';
import * as workspaceApis from '../../../common/workspace.apis';
import { CondaAvailableVersionsCommand } from '../../../managers/conda/commands/availableVersions';
import { CondaInstallCommand } from '../../../managers/conda/commands/install';
import { CondaListCommand } from '../../../managers/conda/commands/list';
import { CondaUninstallCommand } from '../../../managers/conda/commands/uninstall';
import { CondaVersionCommand } from '../../../managers/conda/commands/version';
import * as condaUtils from '../../../managers/conda/condaUtils';
import { createMockLogOutputChannel } from '../../mocks/helper';

suite('Conda commands', () => {
    let environmentPath: string;
    let mockLog: LogOutputChannel;
    let runCondaStub: sinon.SinonStub;

    setup(() => {
        environmentPath = Uri.file('environment').fsPath;
        mockLog = createMockLogOutputChannel();
        sinon.stub(workspaceApis, 'getConfiguration').returns({
            get: () => undefined,
        } as unknown as ReturnType<typeof workspaceApis.getConfiguration>);
        runCondaStub = sinon.stub(condaUtils, 'runCondaExecutable').resolves('');
    });

    teardown(() => {
        sinon.restore();
    });

    test('CondaInstallCommand builds prefix, upgrade, and version arguments', async () => {
        const command = new CondaInstallCommand({
            pythonExecutable: 'conda',
            condaEnvironmentPath: environmentPath,
            log: mockLog,
        });

        await command.execute({ packages: [{ packageName: 'requests', version: '2.32.0' }], upgrade: true });

        assert.deepStrictEqual(runCondaStub.firstCall.args[0], [
            'install',
            '--prefix',
            environmentPath,
            '--yes',
            '--update-all',
            'requests=2.32.0',
        ]);
    });

    test('CondaUninstallCommand builds environment-specific arguments', async () => {
        const command = new CondaUninstallCommand({
            pythonExecutable: 'conda',
            condaEnvironmentPath: environmentPath,
            log: mockLog,
        });

        await command.execute({ packages: [{ packageName: 'requests' }] });

        assert.deepStrictEqual(runCondaStub.firstCall.args[0], ['remove', '-y', '-p', environmentPath, 'requests']);
    });

    test('CondaAvailableVersionsCommand parses versions keyed by package name', async () => {
        runCondaStub.resolves(JSON.stringify({ package: [{ version: '1.0.0' }, { version: '2.0.0' }] }));
        const command = new CondaAvailableVersionsCommand({ pythonExecutable: 'conda', log: mockLog });

        const result = await command.execute({ packageName: 'package', pythonVersion: '' });

        assert.deepStrictEqual(runCondaStub.firstCall.args[0], ['search', 'package', '--json']);
        assert.deepStrictEqual(result.map((version) => version.public), ['1.0.0', '2.0.0']);
    });

    test('CondaListCommand parses packages and drops incomplete entries', async () => {
        runCondaStub.resolves(JSON.stringify([{ name: 'package', version: '1.0.0' }, { name: 'broken' }]));
        const command = new CondaListCommand({
            pythonExecutable: 'conda',
            condaEnvironmentPath: environmentPath,
            log: mockLog,
        });

        const result = await command.execute();

        assert.deepStrictEqual(runCondaStub.firstCall.args[0], ['list', '-p', environmentPath, '--json']);
        assert.deepStrictEqual(
            result.map((pkg) => ({ name: pkg.name, version: pkg.version })),
            [{ name: 'package', version: '1.0.0' }],
        );
    });

    test('CondaListCommand accepts a successfully parsed empty environment', async () => {
        runCondaStub.resolves('[]');
        const command = new CondaListCommand({
            pythonExecutable: 'conda',
            condaEnvironmentPath: environmentPath,
            log: mockLog,
        });

        const result = await command.execute();

        assert.deepStrictEqual(result, []);
    });

    test('CondaListCommand rejects malformed JSON', async () => {
        runCondaStub.resolves('not json');
        const command = new CondaListCommand({
            pythonExecutable: 'conda',
            condaEnvironmentPath: environmentPath,
            log: mockLog,
        });

        await assert.rejects(() => command.execute(), SyntaxError);
        assert.ok((mockLog.error as sinon.SinonStub).calledOnce);
    });

    test('CondaListCommand rejects non-array JSON', async () => {
        runCondaStub.resolves('{}');
        const command = new CondaListCommand({
            pythonExecutable: 'conda',
            condaEnvironmentPath: environmentPath,
            log: mockLog,
        });

        await assert.rejects(() => command.execute(), /expected a JSON array/);
        assert.ok((mockLog.error as sinon.SinonStub).calledOnce);
    });

    test('CondaVersionCommand parses the version', async () => {
        runCondaStub.resolves('conda 24.1.2');
        const command = new CondaVersionCommand({ pythonExecutable: 'conda', log: mockLog });

        const result = await command.execute();

        assert.deepStrictEqual(runCondaStub.firstCall.args[0], ['--version']);
        assert.strictEqual(result?.public, '24.1.2');
    });
});
