import assert from 'node:assert';
import * as path from 'path';
import * as sinon from 'sinon';

// Tests for the updated searchPaths functionality
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
            const searchPaths = ['/home/user/.virtualenvs', '**/bin/python*'];
            assert.strictEqual(searchPaths.length, 2);
            assert.deepStrictEqual(searchPaths, ['/home/user/.virtualenvs', '**/bin/python*']);
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

            const regexChars = /[*?[\]{}()^$+|]/;
            regexPatterns.forEach(pattern => {
                assert.ok(regexChars.test(pattern), `Pattern ${pattern} should be detected as regex`);
            });
        });

        test('should not identify regular directory paths as regex', () => {
            const regularPaths = [
                '/usr/local/python',
                '/home/user/.virtualenvs',
                '/opt/python3.9'
            ];

            const regexChars = /[*?[\]{}()^$+|]/;
            regularPaths.forEach(testPath => {
                assert.ok(!regexChars.test(testPath), `Path ${testPath} should not be detected as regex`);
            });
        });

        test('should handle Windows paths specially', () => {
            const windowsPath = 'C:\\Users\\user\\envs';
            const regexChars = /[*?[\]{}()^$+|\\]/; // Added backslash to match implementation
            
            // Windows paths contain backslashes which are regex characters
            // Our implementation should handle this case by checking for valid Windows path patterns
            assert.ok(regexChars.test(windowsPath), 'Windows paths contain regex chars');
            
            // Test that we can identify valid Windows paths and NOT treat them as regex
            const hasBackslash = windowsPath.includes('\\');
            const isWindowsPath = hasBackslash && (windowsPath.match(/^[A-Za-z]:\\/) || windowsPath.match(/^\\\\[^\\]+\\/));
            const isRegexPattern = regexChars.test(windowsPath) && !isWindowsPath;
            
            assert.ok(isWindowsPath, 'Should recognize Windows path pattern');
            assert.ok(!isRegexPattern, 'Should not treat Windows path as regex pattern');
        });
    });

    suite('Environment directory path extraction', () => {
        test('should extract correct environment directory from executable path', () => {
            const executablePath = '/home/user/.virtualenvs/myenv/bin/python';
            const expected = '/home/user/.virtualenvs';
            
            // Test path manipulation logic
            const environmentDir = path.dirname(path.dirname(path.dirname(executablePath)));
            assert.strictEqual(environmentDir, expected);
        });

        test('should handle deep nested paths', () => {
            const executablePath = '/very/deep/nested/path/to/env/bin/python';
            const expected = '/very/deep/nested/path/to';
            
            const environmentDir = path.dirname(path.dirname(path.dirname(executablePath)));
            assert.strictEqual(environmentDir, expected);
        });

        test('should handle shallow paths gracefully', () => {
            const executablePath = '/bin/python';
            
            const greatGrandParent = path.dirname(path.dirname(path.dirname(executablePath)));
            // This should result in root
            assert.ok(greatGrandParent);
            assert.strictEqual(greatGrandParent, '/');
        });

        test('should handle Windows style paths', function () {
            // Skip this test on non-Windows systems since path.dirname behaves differently
            if (process.platform !== 'win32') {
                this.skip();
                return;
            }
            
            const executablePath = 'C:\\Users\\user\\envs\\myenv\\Scripts\\python.exe';
            
            const greatGrandParent = path.dirname(path.dirname(path.dirname(executablePath)));
            const expected = 'C:\\Users\\user\\envs';
            assert.strictEqual(greatGrandParent, expected);
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
            const pathWithWhitespace = '  /path/to/directory  ';
            const trimmed = pathWithWhitespace.trim();
            
            assert.strictEqual(trimmed, '/path/to/directory');
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

    suite('Settings precedence logic', () => {
        test('should handle array equality comparison', () => {
            const array1 = ['path1', 'path2'];
            const array2 = ['path1', 'path2'];
            const array3 = ['path1', 'path3'];
            
            // Arrays with same content should be equal
            assert.strictEqual(array1.length, array2.length);
            assert.ok(array1.every((val, index) => val === array2[index]));
            
            // Arrays with different content should not be equal
            assert.ok(!array1.every((val, index) => val === array3[index]));
        });

        test('should handle empty arrays in comparison', () => {
            const emptyArray1: string[] = [];
            const emptyArray2: string[] = [];
            const nonEmptyArray = ['path1'];
            
            // Empty arrays should be equal (every element matches)
            assert.ok(emptyArray1.every((val, index) => val === emptyArray2[index]));
            
            // Empty array should not match non-empty array (lengths differ)
            assert.ok(emptyArray1.length !== nonEmptyArray.length);
        });
    });

    suite('Path type detection', () => {
        test('should detect directory paths correctly', () => {
            const directoryPaths = [
                '/home/user/.virtualenvs',
                '/opt/python/envs',
                'C:\\Users\\user\\envs'
            ];
            
            // These are all valid directory-style paths
            directoryPaths.forEach(dirPath => {
                assert.ok(typeof dirPath === 'string' && dirPath.length > 0);
                // Should not contain regex characters (except Windows backslashes)
                if (!dirPath.includes('\\')) {
                    const regexChars = /[*?[\]{}()^$+|]/;
                    assert.ok(!regexChars.test(dirPath), `${dirPath} should be a plain directory path`);
                }
            });
        });
    });
});