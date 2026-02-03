import * as assert from 'assert';
import {
    extractProfilePath,
    getShellCommandAsString,
    PROFILE_TAG_END,
    PROFILE_TAG_START,
} from '../../../../../features/terminal/shells/common/shellUtils';
import { ShellConstants } from '../../../../../features/common/shellConstants';

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

    suite('getShellCommandAsString PowerShell Conda Activation', () => {
        test('should format PowerShell conda activation with dot-sourcing correctly', () => {
            const command = [
                { executable: '.', args: ['/path/to/conda-hook.ps1'] },
                { executable: 'conda', args: ['activate', 'myenv'] }
            ];
            const result = getShellCommandAsString(ShellConstants.PWSH, command);
            assert.strictEqual(result, '(. /path/to/conda-hook.ps1) ; (conda activate myenv)');
        });

        test('should format PowerShell conda activation with spaces in path correctly', () => {
            const command = [
                { executable: '.', args: ['/path with spaces/conda-hook.ps1'] },
                { executable: 'conda', args: ['activate', 'my env'] }
            ];
            const result = getShellCommandAsString(ShellConstants.PWSH, command);
            assert.strictEqual(result, '(. "/path with spaces/conda-hook.ps1") ; (conda activate "my env")');
        });

        test('should format PowerShell conda activation fallback correctly', () => {
            const command = [
                { executable: '/path/to/activate.bat' },
                { executable: 'conda', args: ['activate', 'myenv'] }
            ];
            const result = getShellCommandAsString(ShellConstants.PWSH, command);
            assert.strictEqual(result, '(/path/to/activate.bat) ; (conda activate myenv)');
        });

        test('should format single PowerShell command without parentheses', () => {
            const command = [
                { executable: 'conda', args: ['activate', 'myenv'] }
            ];
            const result = getShellCommandAsString(ShellConstants.PWSH, command);
            assert.strictEqual(result, 'conda activate myenv');
        });
    });
});
