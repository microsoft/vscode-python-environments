import * as assert from 'assert';
import { PythonCommandRunConfiguration } from '../../../../../api';
import { ShellConstants } from '../../../../../features/common/shellConstants';
import {
    extractProfilePath,
    getShellCommandAsString,
    PROFILE_TAG_END,
    PROFILE_TAG_START,
    shellsWithLeadingSpaceHistorySupport,
    wrapDeactivationCommand,
} from '../../../../../features/terminal/shells/common/shellUtils';

suite('Shell Utils', () => {
    suite('extractProfilePath', () => {
        test('should return undefined when content is empty', () => {
            const content = '';
            const result = extractProfilePath(content);
            assert.strictEqual(result, undefined);
        });

        test('should return undefined when content does not have tags', () => {
            const content = 'sample content without tags';
            const result = extractProfilePath(content);
            assert.strictEqual(result, undefined);
        });

        test('should return undefined when only start tag exists', () => {
            const content = `content\n${PROFILE_TAG_START}\nsome path`;
            const result = extractProfilePath(content);
            assert.strictEqual(result, undefined);
        });

        test('should return undefined when only end tag exists', () => {
            const content = `content\nsome path\n${PROFILE_TAG_END}`;
            const result = extractProfilePath(content);
            assert.strictEqual(result, undefined);
        });

        test('should return undefined when tags are in wrong order', () => {
            const content = `content\n${PROFILE_TAG_END}\nsome path\n${PROFILE_TAG_START}`;
            const result = extractProfilePath(content);
            assert.strictEqual(result, undefined);
        });
        test('should return undefined when content between tags is empty', () => {
            const content = `content\n${PROFILE_TAG_START}\n\n${PROFILE_TAG_END}\nmore content`;
            const result = extractProfilePath(content);
            assert.strictEqual(result, undefined);
        });

        test('should extract path when found between tags', () => {
            const expectedPath = '/usr/local/bin/python';
            const content = `content\n${PROFILE_TAG_START}\n${expectedPath}\n${PROFILE_TAG_END}\nmore content`;
            const result = extractProfilePath(content);
            assert.strictEqual(result, expectedPath);
        });

        test('should trim whitespace from extracted path', () => {
            const expectedPath = '/usr/local/bin/python';
            const content = `content\n${PROFILE_TAG_START}\n  ${expectedPath}  \n${PROFILE_TAG_END}\nmore content`;
            const result = extractProfilePath(content);
            assert.strictEqual(result, expectedPath);
        });

        test('should handle Windows-style line endings', () => {
            const expectedPath = 'C:\\Python\\python.exe';
            const content = `content\r\n${PROFILE_TAG_START}\r\n${expectedPath}\r\n${PROFILE_TAG_END}\r\nmore content`;
            const result = extractProfilePath(content);
            assert.strictEqual(result, expectedPath);
        });

        test('should extract path with special characters', () => {
            const expectedPath = '/path with spaces/and (parentheses)/python';
            const content = `${PROFILE_TAG_START}\n${expectedPath}\n${PROFILE_TAG_END}`;
            const result = extractProfilePath(content);
            assert.strictEqual(result, expectedPath);
        });

        test('should extract multiline content correctly', () => {
            const expectedPath = 'line1\nline2\nline3';
            const content = `${PROFILE_TAG_START}\n${expectedPath}\n${PROFILE_TAG_END}`;
            const result = extractProfilePath(content);
            assert.strictEqual(result, expectedPath);
        });
    });

    suite('shellsWithLeadingSpaceHistorySupport', () => {
        test('should include bash, zsh, and gitbash', () => {
            assert.ok(shellsWithLeadingSpaceHistorySupport.has(ShellConstants.BASH));
            assert.ok(shellsWithLeadingSpaceHistorySupport.has(ShellConstants.ZSH));
            assert.ok(shellsWithLeadingSpaceHistorySupport.has(ShellConstants.GITBASH));
        });

        test('should not include shells without leading space history support', () => {
            assert.ok(!shellsWithLeadingSpaceHistorySupport.has(ShellConstants.PWSH));
            assert.ok(!shellsWithLeadingSpaceHistorySupport.has(ShellConstants.CMD));
            assert.ok(!shellsWithLeadingSpaceHistorySupport.has(ShellConstants.FISH));
            assert.ok(!shellsWithLeadingSpaceHistorySupport.has(ShellConstants.SH));
            assert.ok(!shellsWithLeadingSpaceHistorySupport.has(ShellConstants.NU));
        });
    });

    suite('getShellCommandAsString', () => {
        const sampleCommand: PythonCommandRunConfiguration[] = [{ executable: 'source', args: ['/path/to/activate'] }];

        suite('leading space for history ignore', () => {
            test('should add leading space for bash commands', () => {
                const result = getShellCommandAsString(ShellConstants.BASH, sampleCommand);
                assert.ok(result.startsWith(' '), 'Bash command should start with a leading space');
                assert.ok(result.includes('source'), 'Command should contain source');
            });

            test('should add leading space for zsh commands', () => {
                const result = getShellCommandAsString(ShellConstants.ZSH, sampleCommand);
                assert.ok(result.startsWith(' '), 'Zsh command should start with a leading space');
                assert.ok(result.includes('source'), 'Command should contain source');
            });

            test('should add leading space for gitbash commands', () => {
                const result = getShellCommandAsString(ShellConstants.GITBASH, sampleCommand);
                assert.ok(result.startsWith(' '), 'Git Bash command should start with a leading space');
                assert.ok(result.includes('source'), 'Command should contain source');
            });

            test('should not add leading space for pwsh commands', () => {
                const result = getShellCommandAsString(ShellConstants.PWSH, sampleCommand);
                assert.ok(!result.startsWith(' '), 'PowerShell command should not start with a leading space');
            });

            test('should not add leading space for cmd commands', () => {
                const result = getShellCommandAsString(ShellConstants.CMD, sampleCommand);
                assert.ok(!result.startsWith(' '), 'CMD command should not start with a leading space');
            });

            test('should not add leading space for fish commands', () => {
                const result = getShellCommandAsString(ShellConstants.FISH, sampleCommand);
                assert.ok(!result.startsWith(' '), 'Fish command should not start with a leading space');
            });

            test('should not add leading space for sh commands', () => {
                const result = getShellCommandAsString(ShellConstants.SH, sampleCommand);
                assert.ok(!result.startsWith(' '), 'SH command should not start with a leading space');
            });

            test('should not add leading space for nu commands', () => {
                const result = getShellCommandAsString(ShellConstants.NU, sampleCommand);
                assert.ok(!result.startsWith(' '), 'Nu command should not start with a leading space');
            });

            test('should not add leading space for unknown shells', () => {
                const result = getShellCommandAsString('unknown', sampleCommand);
                assert.ok(!result.startsWith(' '), 'Unknown shell command should not start with a leading space');
            });
        });

        suite('command formatting', () => {
            test('should format multiple commands with && for bash', () => {
                const multiCommand: PythonCommandRunConfiguration[] = [
                    { executable: 'source', args: ['/path/to/init'] },
                    { executable: 'conda', args: ['activate', 'myenv'] },
                ];
                const result = getShellCommandAsString(ShellConstants.BASH, multiCommand);
                assert.ok(result.includes('&&'), 'Bash should use && to join commands');
                assert.ok(result.startsWith(' '), 'Bash command should start with a leading space');
            });

            test('should format multiple commands with ; for pwsh', () => {
                const multiCommand: PythonCommandRunConfiguration[] = [
                    { executable: 'source', args: ['/path/to/init'] },
                    { executable: 'conda', args: ['activate', 'myenv'] },
                ];
                const result = getShellCommandAsString(ShellConstants.PWSH, multiCommand);
                assert.ok(result.includes(';'), 'PowerShell should use ; to join commands');
                assert.ok(!result.startsWith(' '), 'PowerShell command should not start with a leading space');
            });

            test('should format multiple commands with "; and" for fish', () => {
                const multiCommand: PythonCommandRunConfiguration[] = [
                    { executable: 'source', args: ['/path/to/init'] },
                    { executable: 'conda', args: ['activate', 'myenv'] },
                ];
                const result = getShellCommandAsString(ShellConstants.FISH, multiCommand);
                assert.ok(result.includes('; and'), 'Fish should use "; and" to join commands');
                assert.ok(!result.startsWith(' '), 'Fish command should not start with a leading space');
            });
        });

        suite('empty command handling', () => {
            test('should return empty string for empty command array (bash)', () => {
                const result = getShellCommandAsString(ShellConstants.BASH, []);
                assert.strictEqual(result, '', 'Empty command array should return empty string');
            });

            test('should return empty string for empty command array (gitbash)', () => {
                const result = getShellCommandAsString(ShellConstants.GITBASH, []);
                assert.strictEqual(result, '', 'Empty command array should return empty string');
            });

            test('should return empty string for empty command array (pwsh)', () => {
                const result = getShellCommandAsString(ShellConstants.PWSH, []);
                assert.strictEqual(result, '', 'Empty command array should return empty string');
            });

            test('should return empty string for empty command array (cmd)', () => {
                const result = getShellCommandAsString(ShellConstants.CMD, []);
                assert.strictEqual(result, '', 'Empty command array should return empty string');
            });
        });
    });

    suite('wrapDeactivationCommand', () => {
        // Each tuple: [shell, expected guard substring]. Guards must include the bare
        // `deactivate` token so the wrapped command still deactivates when the function
        // exists. See issue #1490.
        const posixShellsCases: Array<[string, string]> = [
            [ShellConstants.BASH, 'command -v deactivate >/dev/null 2>&1 && deactivate'],
            [ShellConstants.SH, 'command -v deactivate >/dev/null 2>&1 && deactivate'],
            [ShellConstants.ZSH, 'command -v deactivate >/dev/null 2>&1 && deactivate'],
            [ShellConstants.KSH, 'command -v deactivate >/dev/null 2>&1 && deactivate'],
            [ShellConstants.GITBASH, 'command -v deactivate >/dev/null 2>&1 && deactivate'],
        ];

        posixShellsCases.forEach(([shell, expected]) => {
            test(`wraps bare deactivate with existence guard for ${shell}`, () => {
                const result = wrapDeactivationCommand(shell, 'deactivate');
                assert.ok(
                    result.includes(expected),
                    `Expected wrapped command to contain '${expected}', got '${result}'`,
                );
            });

            test(`tolerates a leading space (history-ignore) on input for ${shell}`, () => {
                const result = wrapDeactivationCommand(shell, ' deactivate');
                assert.ok(
                    result.includes(expected),
                    `Expected wrapped command to contain '${expected}', got '${result}'`,
                );
            });
        });

        test('preserves leading space for shells that support history-ignore', () => {
            // bash/zsh/gitbash get a leading space so HISTCONTROL=ignorespace works.
            assert.ok(wrapDeactivationCommand(ShellConstants.BASH, 'deactivate').startsWith(' '));
            assert.ok(wrapDeactivationCommand(ShellConstants.ZSH, 'deactivate').startsWith(' '));
            assert.ok(wrapDeactivationCommand(ShellConstants.GITBASH, 'deactivate').startsWith(' '));
        });

        test('does not add leading space for shells without history-ignore support', () => {
            assert.ok(!wrapDeactivationCommand(ShellConstants.PWSH, 'deactivate').startsWith(' '));
            assert.ok(!wrapDeactivationCommand(ShellConstants.FISH, 'deactivate').startsWith(' '));
        });

        test('wraps bare deactivate with functions -q for fish', () => {
            const result = wrapDeactivationCommand(ShellConstants.FISH, 'deactivate');
            assert.strictEqual(result, 'functions -q deactivate; and deactivate');
        });

        test('wraps bare deactivate with Get-Command for pwsh', () => {
            const result = wrapDeactivationCommand(ShellConstants.PWSH, 'deactivate');
            assert.strictEqual(result, 'if (Get-Command deactivate -ErrorAction SilentlyContinue) { deactivate }');
        });

        test('passes through non-bare deactivate commands unchanged (cmd full path)', () => {
            const cmd = 'C:\\envs\\myenv\\Scripts\\deactivate.bat';
            const result = wrapDeactivationCommand(ShellConstants.CMD, cmd);
            assert.strictEqual(result, cmd);
        });

        test('passes through conda deactivate unchanged (legitimate failure if conda missing)', () => {
            const result = wrapDeactivationCommand(ShellConstants.BASH, 'conda deactivate');
            assert.strictEqual(result, 'conda deactivate');
        });

        test('passes through pyenv shell --unset unchanged', () => {
            const result = wrapDeactivationCommand(ShellConstants.BASH, 'pyenv shell --unset');
            assert.strictEqual(result, 'pyenv shell --unset');
        });

        test('passes through nu overlay hide unchanged', () => {
            const result = wrapDeactivationCommand(ShellConstants.NU, 'overlay hide activate');
            assert.strictEqual(result, 'overlay hide activate');
        });

        test('passes through unknown shell unchanged even for bare deactivate', () => {
            const result = wrapDeactivationCommand('unknown', 'deactivate');
            assert.strictEqual(result, 'deactivate');
        });

        test('passes through case-mismatched tokens unchanged (no false-positive wraps)', () => {
            // Only an exact `deactivate` token triggers wrapping; anything containing other
            // tokens (e.g. wrapper functions in user shells) is the user's responsibility.
            const result = wrapDeactivationCommand(ShellConstants.BASH, 'my-deactivate');
            assert.strictEqual(result, 'my-deactivate');
        });

        test('wraps DEACTIVATE token case-insensitively (pwsh)', () => {
            // PowerShell is case-insensitive; the activation script's function may be
            // reported in any case. The wrap should still apply.
            const result = wrapDeactivationCommand(ShellConstants.PWSH, 'DEACTIVATE');
            assert.strictEqual(result, 'if (Get-Command deactivate -ErrorAction SilentlyContinue) { deactivate }');
        });
    });
});
