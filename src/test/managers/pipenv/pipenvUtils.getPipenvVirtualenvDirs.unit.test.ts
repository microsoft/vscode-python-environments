import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getPipenvVirtualenvDirs } from '../../../managers/pipenv/pipenvUtils';

/**
 * Tests for getPipenvVirtualenvDirs.
 *
 * The function should return directories where pipenv virtualenvs are stored,
 * checking these locations in priority order:
 * 1. WORKON_HOME (if set and exists)
 * 2. XDG_DATA_HOME/virtualenvs (if XDG_DATA_HOME is set and path exists)
 * 3. ~/.local/share/virtualenvs (Linux/macOS default)
 * 4. ~/.virtualenvs (Windows default)
 *
 * These tests use real temp directories for filesystem operations since
 * native fs.existsSync cannot be stubbed (non-configurable property).
 */
suite('Pipenv Utils - getPipenvVirtualenvDirs', () => {
    let originalEnv: NodeJS.ProcessEnv;
    let tempDir: string;

    setup(() => {
        // Save original env
        originalEnv = { ...process.env };

        // Clear relevant env vars
        delete process.env.WORKON_HOME;
        delete process.env.XDG_DATA_HOME;

        // Create a temp directory for tests
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipenv-test-'));
    });

    teardown(() => {
        // Restore original env
        process.env = originalEnv;

        // Clean up temp directory
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('Returns WORKON_HOME when set and exists', () => {
        const workonPath = path.join(tempDir, 'workon_home');
        fs.mkdirSync(workonPath);
        process.env.WORKON_HOME = workonPath;

        const dirs = getPipenvVirtualenvDirs();

        assert.ok(dirs.includes(workonPath), 'WORKON_HOME should be included');
    });

    test('Ignores WORKON_HOME when set but does not exist', () => {
        const workonPath = path.join(tempDir, 'nonexistent_workon');
        // Don't create the directory
        process.env.WORKON_HOME = workonPath;

        const dirs = getPipenvVirtualenvDirs();

        assert.ok(!dirs.includes(workonPath), 'Non-existent WORKON_HOME should not be included');
    });

    test('Returns XDG_DATA_HOME/virtualenvs when set and exists', () => {
        const xdgBase = path.join(tempDir, 'xdg_data');
        const xdgVenvs = path.join(xdgBase, 'virtualenvs');
        fs.mkdirSync(xdgBase);
        fs.mkdirSync(xdgVenvs);
        process.env.XDG_DATA_HOME = xdgBase;

        const dirs = getPipenvVirtualenvDirs();

        assert.ok(dirs.includes(xdgVenvs), 'XDG_DATA_HOME/virtualenvs should be included');
    });

    test('Ignores XDG_DATA_HOME when virtualenvs subdir does not exist', () => {
        const xdgBase = path.join(tempDir, 'xdg_data_novenvs');
        fs.mkdirSync(xdgBase);
        // Don't create virtualenvs subdir
        process.env.XDG_DATA_HOME = xdgBase;

        const dirs = getPipenvVirtualenvDirs();

        const xdgVenvs = path.join(xdgBase, 'virtualenvs');
        assert.ok(!dirs.includes(xdgVenvs), 'Non-existent XDG_DATA_HOME/virtualenvs should not be included');
    });

    test('WORKON_HOME takes precedence and appears first', () => {
        const workonPath = path.join(tempDir, 'workon');
        const xdgBase = path.join(tempDir, 'xdg');
        const xdgVenvs = path.join(xdgBase, 'virtualenvs');

        fs.mkdirSync(workonPath);
        fs.mkdirSync(xdgBase);
        fs.mkdirSync(xdgVenvs);

        process.env.WORKON_HOME = workonPath;
        process.env.XDG_DATA_HOME = xdgBase;

        const dirs = getPipenvVirtualenvDirs();

        assert.strictEqual(dirs[0], workonPath, 'WORKON_HOME should be first');
        assert.ok(dirs.includes(xdgVenvs), 'XDG path should also be included');
    });

    test('Does not include duplicate paths', () => {
        // This test only makes sense on non-Windows platforms where
        // XDG_DATA_HOME/virtualenvs might match the default path
        if (process.platform === 'win32') {
            return;
        }

        // Create a unique path that will be used for both XDG and checked for duplicates
        const venvBase = path.join(tempDir, 'unique_venvs');
        const virtualenvsPath = path.join(venvBase, 'virtualenvs');
        fs.mkdirSync(venvBase);
        fs.mkdirSync(virtualenvsPath);

        // Set XDG_DATA_HOME to the same base
        process.env.XDG_DATA_HOME = venvBase;

        const dirs = getPipenvVirtualenvDirs();

        // Count occurrences of the path
        const count = dirs.filter((d) => d === virtualenvsPath).length;
        assert.strictEqual(count, 1, 'Path should not be duplicated');
    });

    test('Returns multiple directories when all exist', () => {
        const workonPath = path.join(tempDir, 'workon_multi');
        const xdgBase = path.join(tempDir, 'xdg_multi');
        const xdgPath = path.join(xdgBase, 'virtualenvs');

        fs.mkdirSync(workonPath);
        fs.mkdirSync(xdgBase);
        fs.mkdirSync(xdgPath);

        process.env.WORKON_HOME = workonPath;
        process.env.XDG_DATA_HOME = xdgBase;

        const dirs = getPipenvVirtualenvDirs();

        assert.ok(dirs.length >= 2, 'Should return at least two directories');
        assert.strictEqual(dirs[0], workonPath, 'WORKON_HOME should be first');
        assert.ok(dirs.includes(xdgPath), 'XDG path should be included');
    });

    test('Handles tilde expansion in WORKON_HOME', () => {
        // Create the target directory in user's home
        const customVenvsName = `.pipenv-test-tilde-${Date.now()}`;
        const expandedPath = path.join(os.homedir(), customVenvsName);
        let created = false;

        try {
            fs.mkdirSync(expandedPath);
            created = true;
            // Use path.sep for cross-platform compatibility
            process.env.WORKON_HOME = `~${path.sep}${customVenvsName}`;

            const dirs = getPipenvVirtualenvDirs();

            // Normalize paths for comparison since untildify might produce different path formats
            const normalizedDirs = dirs.map((d) => path.normalize(d));
            const normalizedExpected = path.normalize(expandedPath);
            assert.ok(normalizedDirs.includes(normalizedExpected), 'Tilde-expanded path should be included');
        } finally {
            // Clean up - only if directory was successfully created
            if (created && fs.existsSync(expandedPath)) {
                fs.rmSync(expandedPath, { recursive: true, force: true });
            }
        }
    });
});
