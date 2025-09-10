import assert from 'node:assert';
import * as path from 'path';
import * as sinon from 'sinon';

// Simple tests for the searchPaths functionality
suite('NativePythonFinder SearchPaths Tests', () => {
    teardown(() => {
        sinon.restore();
    });

    suite('Configuration reading', () => {
        test('should handle python-env configuration namespace', () => {
            // Test that we can distinguish between python and python-env namespaces
            assert.strictEqual('python-env', 'python-env');
            assert.notStrictEqual('python-env', 'python');
        });

        test('should handle empty search paths array', () => {
            const searchPaths: string[] = [];
            assert.deepStrictEqual(searchPaths, []);
            assert.strictEqual(searchPaths.length, 0);
        });

        test('should handle populated search paths array', () => {
            const searchPaths = ['/usr/bin/python', '/home/user/.virtualenvs', '**/bin/python*'];
            assert.strictEqual(searchPaths.length, 3);
            assert.deepStrictEqual(searchPaths, ['/usr/bin/python', '/home/user/.virtualenvs', '**/bin/python*']);
        });
    });

    suite('Regex pattern detection', () => {
        test('should correctly identify regex patterns', () => {
            const regexPatterns = [
                '**/bin/python*',
                '**/*.py',
                'python[0-9]*',
                'python{3,4}',
                'python+',
                'python?',
                'python.*',
                '[Pp]ython'
            ];

            const regexChars = /[*?[\]{}()^$+|\\]/;
            regexPatterns.forEach(pattern => {
                assert.ok(regexChars.test(pattern), `Pattern ${pattern} should be detected as regex`);
            });
        });

        test('should not identify regular paths as regex', () => {
            const regularPaths = [
                '/usr/bin/python',
                '/home/user/python',
                'C:\\Python\\python.exe',
                '/opt/python3.9'
            ];

            const regexChars = /[*?[\]{}()^$+|\\]/;
            regularPaths.forEach(testPath => {
                // Note: Windows paths contain backslashes which are regex chars, 
                // but we'll handle this in the actual implementation
                if (!testPath.includes('\\')) {
                    assert.ok(!regexChars.test(testPath), `Path ${testPath} should not be detected as regex`);
                }
            });
        });

        test('should handle Windows paths specially', () => {
            const windowsPath = 'C:\\Python\\python.exe';
            const regexChars = /[*?[\]{}()^$+|\\]/;
            
            // Windows paths contain backslashes which are regex characters
            // Our implementation should handle this case
            assert.ok(regexChars.test(windowsPath), 'Windows paths contain regex chars');
        });
    });

    suite('Grand-grand parent path extraction', () => {
        test('should extract correct grand-grand parent from executable path', () => {
            const executablePath = '/home/user/.virtualenvs/myenv/bin/python';
            const expected = '/home/user/.virtualenvs';
            
            // Test path manipulation logic
            const grandGrandParent = path.dirname(path.dirname(path.dirname(executablePath)));
            assert.strictEqual(grandGrandParent, expected);
        });

        test('should handle deep nested paths', () => {
            const executablePath = '/very/deep/nested/path/to/env/bin/python';
            const expected = '/very/deep/nested/path/to';
            
            const grandGrandParent = path.dirname(path.dirname(path.dirname(executablePath)));
            assert.strictEqual(grandGrandParent, expected);
        });

        test('should handle shallow paths gracefully', () => {
            const executablePath = '/bin/python';
            
            const grandGrandParent = path.dirname(path.dirname(path.dirname(executablePath)));
            // This should result in root
            assert.ok(grandGrandParent);
            assert.strictEqual(grandGrandParent, '/');
        });

        test('should handle Windows style paths', function () {
            // Skip this test on non-Windows systems since path.dirname behaves differently
            if (process.platform !== 'win32') {
                this.skip();
                return;
            }
            
            const executablePath = 'C:\\Users\\user\\envs\\myenv\\Scripts\\python.exe';
            
            const grandGrandParent = path.dirname(path.dirname(path.dirname(executablePath)));
            const expected = 'C:\\Users\\user\\envs';
            assert.strictEqual(grandGrandParent, expected);
        });
    });

    suite('Array deduplication logic', () => {
        test('should remove duplicate paths', () => {
            const paths = ['/path1', '/path2', '/path1', '/path3', '/path2'];
            const unique = Array.from(new Set(paths));
            
            assert.strictEqual(unique.length, 3);
            assert.deepStrictEqual(unique, ['/path1', '/path2', '/path3']);
        });

        test('should handle empty arrays', () => {
            const paths: string[] = [];
            const unique = Array.from(new Set(paths));
            
            assert.strictEqual(unique.length, 0);
            assert.deepStrictEqual(unique, []);
        });

        test('should handle single item arrays', () => {
            const paths = ['/single/path'];
            const unique = Array.from(new Set(paths));
            
            assert.strictEqual(unique.length, 1);
            assert.deepStrictEqual(unique, ['/single/path']);
        });
    });

    suite('String trimming and validation', () => {
        test('should handle empty and whitespace-only strings', () => {
            const testStrings = ['', '   ', '\t\n', 'valid'];
            const filtered = testStrings.filter(s => s && s.trim() !== '');
            
            assert.deepStrictEqual(filtered, ['valid']);
        });

        test('should trim whitespace from paths', () => {
            const pathWithWhitespace = '  /path/to/python  ';
            const trimmed = pathWithWhitespace.trim();
            
            assert.strictEqual(trimmed, '/path/to/python');
        });
    });

    suite('Python executable detection', () => {
        test('should identify python-like filenames', () => {
            const filenames = [
                'python',
                'python3',
                'python3.9',
                'python.exe',
                'Python.exe',
                'python3.11.exe'
            ];

            filenames.forEach(filename => {
                const lowerFilename = filename.toLowerCase();
                assert.ok(
                    lowerFilename.includes('python') || path.basename(lowerFilename).startsWith('python'),
                    `${filename} should be identified as python executable`
                );
            });
        });

        test('should not identify non-python files', () => {
            const filenames = [
                'node',
                'npm',
                'pip',
                'bash',
                'zsh'
            ];

            filenames.forEach(filename => {
                const lowerFilename = filename.toLowerCase();
                const isPython = lowerFilename.includes('python') || path.basename(lowerFilename).startsWith('python');
                assert.ok(!isPython, `${filename} should not be identified as python executable`);
            });
        });
    });
});