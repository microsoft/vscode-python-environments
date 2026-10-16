// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import { CancellationTokenSource, Uri } from 'vscode';
import * as processRunner from '../../../common/installerProcess';
import { InstallerProcessError, InstallerProcessResult } from '../../../common/installerProcess';
import * as logging from '../../../common/logging';
import * as platformUtils from '../../../common/utils/platformUtils';
import * as installer from '../../../managers/builtin/pymanagerPythonInstaller';

function nativeRuntime(): Record<string, unknown> {
    return {
        id: 'pythoncore-3.14-64',
        company: 'PythonCore',
        'sort-version': '3.14.7',
        tag: '3.14-64',
        'install-for': ['3.14-64', '3.14'],
        executable: 'python.exe',
    };
}

function output(...versions: Record<string, unknown>[]): string {
    return JSON.stringify({ versions });
}

suite('pymanagerPythonInstaller JSON', () => {
    test('accepts zero versions and unknown properties', () => {
        assert.deepStrictEqual(installer.parsePymanagerRuntimes('{"versions":[],"extra":true}'), []);
        const result = installer.parsePymanagerRuntimes(output({ ...nativeRuntime(), future: { field: 3 } }));
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].version, '3.14.7');
    });

    test('uses sort-version and preserves all relevant fields without resolving relative executables', () => {
        const native = {
            ...nativeRuntime(),
            version: 'not-the-runtime-version',
            executable_args: ['-X', 'utf8'],
            unmanaged: false,
        };
        assert.deepStrictEqual(installer.parsePymanagerRuntimes(output(native)), [
            {
                id: 'pythoncore-3.14-64',
                company: 'PythonCore',
                version: '3.14.7',
                tag: '3.14-64',
                installTags: ['3.14-64', '3.14'],
                executable: 'python.exe',
                executableArgs: ['-X', 'utf8'],
                prefix: undefined,
                unmanaged: false,
            },
        ]);
    });

    test('preserves installed executable and prefix paths', () => {
        const prefix = Uri.file(path.join(process.cwd(), 'runtime fixtures', 'Python 3.14')).fsPath;
        const executable = Uri.file(path.join(prefix, 'python.exe')).fsPath;
        const [runtime] = installer.parsePymanagerRuntimes(
            output({ ...nativeRuntime(), executable, prefix, unmanaged: true }),
        );
        assert.strictEqual(Uri.file(runtime.executable).fsPath, executable);
        assert.strictEqual(runtime.prefix, prefix);
        assert.strictEqual(runtime.unmanaged, true);
    });

    test('defaults omitted install-for, executable_args and unmanaged metadata', () => {
        const native = nativeRuntime();
        delete native['install-for'];
        const [runtime] = installer.parsePymanagerRuntimes(output(native));
        assert.deepStrictEqual(runtime.installTags, []);
        assert.deepStrictEqual(runtime.executableArgs, []);
        assert.strictEqual(runtime.unmanaged, false);
        assert.strictEqual(runtime.prefix, undefined);
    });

    test('does not infer architectures, constrain versions, sort, or discard runtime families', () => {
        const runtimes = [
            { ...nativeRuntime(), id: 'free-threaded', tag: '3.14t-arm64', 'sort-version': '3.14.7' },
            { ...nativeRuntime(), id: 'prerelease', tag: '3.14.0rc3-64', 'sort-version': '3.14.0rc3' },
            { ...nativeRuntime(), id: 'another-company', company: 'Other', tag: 'custom' },
        ];
        const result = installer.parsePymanagerRuntimes(output(...runtimes));
        assert.deepStrictEqual(result.map((runtime) => runtime.id), runtimes.map((runtime) => runtime.id));
        assert.strictEqual(result[1].version, '3.14.0rc3');
    });

    test('does not include malformed JSON contents in errors', () => {
        assert.throws(
            () => installer.parsePymanagerRuntimes('{"versions":sensitive-data}'),
            (error: unknown) => error instanceof Error && !error.message.includes('sensitive-data'),
        );
    });

    for (const invalid of ['', '[]', 'null', '1', '{}', '{"versions":null}', '{"versions":{}}', '{"versions":[null]}']) {
        test(`rejects invalid native envelope ${JSON.stringify(invalid)}`, () => {
            assert.throws(() => installer.parsePymanagerRuntimes(invalid), Error);
        });
    }

    for (const field of ['id', 'company', 'sort-version', 'tag', 'executable']) {
        test(`validates required ${field} without echoing its value`, () => {
            for (const invalid of [undefined, null, 3, true, [], {}, '', '   ']) {
                assert.throws(
                    () => installer.parsePymanagerRuntimes(output({ ...nativeRuntime(), [field]: invalid })),
                    (error: unknown) => error instanceof Error && error.message.includes(field),
                );
            }
        });
    }

    for (const field of ['install-for', 'executable_args']) {
        test(`validates optional ${field} as a string array`, () => {
            for (const invalid of [null, 'string', 3, {}, [3], ['good', false]]) {
                assert.throws(
                    () => installer.parsePymanagerRuntimes(output({ ...nativeRuntime(), [field]: invalid })),
                    (error: unknown) => error instanceof Error && error.message.includes(field),
                );
            }
        });
    }

    test('validates optional prefix and unmanaged types', () => {
        for (const prefix of [null, 3, false, [], {}]) {
            assert.throws(() => installer.parsePymanagerRuntimes(output({ ...nativeRuntime(), prefix })), /prefix/);
        }
        for (const unmanaged of [null, 3, 'false', [], {}]) {
            assert.throws(
                () => installer.parsePymanagerRuntimes(output({ ...nativeRuntime(), unmanaged })),
                /unmanaged/,
            );
        }
    });
});

