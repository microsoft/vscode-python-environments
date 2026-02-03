import * as assert from 'assert';
import { PythonCommandRunConfiguration } from '../../../../../api';
import { ShellConstants } from '../../../../../features/common/shellConstants';
import {
    extractProfilePath,
    getShellCommandAsString,
    PROFILE_TAG_END,
    PROFILE_TAG_START,
    shellsWithLeadingSpaceHistorySupport,
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
        const sampleCommand: PythonCommandRunConfiguration[] = [
            { executable: 'source', args: ['/path/to/activate'] },
        ];

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
    });
});
