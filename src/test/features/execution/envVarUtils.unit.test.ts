import * as assert from 'assert';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import * as workspaceFsApis from '../../../common/workspace.fs.apis';
import { mergeEnvVariables, parseEnvFile } from '../../../features/execution/envVarUtils';

suite('Environment Variable Utils Tests', () => {
    suite('mergeEnvVariables', () => {
        test('should merge other values into base', () => {
            const base = { FOO: 'foo_value', BAR: 'bar_value' };
            const other = { NEW_KEY: 'new_value' };
            const result = mergeEnvVariables(base, other);
            assert.deepStrictEqual(result, { NEW_KEY: 'new_value' });
        });

        test('should replace variables in other values using base values', () => {
            const base = { HOME: '/home/user' };
            const other = { PATH: '${HOME}/bin' };
            const result = mergeEnvVariables(base, other);
            assert.strictEqual(result.PATH, '/home/user/bin');
        });

        test('should delete keys when value is undefined', () => {
            const base = { FOO: 'foo_value' };
            const other = { KEY: undefined };
            const result = mergeEnvVariables(base, other as { [key: string]: string | undefined });
            assert.strictEqual(result.KEY, undefined);
            assert.strictEqual(Object.prototype.hasOwnProperty.call(result, 'KEY'), false);
        });

        test('should delete keys when value is empty string', () => {
            const base = { FOO: 'foo_value' };
            const other = { KEY: '' };
            const result = mergeEnvVariables(base, other);
            assert.strictEqual(result.KEY, undefined);
            assert.strictEqual(Object.prototype.hasOwnProperty.call(result, 'KEY'), false);
        });

        test('should handle multiple variable replacements', () => {
            const base = { HOME: '/home/user', USER: 'testuser' };
            const other = { FULL_PATH: '${HOME}/${USER}/.config' };
            const result = mergeEnvVariables(base, other);
            assert.strictEqual(result.FULL_PATH, '/home/user/testuser/.config');
        });

        test('should handle empty base', () => {
            const base = {};
            const other = { FOO: 'bar' };
            const result = mergeEnvVariables(base, other);
            assert.deepStrictEqual(result, { FOO: 'bar' });
        });

        test('should handle empty other', () => {
            const base = { FOO: 'bar' };
            const other = {};
            const result = mergeEnvVariables(base, other);
            assert.deepStrictEqual(result, {});
        });
    });

    suite('parseEnvFile', () => {
        let mockReadFile: sinon.SinonStub;

        setup(() => {
            mockReadFile = sinon.stub(workspaceFsApis, 'readFile');
        });

        teardown(() => {
            sinon.restore();
        });

        test('should parse simple key-value pair', async () => {
            const envContent = 'FOO=bar';
            mockReadFile.resolves(Buffer.from(envContent));

            const result = await parseEnvFile(Uri.file('/path/to/.env'));

            assert.strictEqual(result.FOO, 'bar');
        });

        test('should strip trailing comments from unquoted values', async () => {
            const envContent = 'FOO=bar  # trailing comment';
            mockReadFile.resolves(Buffer.from(envContent));

            const result = await parseEnvFile(Uri.file('/path/to/.env'));

            assert.strictEqual(result.FOO, 'bar', 'Trailing comment should be stripped from unquoted value');
        });

        test('should strip trailing comments with single space', async () => {
            const envContent = 'FOO=bar # comment';
            mockReadFile.resolves(Buffer.from(envContent));

            const result = await parseEnvFile(Uri.file('/path/to/.env'));

            assert.strictEqual(result.FOO, 'bar', 'Trailing comment should be stripped');
        });

        test('should preserve hash in double-quoted values', async () => {
            const envContent = 'FOO="bar  # not a comment"';
            mockReadFile.resolves(Buffer.from(envContent));

            const result = await parseEnvFile(Uri.file('/path/to/.env'));

            assert.strictEqual(result.FOO, 'bar  # not a comment', 'Hash inside quotes should be preserved');
        });

        test('should preserve hash in single-quoted values', async () => {
            const envContent = "FOO='bar  # not a comment'";
            mockReadFile.resolves(Buffer.from(envContent));

            const result = await parseEnvFile(Uri.file('/path/to/.env'));

            assert.strictEqual(result.FOO, 'bar  # not a comment', 'Hash inside quotes should be preserved');
        });

        test('should strip trailing comments after double-quoted values', async () => {
            const envContent = 'FOO="bar"  # trailing comment';
            mockReadFile.resolves(Buffer.from(envContent));

            const result = await parseEnvFile(Uri.file('/path/to/.env'));

            assert.strictEqual(result.FOO, 'bar', 'Trailing comment after quoted value should be stripped');
        });

        test('should strip trailing comments after single-quoted values', async () => {
            const envContent = "FOO='bar'  # trailing comment";
            mockReadFile.resolves(Buffer.from(envContent));

            const result = await parseEnvFile(Uri.file('/path/to/.env'));

            assert.strictEqual(result.FOO, 'bar', 'Trailing comment after quoted value should be stripped');
        });

        test('should ignore full-line comments', async () => {
            const envContent = '# This is a comment\nFOO=bar';
            mockReadFile.resolves(Buffer.from(envContent));

            const result = await parseEnvFile(Uri.file('/path/to/.env'));

            assert.strictEqual(result.FOO, 'bar');
            assert.strictEqual(Object.keys(result).length, 1);
        });

        test('should handle multiple lines with comments', async () => {
            const envContent = `# Config file
FOO=bar  # first var
BAZ=qux  # second var
# Another comment
TEST=value`;
            mockReadFile.resolves(Buffer.from(envContent));

            const result = await parseEnvFile(Uri.file('/path/to/.env'));

            assert.strictEqual(result.FOO, 'bar', 'First var should have comment stripped');
            assert.strictEqual(result.BAZ, 'qux', 'Second var should have comment stripped');
            assert.strictEqual(result.TEST, 'value', 'Third var should be parsed');
            assert.strictEqual(Object.keys(result).length, 3);
        });

        test('should handle value with hash but no spaces (treated as comment)', async () => {
            const envContent = 'FOO=bar#comment';
            mockReadFile.resolves(Buffer.from(envContent));

            const result = await parseEnvFile(Uri.file('/path/to/.env'));

            // dotenv treats # as start of comment even without spaces
            assert.strictEqual(result.FOO, 'bar', 'Hash without space should still be treated as comment start');
        });

        test('should handle empty file', async () => {
            const envContent = '';
            mockReadFile.resolves(Buffer.from(envContent));

            const result = await parseEnvFile(Uri.file('/path/to/.env'));

            assert.deepStrictEqual(result, {});
        });

        test('should handle file with only comments', async () => {
            const envContent = '# Comment 1\n# Comment 2';
            mockReadFile.resolves(Buffer.from(envContent));

            const result = await parseEnvFile(Uri.file('/path/to/.env'));

            assert.deepStrictEqual(result, {});
        });

        test('should handle Windows line endings (CRLF)', async () => {
            const envContent = 'FOO=bar  # comment\r\nBAZ=qux  # another comment';
            mockReadFile.resolves(Buffer.from(envContent));

            const result = await parseEnvFile(Uri.file('/path/to/.env'));

            assert.strictEqual(result.FOO, 'bar');
            assert.strictEqual(result.BAZ, 'qux');
        });

        test('should handle empty values', async () => {
            const envContent = 'FOO=';
            mockReadFile.resolves(Buffer.from(envContent));

            const result = await parseEnvFile(Uri.file('/path/to/.env'));

            assert.strictEqual(result.FOO, '');
        });

        test('should handle values with equal signs', async () => {
            const envContent = 'FOO=bar=baz';
            mockReadFile.resolves(Buffer.from(envContent));

            const result = await parseEnvFile(Uri.file('/path/to/.env'));

            assert.strictEqual(result.FOO, 'bar=baz');
        });

        test('should handle export prefix', async () => {
            const envContent = 'export FOO=bar  # comment';
            mockReadFile.resolves(Buffer.from(envContent));

            const result = await parseEnvFile(Uri.file('/path/to/.env'));

            assert.strictEqual(result.FOO, 'bar');
        });
    });
});