suite('pymanagerPythonInstaller listing', () => {
    const executable = path.join(process.cwd(), 'installer fixtures', 'pymanager.exe');
    let run: sinon.SinonStub;

    setup(() => {
        run = sinon.stub(processRunner, 'runInstallerProcess').resolves({ stdout: output(), stderr: '' });
    });

    teardown(() => sinon.restore());

    test('lists installed runtimes with exact argv and a finite local timeout', async () => {
        assert.deepStrictEqual(await installer.listPymanagerRuntimes(executable), []);
        sinon.assert.calledOnceWithExactly(
            run,
            executable,
            ['list', '--format=json', '-q'],
            { timeoutMs: 10000 },
        );
    });

    test('lists the online catalogue with a longer bounded timeout, retaining all selectors and families', async () => {
        const selectors = Object.freeze(['PythonCore\\3.14.6-64', 'PythonCore\\3.14.0rc-64']);
        run.resolves({
            stdout: output(nativeRuntime(), { ...nativeRuntime(), id: 'another-family', tag: '3.14t-arm64' }),
            stderr: 'not JSON',
        });
        const result = await installer.listPymanagerRuntimes(
            executable,
            { online: true, onlyManaged: true, selectors },
        );
        assert.strictEqual(result.length, 2);
        sinon.assert.calledOnceWithExactly(
            run,
            executable,
            ['list', '--online', '--only-managed', '--format=json', '-q', ...selectors],
            { timeoutMs: 60000 },
        );
        assert.strictEqual(run.firstCall.args[1].includes('--one'), false);
    });

    test('does not add online/managed switches when explicitly false', async () => {
        await installer.listPymanagerRuntimes(executable, {
            online: false,
            onlyManaged: false,
            selectors: ['<3.15'],
        });
        assert.deepStrictEqual(run.firstCall.args[1], ['list', '--format=json', '-q', '<3.15']);
    });

    test('forwards inventory cancellation to the native process runner', async () => {
        const source = new CancellationTokenSource();
        try {
            await installer.listPymanagerRuntimes(executable, {
                onlyManaged: true,
                cancellationToken: source.token,
            });

            sinon.assert.calledOnceWithExactly(
                run,
                executable,
                ['list', '--only-managed', '--format=json', '-q'],
                { timeoutMs: 10000, cancellationToken: source.token },
            );
        } finally {
            source.dispose();
        }
    });

    test('propagates native failures rather than converting them to an empty list', async () => {
        const error = new InstallerProcessError('exit', 5);
        run.rejects(error);
        await assert.rejects(installer.listPymanagerRuntimes(executable), (caught: unknown) => caught === error);
    });

    test('propagates malformed native JSON despite a successful process exit', async () => {
        run.resolves({ stdout: '[]', stderr: '' });
        await assert.rejects(installer.listPymanagerRuntimes(executable), /versions/);
    });
});

