import assert from 'assert';
import * as sinon from 'sinon';
import { LogOutputChannel } from 'vscode';
import * as helpers from '../../../managers/builtin/helpers';
import * as workspaceApis from '../../../common/workspace.apis';
import { PipAvailableVersionsCommand } from '../../../managers/builtin/commands/availableVersions';
import { createMockLogOutputChannel } from '../../mocks/helper';

suite('PipAvailableVersionsCommand - parsing', () => {
    let mockLog: LogOutputChannel;
    let runPythonStub: sinon.SinonStub;

    function createCommand(): PipAvailableVersionsCommand {
        return new PipAvailableVersionsCommand({ pythonExecutable: 'python', log: mockLog });
    }

    setup(() => {
        mockLog = createMockLogOutputChannel();
        // Avoid touching real VS Code configuration during construction.
        sinon.stub(workspaceApis, 'getConfiguration').returns({
            get: () => undefined,
        } as unknown as ReturnType<typeof workspaceApis.getConfiguration>);
        runPythonStub = sinon.stub(helpers, 'runPython');
    });

    teardown(() => {
        sinon.restore();
    });

    test('parses valid JSON with a versions array', async () => {
        runPythonStub.resolves(JSON.stringify({ package: 'requests', versions: ['2.31.0', '2.30.0', '2.29.0'] }));

        const result = await createCommand().execute({ packageName: 'requests', pythonVersion: '3.11.0' });

        assert.deepStrictEqual(result, ['2.31.0', '2.30.0', '2.29.0']);
    });

    test('filters prerelease versions by default', async () => {
        runPythonStub.resolves(JSON.stringify({ versions: ['2.0.0', '2.1.0b1', '2.1.0rc1', '2.1.0.dev0', '1.9.0'] }));

        const result = await createCommand().execute({ packageName: 'pkg', pythonVersion: '3.11.0' });

        assert.deepStrictEqual(result, ['2.0.0', '1.9.0']);
    });

    test('includes prerelease versions when requested', async () => {
        runPythonStub.resolves(JSON.stringify({ versions: ['2.0.0', '2.1.0b1'] }));

        const result = await createCommand().execute({
            packageName: 'pkg',
            pythonVersion: '3.11.0',
            includePrerelease: true,
        });

        assert.deepStrictEqual(result, ['2.0.0', '2.1.0b1']);
    });

    test('extracts JSON embedded in surrounding text', async () => {
        runPythonStub.resolves('WARNING: pip banner\n' + JSON.stringify({ versions: ['1.0.0'] }) + '\n');

        const result = await createCommand().execute({ packageName: 'pkg', pythonVersion: '3.11.0' });

        assert.deepStrictEqual(result, ['1.0.0']);
    });

    test('returns empty array for invalid JSON', async () => {
        runPythonStub.resolves('not json at all');

        const result = await createCommand().execute({ packageName: 'pkg', pythonVersion: '3.11.0' });

        assert.deepStrictEqual(result, []);
    });

    test('returns empty array for an empty versions array', async () => {
        runPythonStub.resolves(JSON.stringify({ versions: [] }));

        const result = await createCommand().execute({ packageName: 'pkg', pythonVersion: '3.11.0' });

        assert.deepStrictEqual(result, []);
    });

    test('returns empty array when versions field is missing', async () => {
        runPythonStub.resolves(JSON.stringify({ package: 'pkg' }));

        const result = await createCommand().execute({ packageName: 'pkg', pythonVersion: '3.11.0' });

        assert.deepStrictEqual(result, []);
    });
});
