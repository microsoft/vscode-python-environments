import * as assert from 'assert';
import {
    getAutoRunCallCommand,
    hasAutoRunCommand,
    mergeAutoRunCommand,
    splitAutoRunCommands,
} from '../../../../../features/terminal/shells/cmd/cmdStartup';

suite('CMD AutoRun Startup Integration', () => {
    const mainBatch = 'C:\\Users\\test\\.cmdrc\\cmd_startup.bat';
    const regBatch = '%USERPROFILE%\\.cmdrc\\cmd_startup.bat';
    const ourCommand = `if exist "${mainBatch}" call "${mainBatch}"`;
    const regOurCommand = `if exist "${regBatch}" call "${regBatch}"`;

    suite('getAutoRunCallCommand', () => {
        test('formats invocation command with if exist call syntax', () => {
            assert.strictEqual(getAutoRunCallCommand(mainBatch), ourCommand);
        });
    });

    suite('splitAutoRunCommands', () => {
        test('returns empty array for empty or whitespace strings', () => {
            assert.deepStrictEqual(splitAutoRunCommands(''), []);
            assert.deepStrictEqual(splitAutoRunCommands('   '), []);
        });

        test('splits commands delimited by single &', () => {
            const input = 'cmd1 & cmd2 & cmd3';
            assert.deepStrictEqual(splitAutoRunCommands(input), ['cmd1', 'cmd2', 'cmd3']);
        });

        test('splits commands delimited by &&', () => {
            const input = 'cmd1 && cmd2';
            assert.deepStrictEqual(splitAutoRunCommands(input), ['cmd1', 'cmd2']);
        });

        test('preserves & inside double-quoted paths or arguments', () => {
            const input = '"C:\\tools & scripts\\init.cmd" & doskey /macrofile=macros.txt';
            assert.deepStrictEqual(splitAutoRunCommands(input), [
                '"C:\\tools & scripts\\init.cmd"',
                'doskey /macrofile=macros.txt',
            ]);
        });
    });

    suite('hasAutoRunCommand', () => {
        test('returns false for undefined or empty AutoRun', () => {
            assert.strictEqual(hasAutoRunCommand(undefined, mainBatch), false);
            assert.strictEqual(hasAutoRunCommand('', mainBatch), false);
            assert.strictEqual(hasAutoRunCommand('   ', mainBatch), false);
        });

        test('returns false when AutoRun contains only other commands', () => {
            assert.strictEqual(hasAutoRunCommand('"C:\\tools\\init.cmd"', mainBatch), false);
            assert.strictEqual(hasAutoRunCommand('cmd1 & cmd2', mainBatch, regBatch), false);
        });

        test('returns true when AutoRun contains mainBatchFile path', () => {
            assert.strictEqual(hasAutoRunCommand(ourCommand, mainBatch), true);
            assert.strictEqual(hasAutoRunCommand(`"C:\\tools\\init.cmd" & ${ourCommand}`, mainBatch), true);
        });

        test('returns true when AutoRun contains regMainBatchFile path', () => {
            assert.strictEqual(hasAutoRunCommand(regOurCommand, mainBatch, regBatch), true);
            assert.strictEqual(hasAutoRunCommand(`"C:\\tools\\init.cmd" & ${regOurCommand}`, mainBatch, regBatch), true);
        });
    });

    suite('mergeAutoRunCommand', () => {
        test('returns our command when AutoRun is undefined or empty', () => {
            assert.strictEqual(mergeAutoRunCommand(undefined, mainBatch), ourCommand);
            assert.strictEqual(mergeAutoRunCommand('', mainBatch), ourCommand);
            assert.strictEqual(mergeAutoRunCommand('   ', mainBatch), ourCommand);
        });

        test('chains our command after user command with &', () => {
            const existing = '"C:\\tools\\init.cmd"';
            const expected = `"${'C:\\tools\\init.cmd'}" & ${ourCommand}`;
            assert.strictEqual(mergeAutoRunCommand(existing, mainBatch), expected);
        });

        test('is idempotent when AutoRun already contains our command', () => {
            const existing = `"C:\\tools\\init.cmd" & ${ourCommand}`;
            assert.strictEqual(mergeAutoRunCommand(existing, mainBatch), existing);
        });

        test('is idempotent when AutoRun contains regMainBatchFile', () => {
            const existing = `"C:\\tools\\init.cmd" & ${regOurCommand}`;
            assert.strictEqual(mergeAutoRunCommand(existing, mainBatch, regBatch), existing);
        });

        test('chains when user content contains multiple commands', () => {
            const existing = 'cmd1 & cmd2';
            const expected = `cmd1 & cmd2 & ${ourCommand}`;
            assert.strictEqual(mergeAutoRunCommand(existing, mainBatch), expected);
        });
    });
});
