// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import {
    CacheEntrySummary,
    INLINE_SCRIPT_CACHE_DIR_NAME,
    InlineScriptEnvMeta,
    META_JSON_FILENAME,
    META_SCHEMA_VERSION,
    getMetaJsonPath,
    getScriptEnvCacheRoot,
    getScriptEnvDir,
    readMetaJson,
    selectStaleEntries,
    verifyEnvUsable,
    writeMetaJson,
} from '../../common/inlineScriptCacheLayout';
import * as logging from '../../common/logging';
import * as platformUtils from '../../common/utils/platformUtils';

function makeMeta(overrides: Partial<InlineScriptEnvMeta> = {}): InlineScriptEnvMeta {
    return {
        schemaVersion: META_SCHEMA_VERSION,
        scriptFsPath: '/tmp/script.py',
        lastUsedAt: '2026-06-18T22:45:12.000Z',
        requiresPython: '>=3.11',
        ...overrides,
    };
}

suite('inlineScriptCacheLayout', () => {
    let traceWarnStub: sinon.SinonStub;

    setup(() => {
        traceWarnStub = sinon.stub(logging, 'traceWarn');
    });

    teardown(() => {
        sinon.restore();
    });

    suite('path helpers', () => {
        test('getScriptEnvCacheRoot appends the versioned bucket name', () => {
            const globalStorage = Uri.file(path.join('/tmp', 'extension-storage'));
            const root = getScriptEnvCacheRoot(globalStorage);
            assert.strictEqual(path.basename(root.fsPath), INLINE_SCRIPT_CACHE_DIR_NAME);
            assert.strictEqual(path.dirname(root.fsPath), globalStorage.fsPath);
        });

        test('getScriptEnvDir uses the cache key verbatim as the directory name', () => {
            const globalStorage = Uri.file(path.join('/tmp', 'extension-storage'));
            const key = 'abc123def4567890';
            const envDir = getScriptEnvDir(globalStorage, key);
            assert.strictEqual(path.basename(envDir.fsPath), key);
        });

        test('getMetaJsonPath returns .meta.json inside the env dir', () => {
            const envDir = Uri.file(path.join('/tmp', 'cache', 'abc'));
            const metaPath = getMetaJsonPath(envDir);
            assert.strictEqual(path.basename(metaPath.fsPath), META_JSON_FILENAME);
            assert.strictEqual(path.dirname(metaPath.fsPath), envDir.fsPath);
        });
    });

    suite('writeMetaJson + readMetaJson (round-trip on a real tmpdir)', () => {
        let tmpDir: string;
        let envDir: Uri;

        setup(async () => {
            tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'isclayout-test-'));
            envDir = Uri.file(path.join(tmpDir, 'env'));
        });

        teardown(async () => {
            await fs.remove(tmpDir);
        });

        test('writeMetaJson then readMetaJson returns the same object', async () => {
            const meta = makeMeta();
            await writeMetaJson(envDir, meta);
            const read = await readMetaJson(envDir);
            assert.deepStrictEqual(read, meta);
        });

        test('writeMetaJson creates the env directory if it does not exist', async () => {
            const meta = makeMeta();
            assert.strictEqual(await fs.pathExists(envDir.fsPath), false);
            await writeMetaJson(envDir, meta);
            assert.strictEqual(await fs.pathExists(envDir.fsPath), true);
        });

        test('writeMetaJson leaves no .tmp- files behind on success', async () => {
            await writeMetaJson(envDir, makeMeta());
            const entries = await fs.readdir(envDir.fsPath);
            const tmpFiles = entries.filter((name) => name.includes('.tmp-'));
            assert.deepStrictEqual(tmpFiles, []);
        });

        test('writeMetaJson overwrites an existing sidecar (last write wins)', async () => {
            await writeMetaJson(envDir, makeMeta({ lastUsedAt: '2020-01-01T00:00:00.000Z' }));
            await writeMetaJson(envDir, makeMeta({ lastUsedAt: '2030-01-01T00:00:00.000Z' }));
            const read = await readMetaJson(envDir);
            assert.ok(read);
            assert.strictEqual(read.lastUsedAt, '2030-01-01T00:00:00.000Z');
            const entries = await fs.readdir(envDir.fsPath);
            assert.deepStrictEqual(
                entries.filter((name) => name.includes('.tmp-')),
                [],
            );
        });

        test('concurrent writeMetaJson calls leave one valid sidecar, never a missing one', async () => {
            await writeMetaJson(envDir, makeMeta({ lastUsedAt: '2020-01-01T00:00:00.000Z' }));
            const a = makeMeta({ lastUsedAt: '2025-01-01T00:00:00.000Z' });
            const b = makeMeta({ lastUsedAt: '2030-01-01T00:00:00.000Z' });
            await Promise.all([writeMetaJson(envDir, a), writeMetaJson(envDir, b)]);
            const read = await readMetaJson(envDir);
            assert.ok(read, 'sidecar must exist after concurrent writes');
            assert.ok(
                read.lastUsedAt === a.lastUsedAt || read.lastUsedAt === b.lastUsedAt,
                `final write must be one of the concurrent payloads, got ${read.lastUsedAt}`,
            );
            const entries = await fs.readdir(envDir.fsPath);
            assert.deepStrictEqual(
                entries.filter((name) => name.includes('.tmp-')),
                [],
            );
        });

        test('writeMetaJson serializes optional requiresPython as undefined-erased', async () => {
            const meta = makeMeta({ requiresPython: undefined });
            await writeMetaJson(envDir, meta);
            const onDisk = JSON.parse(await fs.readFile(getMetaJsonPath(envDir).fsPath, 'utf8'));
            assert.strictEqual('requiresPython' in onDisk, false);
            const read = await readMetaJson(envDir);
            assert.ok(read);
            assert.strictEqual(read.requiresPython, undefined);
        });

        test('writeMetaJson produces human-readable, indented JSON', async () => {
            await writeMetaJson(envDir, makeMeta());
            const raw = await fs.readFile(getMetaJsonPath(envDir).fsPath, 'utf8');
            assert.ok(raw.includes('\n'), 'expected indented JSON');
        });
    });

    suite('readMetaJson rejection paths', () => {
        let tmpDir: string;
        let envDir: Uri;

        setup(async () => {
            tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'isclayout-test-'));
            envDir = Uri.file(path.join(tmpDir, 'env'));
            await fs.ensureDir(envDir.fsPath);
        });

        teardown(async () => {
            await fs.remove(tmpDir);
        });

        async function writeRaw(content: string): Promise<void> {
            await fs.writeFile(getMetaJsonPath(envDir).fsPath, content, 'utf8');
        }

        test('returns undefined when the sidecar does not exist', async () => {
            await fs.remove(getMetaJsonPath(envDir).fsPath).catch(() => undefined);
            const result = await readMetaJson(envDir);
            assert.strictEqual(result, undefined);
            assert.ok(traceWarnStub.called, 'expected a traceWarn');
        });

        test('returns undefined for malformed JSON', async () => {
            await writeRaw('this is not json');
            const result = await readMetaJson(envDir);
            assert.strictEqual(result, undefined);
            assert.ok(traceWarnStub.called);
        });

        test('returns undefined for an unknown schemaVersion', async () => {
            await writeRaw(JSON.stringify({ ...makeMeta(), schemaVersion: 99 }));
            const result = await readMetaJson(envDir);
            assert.strictEqual(result, undefined);
            assert.ok(traceWarnStub.called);
        });

        test('returns undefined when scriptFsPath is missing', async () => {
            const { scriptFsPath: _omit, ...partial } = makeMeta();
            await writeRaw(JSON.stringify(partial));
            const result = await readMetaJson(envDir);
            assert.strictEqual(result, undefined);
        });

        test('returns undefined when scriptFsPath is an empty string', async () => {
            await writeRaw(JSON.stringify({ ...makeMeta(), scriptFsPath: '' }));
            const result = await readMetaJson(envDir);
            assert.strictEqual(result, undefined);
        });

        test('returns undefined when lastUsedAt is not parseable', async () => {
            await writeRaw(JSON.stringify({ ...makeMeta(), lastUsedAt: 'not-a-date' }));
            const result = await readMetaJson(envDir);
            assert.strictEqual(result, undefined);
        });

        test('returns undefined when requiresPython is present but not a string', async () => {
            await writeRaw(JSON.stringify({ ...makeMeta(), requiresPython: 311 }));
            const result = await readMetaJson(envDir);
            assert.strictEqual(result, undefined);
        });

        test('accepts a meta with requiresPython explicitly omitted', async () => {
            const { requiresPython: _omit, ...partial } = makeMeta();
            await writeRaw(JSON.stringify(partial));
            const result = await readMetaJson(envDir);
            assert.ok(result);
            assert.strictEqual(result.requiresPython, undefined);
        });

        test('returns undefined for a top-level non-object payload', async () => {
            await writeRaw(JSON.stringify(['array', 'instead']));
            assert.strictEqual(await readMetaJson(envDir), undefined);
            await writeRaw(JSON.stringify('a bare string'));
            assert.strictEqual(await readMetaJson(envDir), undefined);
            await writeRaw('null');
            assert.strictEqual(await readMetaJson(envDir), undefined);
        });

        test('an unknown field with a null value is tolerated (extras are dropped on read)', async () => {
            await writeRaw(JSON.stringify({ ...makeMeta(), dependencies: null }));
            // `dependencies` is no longer a schema field; per the v1
            // evolution policy, extras (whatever their value) are
            // tolerated and dropped on read. Pin that null doesn't
            // break the validator.
            assert.ok(await readMetaJson(envDir));
        });

        test('returns undefined when requiresPython is explicitly null', async () => {
            await writeRaw(JSON.stringify({ ...makeMeta(), requiresPython: null }));
            assert.strictEqual(await readMetaJson(envDir), undefined);
        });

        test('returns undefined for a non-canonical ISO timestamp (e.g. "2026")', async () => {
            await writeRaw(JSON.stringify({ ...makeMeta(), lastUsedAt: '2026' }));
            assert.strictEqual(await readMetaJson(envDir), undefined);
            await writeRaw(JSON.stringify({ ...makeMeta(), lastUsedAt: '06/18/2026' }));
            assert.strictEqual(await readMetaJson(envDir), undefined);
            await writeRaw(JSON.stringify({ ...makeMeta(), lastUsedAt: 'June 18 2026' }));
            assert.strictEqual(await readMetaJson(envDir), undefined);
        });

        test('extra unknown fields in a v1 sidecar are tolerated but dropped from the result', async () => {
            await writeRaw(JSON.stringify({ ...makeMeta(), undocumented: 'x', _internal: 42 }));
            const result = await readMetaJson(envDir);
            assert.ok(result);
            assert.strictEqual('undocumented' in result, false);
            assert.strictEqual('_internal' in result, false);
        });

        test('returns undefined when the sidecar path is a directory rather than a file', async () => {
            await fs.remove(getMetaJsonPath(envDir).fsPath).catch(() => undefined);
            await fs.ensureDir(getMetaJsonPath(envDir).fsPath);
            assert.strictEqual(await readMetaJson(envDir), undefined);
            assert.ok(traceWarnStub.called);
        });

        test('returns undefined when the sidecar exceeds the size cap (1 MiB)', async () => {
            const big = Buffer.alloc(1024 * 1024 + 1, 0x20);
            await fs.writeFile(getMetaJsonPath(envDir).fsPath, big);
            assert.strictEqual(await readMetaJson(envDir), undefined);
            assert.ok(
                traceWarnStub.getCalls().some((c) => String(c.args[0]).includes('bytes > cap')),
                'expected the size-cap warn message',
            );
        });

        test('ENOENT and other stat errors are reported with distinguishable messages', async () => {
            await fs.remove(getMetaJsonPath(envDir).fsPath).catch(() => undefined);
            assert.strictEqual(await readMetaJson(envDir), undefined);
            const args = traceWarnStub.getCalls().map((c) => String(c.args[0]));
            assert.ok(
                args.some((a) => a.includes('not found')),
                `expected an ENOENT-specific warn; saw: ${JSON.stringify(args)}`,
            );
        });
    });

    suite('selectStaleEntries', () => {
        const TTL_MS = 14 * 24 * 60 * 60 * 1000;
        const now = new Date('2026-06-22T12:00:00.000Z');

        function entry(name: string, lastUsedAt: Date | undefined): CacheEntrySummary {
            return { envDirPath: `/cache/${name}`, lastUsedAt };
        }

        test('entries older than the TTL are returned', () => {
            const old = new Date(now.getTime() - TTL_MS - 1);
            const stale = selectStaleEntries([entry('a', old)], now, TTL_MS);
            assert.deepStrictEqual(stale, ['/cache/a']);
        });

        test('entries newer than the TTL are excluded', () => {
            const recent = new Date(now.getTime() - 1000);
            const stale = selectStaleEntries([entry('a', recent)], now, TTL_MS);
            assert.deepStrictEqual(stale, []);
        });

        test('entries with age exactly equal to the TTL are NOT stale (strict cutoff)', () => {
            const exact = new Date(now.getTime() - TTL_MS);
            const stale = selectStaleEntries([entry('a', exact)], now, TTL_MS);
            assert.deepStrictEqual(stale, []);
        });

        test('entries with undefined lastUsedAt are skipped (never TTLed)', () => {
            const stale = selectStaleEntries(
                [entry('a', undefined), entry('b', new Date(now.getTime() - TTL_MS - 1))],
                now,
                TTL_MS,
            );
            assert.deepStrictEqual(stale, ['/cache/b']);
        });

        test('returns paths in input order (callers may sort if they care)', () => {
            const old1 = new Date(now.getTime() - TTL_MS - 1000);
            const old2 = new Date(now.getTime() - TTL_MS - 2000);
            const stale = selectStaleEntries([entry('a', old1), entry('b', old2)], now, TTL_MS);
            assert.deepStrictEqual(stale, ['/cache/a', '/cache/b']);
        });

        test('empty input returns empty output without throwing', () => {
            assert.deepStrictEqual(selectStaleEntries([], now, TTL_MS), []);
        });

        test('TTL of zero treats every dated entry as stale (immediate eviction)', () => {
            const stale = selectStaleEntries([entry('a', new Date(now.getTime() - 1)), entry('b', undefined)], now, 0);
            assert.deepStrictEqual(stale, ['/cache/a']);
        });

        test('entries with timestamps in the future are not stale (age is negative)', () => {
            const future = new Date(now.getTime() + TTL_MS);
            const stale = selectStaleEntries([entry('a', future)], now, TTL_MS);
            assert.deepStrictEqual(stale, []);
        });
    });

    suite('verifyEnvUsable', () => {
        let tmpDir: string;
        let envDir: Uri;

        setup(async () => {
            tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'isclayout-verify-'));
            envDir = Uri.file(path.join(tmpDir, 'env'));
            await fs.ensureDir(envDir.fsPath);
        });

        teardown(async () => {
            await fs.remove(tmpDir);
        });

        suite('POSIX branch (isWindows stubbed to false)', () => {
            setup(() => {
                sinon.stub(platformUtils, 'isWindows').returns(false);
            });

            test('returns true when bin/python exists as a regular file', async () => {
                const binDir = path.join(envDir.fsPath, 'bin');
                await fs.ensureDir(binDir);
                await fs.writeFile(path.join(binDir, 'python'), '');
                assert.strictEqual(await verifyEnvUsable(envDir), true);
                assert.strictEqual(traceWarnStub.called, false, 'no warn on success');
            });

            const symlinkSuite = process.platform === 'win32' ? suite.skip : suite;
            symlinkSuite('symlinks (POSIX host only)', () => {
                test('returns true for a symlink to an existing file (dead-symlink discriminator)', async () => {
                    const binDir = path.join(envDir.fsPath, 'bin');
                    await fs.ensureDir(binDir);
                    const target = path.join(tmpDir, 'real-python');
                    await fs.writeFile(target, '');
                    await fs.symlink(target, path.join(binDir, 'python'));
                    assert.strictEqual(await verifyEnvUsable(envDir), true);
                });

                test('returns false for a symlink whose target was removed (base uninstalled)', async () => {
                    const binDir = path.join(envDir.fsPath, 'bin');
                    await fs.ensureDir(binDir);
                    const target = path.join(tmpDir, 'real-python');
                    await fs.writeFile(target, '');
                    await fs.symlink(target, path.join(binDir, 'python'));
                    await fs.remove(target);
                    assert.strictEqual(await verifyEnvUsable(envDir), false);
                    assert.ok(
                        traceWarnStub.getCalls().some((c) => String(c.args[0]).includes('missing')),
                        'expected a missing-launcher warn',
                    );
                });
            });

            test('returns false when bin/python does not exist', async () => {
                assert.strictEqual(await verifyEnvUsable(envDir), false);
                assert.ok(
                    traceWarnStub.getCalls().some((c) => String(c.args[0]).includes('missing')),
                    'expected an ENOENT-shaped warn',
                );
            });

            test('returns false when bin/python is a directory', async () => {
                const launcher = path.join(envDir.fsPath, 'bin', 'python');
                await fs.ensureDir(launcher);
                assert.strictEqual(await verifyEnvUsable(envDir), false);
                assert.ok(
                    traceWarnStub.getCalls().some((c) => String(c.args[0]).includes('not a regular file')),
                );
            });
        });

        suite('Windows branch (isWindows stubbed to true)', () => {
            setup(() => {
                sinon.stub(platformUtils, 'isWindows').returns(true);
            });

            async function writePyvenvCfg(content: string): Promise<void> {
                await fs.writeFile(path.join(envDir.fsPath, 'pyvenv.cfg'), content, 'utf8');
            }

            test('returns true when pyvenv.cfg.home points to an existing python.exe', async () => {
                const homeDir = path.join(tmpDir, 'Python313');
                await fs.ensureDir(homeDir);
                await fs.writeFile(path.join(homeDir, 'python.exe'), '');
                await writePyvenvCfg(`home = ${homeDir}\ninclude-system-site-packages = false\nversion = 3.13.0\n`);
                assert.strictEqual(await verifyEnvUsable(envDir), true);
                assert.strictEqual(traceWarnStub.called, false, 'no warn on success');
            });

            test('returns false when pyvenv.cfg.home points to a removed python.exe', async () => {
                const homeDir = path.join(tmpDir, 'Python313');
                await fs.ensureDir(homeDir);
                await writePyvenvCfg(`home = ${homeDir}\n`);
                assert.strictEqual(await verifyEnvUsable(envDir), false);
                assert.ok(
                    traceWarnStub.getCalls().some((c) => String(c.args[0]).includes('missing')),
                    'expected a missing-launcher warn',
                );
            });

            test('returns false when pyvenv.cfg is missing entirely', async () => {
                assert.strictEqual(await verifyEnvUsable(envDir), false);
                assert.ok(
                    traceWarnStub
                        .getCalls()
                        .some((c) => String(c.args[0]).includes('missing pyvenv.cfg')),
                    'expected a missing-pyvenv.cfg warn',
                );
            });

            test('returns false when pyvenv.cfg has no `home =` line', async () => {
                await writePyvenvCfg('include-system-site-packages = false\nversion = 3.13.0\n');
                assert.strictEqual(await verifyEnvUsable(envDir), false);
                assert.ok(
                    traceWarnStub.getCalls().some((c) => String(c.args[0]).includes("no 'home =' line")),
                );
            });

            test('returns false when pyvenv.cfg has an empty home value', async () => {
                await writePyvenvCfg('home =\n');
                assert.strictEqual(await verifyEnvUsable(envDir), false);
                assert.ok(
                    traceWarnStub.getCalls().some((c) => String(c.args[0]).includes("no 'home =' line")),
                );
            });

            test('tolerates extra whitespace around the home = key/value', async () => {
                const homeDir = path.join(tmpDir, 'Python313');
                await fs.ensureDir(homeDir);
                await fs.writeFile(path.join(homeDir, 'python.exe'), '');
                await writePyvenvCfg(`  home   =   ${homeDir}   \n`);
                assert.strictEqual(await verifyEnvUsable(envDir), true);
            });

            test('tolerates CRLF line endings', async () => {
                const homeDir = path.join(tmpDir, 'Python313');
                await fs.ensureDir(homeDir);
                await fs.writeFile(path.join(homeDir, 'python.exe'), '');
                await writePyvenvCfg(`home = ${homeDir}\r\nversion = 3.13.0\r\n`);
                assert.strictEqual(await verifyEnvUsable(envDir), true);
            });
        });
    });
});