suite('pymanagerPythonInstaller detection', () => {
    const fixtureRoot = path.join(process.cwd(), 'pymanager detection fixtures');
    const pathDirectory = path.join(fixtureRoot, 'PATH directory');
    const primary = path.join(pathDirectory, 'pymanager.exe');
    const localAppData = path.join(fixtureRoot, 'Local App Data');
    const programFiles = path.join(fixtureRoot, 'Program Files');
    const families = [
        'PythonSoftwareFoundation.PythonManager_3847v3x7pw1km',
        'PythonSoftwareFoundation.PythonManager_qbz5n2kfra8p0',
    ];
    const alternatives = [
        ...families.map((family) => path.join(localAppData, 'Microsoft', 'WindowsApps', family, 'pymanager.exe')),
        path.join(programFiles, 'PyManager', 'pymanager.exe'),
    ];
    const modulePath = require.resolve('../../../managers/builtin/pymanagerPythonInstaller');
    const whichPath = require.resolve('which');
    let subject: typeof installer;
    let cachedInstaller: NodeJS.Module | undefined;
    let stat: sinon.SinonStub;
    let resolveExecutable: sinon.SinonStub;
    let run: sinon.SinonStub;
    let clock: sinon.SinonFakeTimers;

    setup(() => {
        sinon.stub(platformUtils, 'isWindows').returns(true);
        sinon.stub(process, 'env').value({ PATH: pathDirectory });
        sinon.stub(logging, 'traceVerbose');
        stat = sinon.stub(fs, 'lstat').rejects(Object.assign(new Error('not found'), { code: 'ENOENT' }));
        resolveExecutable = sinon.stub().callsFake(async (candidate: string) => candidate);
        run = sinon.stub(processRunner, 'runInstallerProcess').resolves({ stdout: output(), stderr: '' });
        clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

        // which exports a callable CommonJS module, not a stubbable named API.
        // Reload only this subject against that stub, preserving other suites' module instances.
        const cachedWhich = require.cache[whichPath];
        assert.ok(cachedWhich);
        sinon.stub(cachedWhich, 'exports').value(resolveExecutable);
        cachedInstaller = require.cache[modulePath];
        delete require.cache[modulePath];
        subject = require(modulePath);
    });

    teardown(() => {
        if (cachedInstaller) {
            require.cache[modulePath] = cachedInstaller;
        } else {
            delete require.cache[modulePath];
        }
        sinon.restore();
    });

    function known(candidate: string): void {
        stat.withArgs(candidate).resolves({ isFile: () => true, isSymbolicLink: () => false });
    }

    function enableAlternatives(): void {
        process.env.LOCALAPPDATA = localAppData;
        process.env.ProgramFiles = programFiles;
    }

    test('does not inspect files or run commands outside Windows', async () => {
        (platformUtils.isWindows as sinon.SinonStub).returns(false);
        assert.deepStrictEqual(await subject.detectPymanager(), { kind: 'absent' });
        sinon.assert.notCalled(stat);
        sinon.assert.notCalled(resolveExecutable);
        sinon.assert.notCalled(run);
    });

    test('reports absent when all candidate files are missing', async () => {
        enableAlternatives();
        assert.deepStrictEqual(await subject.detectPymanager(), { kind: 'absent' });
        assert.deepStrictEqual(stat.args, [primary, ...alternatives].map((candidate) => [candidate]));
        sinon.assert.notCalled(resolveExecutable);
        sinon.assert.notCalled(run);
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('accepts an installed manager with zero runtimes using the exact bounded native probe', async () => {
        known(primary);
        assert.deepStrictEqual(await subject.detectPymanager(), { kind: 'available', executable: primary });
        sinon.assert.calledOnceWithExactly(resolveExecutable, primary, { nothrow: true, pathExt: '.EXE' });
        sinon.assert.calledOnceWithExactly(
            run,
            primary,
            ['list', '--only-managed', '--one', '--format=json', '-q'],
            { timeoutMs: 3000 },
        );
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('probes an App Execution Alias without following its inaccessible target', async () => {
        stat.withArgs(primary).resolves({ isFile: () => false, isSymbolicLink: () => true });
        resolveExecutable.rejects(Object.assign(new Error('alias target cannot be opened'), { code: 'EACCES' }));

        assert.deepStrictEqual(await subject.detectPymanager(), { kind: 'available', executable: primary });

        sinon.assert.notCalled(resolveExecutable);
        assert.strictEqual(run.firstCall.args[0], primary);
    });

    for (const candidate of alternatives) {
        test(`supports the documented alternative ${path.relative(fixtureRoot, candidate)}`, async () => {
            enableAlternatives();
            known(candidate);
            assert.deepStrictEqual(await subject.detectPymanager(), { kind: 'available', executable: candidate });
            assert.strictEqual(run.firstCall.args[0], candidate);
        });
    }

    test('tries a second candidate after a known manager fails', async () => {
        enableAlternatives();
        known(primary);
        known(alternatives[0]);
        run.onFirstCall().rejects(new InstallerProcessError('exit', 1));
        assert.deepStrictEqual(await subject.detectPymanager(), {
            kind: 'available',
            executable: alternatives[0],
        });
        assert.strictEqual(run.callCount, 2);
    });

    test('reports known but unusable and preserves the native failure', async () => {
        known(primary);
        const error = new InstallerProcessError('timeout', undefined, true);
        run.rejects(error);
        assert.deepStrictEqual(await subject.detectPymanager(), { kind: 'unusable', executable: primary, error });
    });

    test('does not classify invalid JSON as absent', async () => {
        known(primary);
        run.resolves({ stdout: '[]', stderr: '' });
        const result = await subject.detectPymanager();
        assert.strictEqual(result.kind, 'unusable');
        if (result.kind === 'unusable') {
            assert.match(result.error.message, /versions/);
        }
    });

    test('does not classify denied filesystem access as absent', async () => {
        const error = Object.assign(new Error('access denied'), { code: 'EACCES' });
        stat.withArgs(primary).rejects(error);
        assert.deepStrictEqual(await subject.detectPymanager(), { kind: 'unusable', executable: primary, error });
        sinon.assert.notCalled(run);
    });

    test('tries an alternative after denied access to a PATH candidate', async () => {
        enableAlternatives();
        stat.withArgs(primary).rejects(Object.assign(new Error('access denied'), { code: 'EACCES' }));
        known(alternatives[1]);
        assert.deepStrictEqual(await subject.detectPymanager(), {
            kind: 'available',
            executable: alternatives[1],
        });
    });

    test('treats a known but unresolvable executable as unusable', async () => {
        known(primary);
        resolveExecutable.resolves(null);
        assert.strictEqual((await subject.detectPymanager()).kind, 'unusable');
        sinon.assert.notCalled(run);
    });

    test('does not launch a different filename returned by which', async () => {
        known(primary);
        resolveExecutable.resolves(path.join(pathDirectory, 'pymanager.exe.cmd'));
        assert.strictEqual((await subject.detectPymanager()).kind, 'unusable');
        sinon.assert.notCalled(run);
    });

    test('rejects a directory named pymanager.exe as unusable', async () => {
        stat.withArgs(primary).resolves({ isFile: () => false, isSymbolicLink: () => false });
        assert.strictEqual((await subject.detectPymanager()).kind, 'unusable');
        sinon.assert.notCalled(run);
    });

    test('skips empty, relative and current-directory PATH entries, accepting quoted absolute entries', async () => {
        process.env.PATH = ['', '.', 'relative', process.cwd(), `"${pathDirectory}"`].join(path.delimiter);
        known(primary);
        assert.strictEqual((await subject.detectPymanager()).kind, 'available');
        sinon.assert.calledOnceWithExactly(stat, primary);
        sinon.assert.calledOnceWithExactly(resolveExecutable, primary, { nothrow: true, pathExt: '.EXE' });
    });

    test('skips relative or absent alternative roots rather than probing the current directory', async () => {
        process.env.PATH = '';
        process.env.LOCALAPPDATA = 'relative';
        process.env.ProgramFiles = '';
        assert.deepStrictEqual(await subject.detectPymanager(), { kind: 'absent' });
        sinon.assert.notCalled(stat);
        sinon.assert.notCalled(run);
    });

    test('deduplicates resolved paths case-insensitively without changing the reported path', async () => {
        const first = path.join(pathDirectory.toUpperCase(), 'pymanager.exe');
        process.env.PATH = [pathDirectory.toUpperCase(), path.join(pathDirectory, '.'), pathDirectory].join(path.delimiter);
        known(first);
        run.rejects(new InstallerProcessError('exit', 1));
        const result = await subject.detectPymanager();
        assert.strictEqual(result.kind, 'unusable');
        assert.strictEqual(Uri.file(result.executable).fsPath, Uri.file(first).fsPath);
        sinon.assert.calledOnceWithExactly(stat, first);
        sinon.assert.calledOnce(run);
    });

    test('deduplicates documented alternatives that also appear in PATH', async () => {
        enableAlternatives();
        process.env.PATH = path.dirname(alternatives[0]);
        known(alternatives[0]);
        run.rejects(new InstallerProcessError('exit', 1));
        await subject.detectPymanager();
        assert.strictEqual(stat.withArgs(alternatives[0]).callCount, 1);
        sinon.assert.calledOnce(run);
    });

    test('coalesces concurrent probes while allowing later retries', async () => {
        known(primary);
        let complete: (result: InstallerProcessResult) => void = () => assert.fail('Probe was not initialized');
        run.onFirstCall().returns(
            new Promise<InstallerProcessResult>((resolve) => {
                complete = resolve;
            }),
        );
        const first = subject.detectPymanager();
        const second = subject.detectPymanager();
        await clock.tickAsync(0);
        sinon.assert.calledOnce(run);
        complete({ stdout: output(), stderr: '' });
        const results = await Promise.all([first, second]);
        assert.deepStrictEqual(results, [
            { kind: 'available', executable: primary },
            { kind: 'available', executable: primary },
        ]);
        await subject.detectPymanager();
        assert.strictEqual(run.callCount, 2);
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('does not cache absence after a later explicit attempt', async () => {
        assert.deepStrictEqual(await subject.detectPymanager(), { kind: 'absent' });
        known(primary);
        assert.deepStrictEqual(await subject.detectPymanager(), { kind: 'available', executable: primary });
        sinon.assert.calledOnce(run);
    });

    test('retries a previously unusable manager on a later explicit attempt', async () => {
        known(primary);
        run.onFirstCall().rejects(new InstallerProcessError('exit', 1));
        assert.strictEqual((await subject.detectPymanager()).kind, 'unusable');
        assert.deepStrictEqual(await subject.detectPymanager(), { kind: 'available', executable: primary });
        assert.strictEqual(run.callCount, 2);
    });

    test('bounds stalled filesystem lookup, reports uncertainty instead of absence and releases its timer', async () => {
        stat.withArgs(primary).returns(new Promise(() => undefined));
        const pending = subject.detectPymanager();
        await clock.tickAsync(1000);
        const result = await pending;
        assert.strictEqual(result.kind, 'unusable');
        if (result.kind === 'unusable') {
            assert.ok(result.error instanceof InstallerProcessError);
            assert.strictEqual(result.error.kind, 'timeout');
            assert.strictEqual(result.error.processMayStillBeRunning, false);
        }
        sinon.assert.notCalled(run);
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('bounds total detection time across repeatedly failing candidates', async () => {
        process.env.PATH = Array.from({ length: 20 }, (_value, index) => path.join(fixtureRoot, `candidate-${index}`)).join(
            path.delimiter,
        );
        stat.resolves({ isFile: () => true, isSymbolicLink: () => false });
        run.callsFake(
            async () =>
                new Promise<InstallerProcessResult>((_resolve, reject) => {
                    setTimeout(() => reject(new InstallerProcessError('timeout', undefined, true)), 3000);
                }),
        );
        const pending = subject.detectPymanager();
        await clock.tickAsync(15000);
        assert.strictEqual((await pending).kind, 'unusable');
        assert.strictEqual(run.callCount, 5);
        assert.strictEqual(clock.countTimers(), 0);
    });
});
