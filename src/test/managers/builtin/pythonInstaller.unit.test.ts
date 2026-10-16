// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import {
    CancellationError,
    CancellationToken,
    CancellationTokenSource,
    LogOutputChannel,
    Progress,
    ProgressOptions,
    Uri,
} from 'vscode';
import * as processes from '../../../common/installerProcess';
import { InstallerProcessError, InstallerProcessOptions } from '../../../common/installerProcess';
import { Common, PythonInstallStrings } from '../../../common/localize';
import * as logging from '../../../common/logging';
import * as persistentState from '../../../common/persistentState';
import { PythonVersion } from '../../../common/pythonVersion';
import * as telemetry from '../../../common/telemetry/sender';
import { createDeferred, Deferred } from '../../../common/utils/deferred';
import * as platform from '../../../common/utils/platformUtils';
import * as windowApis from '../../../common/window.apis';
import * as pymanager from '../../../managers/builtin/pymanagerPythonInstaller';
import { PymanagerListOptions, PymanagerRuntime } from '../../../managers/builtin/pymanagerPythonInstaller';
import {
    PythonInstallationError,
    PythonInstallFailure,
    PythonInstallResult,
} from '../../../managers/builtin/pythonInstallerTypes';
import * as candidates from '../../../managers/builtin/pythonRuntimeCandidates';
import { PymanagerCandidate } from '../../../managers/builtin/pythonRuntimeCandidates';
import * as uv from '../../../managers/builtin/uvPythonInstaller';
import * as watchers from '../../../managers/common/packageWatcher';
import { createMockLogOutputChannel } from '../../mocks/helper';

interface RuntimeFixture {
    readonly runtime: PymanagerRuntime;
    readonly metadataFile: string;
}

function onlineRuntime(version = '3.14.6', overrides: Partial<PymanagerRuntime> = {}): PymanagerRuntime {
    const family = version.split('.').slice(0, 2).join('.');
    return {
        id: `pythoncore-${family}-64`,
        company: 'PythonCore',
        version,
        tag: `${family}-64`,
        installTags: [`${family}-64`, `${version}-64`],
        executable: 'python.exe',
        executableArgs: [],
        unmanaged: false,
        ...overrides,
    };
}

function uvRuntime(version: string, overrides: Partial<uv.UvPythonVersion> = {}): uv.UvPythonVersion {
    const parsed = new PythonVersion(version);
    return {
        key: `cpython-${version}`,
        version,
        version_parts: { major: parsed.major, minor: parsed.minor, patch: parsed.patch },
        path: null,
        url: null,
        os: 'windows',
        variant: 'default',
        implementation: 'cpython',
        arch: 'x86_64',
        ...overrides,
    };
}

suite('pythonInstaller', () => {
    const modulePath = require.resolve('../../../managers/builtin/pythonInstaller');
    let installer: typeof import('../../../managers/builtin/pythonInstaller');
    let previousModule: NodeJS.Module | undefined;
    let sandbox: sinon.SinonSandbox;
    let root: string;
    let managerExecutable: string;
    let fixtureNumber: number;
    let metadataFiles: Map<string, string>;
    let log: LogOutputChannel;
    let progressToken: CancellationTokenSource;
    let tokens: CancellationTokenSource[];
    let gates: Deferred<void>[];
    let releaseChoices: (() => void)[];
    let pending: Promise<unknown>[];
    let nativeInstall: ((args: readonly string[], options?: InstallerProcessOptions) => Promise<void>) | undefined;
    let detect: sinon.SinonStub;
    let list: sinon.SinonStub;
    let run: sinon.SinonStub;
    let resolveCandidate: sinon.SinonStub;
    let information: sinon.SinonStub;
    let errors: sinon.SinonStub;
    let quickPick: sinon.SinonStub;
    let progress: sinon.SinonStub;
    let pauseWatchers: sinon.SinonStub;
    let optOut: sinon.SinonStub;
    let setState: sinon.SinonStub;
    let uvPrompt: sinon.SinonStub;
    let uvInlinePreflight: sinon.SinonStub;
    let uvCatalogue: sinon.SinonStub;
    let uvPicker: sinon.SinonStub;
    let uvInstall: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        root = path.join(process.cwd(), 'out', `python-installer-unit-${process.pid}-${randomUUID()}`);
        managerExecutable = path.join(root, 'pymanager.exe');
        fixtureNumber = 0;
        metadataFiles = new Map();
        log = createMockLogOutputChannel();
        progressToken = new CancellationTokenSource();
        tokens = [progressToken];
        gates = [];
        releaseChoices = [];
        pending = [];
        nativeInstall = undefined;

        sandbox.stub(platform, 'isWindows').returns(true);
        sandbox.stub(process, 'arch').value('x64');
        sandbox.stub(logging, 'traceError');
        sandbox.stub(logging, 'traceWarn');
        sandbox.stub(logging, 'traceInfo');
        sandbox.stub(telemetry, 'sendTelemetryEvent');
        detect = sandbox.stub(pymanager, 'detectPymanager').resolves({
            kind: 'available', executable: managerExecutable,
        });
        list = sandbox.stub(pymanager, 'listPymanagerRuntimes').resolves([]);
        resolveCandidate = sandbox.stub(candidates, 'resolvePymanagerCandidate').resolves(candidate());
        run = sandbox.stub(processes, 'runInstallerProcess');
        run.callsFake(async (command: string, args: readonly string[], options?: InstallerProcessOptions) => {
            if (options?.cancellationToken?.isCancellationRequested) {
                throw new CancellationError();
            }
            if (command === managerExecutable && args[0] === 'install') {
                await nativeInstall?.(args, options);
                return { stdout: '', stderr: '' };
            }
            const metadataFile = metadataFiles.get(command);
            assert.ok(metadataFile, 'Only owned inert fixture executables may be probed');
            assert.deepStrictEqual(args.slice(0, 3), ['-I', '-S', '-c']);
            assert.match(args[3], /sys\.base_prefix/);
            assert.match(args[3], /python_implementation/);
            return { stdout: await fs.readFile(metadataFile, 'utf8'), stderr: '' };
        });
        information = sandbox.stub(windowApis, 'showInformationMessage').resolves(undefined);
        errors = sandbox.stub(windowApis, 'showErrorMessage').resolves(undefined);
        quickPick = sandbox.stub(windowApis, 'showQuickPick').resolves(undefined);
        progress = sandbox.stub(windowApis, 'withProgress');
        progress.callsFake(async (
            _options: ProgressOptions,
            action: (value: Progress<{ message?: string; increment?: number }>, token: CancellationToken) => Thenable<unknown>,
        ) => action({ report: () => undefined }, progressToken.token));
        pauseWatchers = sandbox.stub(watchers, 'withPackageWatchersPaused');
        pauseWatchers.callsFake(async (_prefix: string, operation: () => Promise<unknown>) => operation());

        optOut = sandbox.stub(uv, 'isDontAskAgainSet').resolves(false);
        uvPrompt = sandbox.stub(uv, 'promptInstallPythonViaUvDetailed').resolves({ kind: 'declined' });
        uvInlinePreflight = sandbox.stub(uv, 'ensureUvForInlineScriptVersionLookupDetailed').resolves('available');
        uvCatalogue = sandbox.stub(uv, 'getAvailablePythonVersions').resolves([]);
        uvPicker = sandbox.stub(uv, 'selectPythonVersionToInstall').resolves(undefined);
        uvInstall = sandbox.stub(uv, 'installPythonWithUv').resolves(undefined);
        setState = sandbox.stub().resolves();
        sandbox.stub(persistentState, 'getGlobalPersistentState').resolves({
            get: sandbox.stub().resolves(undefined),
            set: setState,
            clear: sandbox.stub().resolves(),
        });

        // Each test owns its coordinator queue; other suites retain their module instance.
        previousModule = require.cache[modulePath];
        delete require.cache[modulePath];
        installer = require(modulePath);
    });

    teardown(async () => {
        for (const release of releaseChoices) {
            release();
        }
        for (const gate of gates) {
            gate.resolve();
        }
        await Promise.allSettled(pending);
        for (const token of tokens) {
            token.dispose();
        }
        if (previousModule) {
            require.cache[modulePath] = previousModule;
        } else {
            delete require.cache[modulePath];
        }
        sandbox.restore();
        await fs.rm(root, { recursive: true, force: true });
    });

    function candidate(version = '3.14.6'): PymanagerCandidate {
        const value = candidates.toPymanagerCandidate(onlineRuntime(version), 'x64');
        assert.ok(value);
        return value;
    }

    function provider() {
        return {
            kind: 'pymanager' as const,
            executable: managerExecutable,
        };
    }

    async function fixture(version = '3.14.6'): Promise<RuntimeFixture> {
        const directory = path.join(root, `runtime-${++fixtureNumber}`);
        await fs.mkdir(directory, { recursive: true });
        const prefix = await fs.realpath(directory);
        const executable = path.join(prefix, 'python.exe');
        await fs.writeFile(executable, 'Inert unit-test data. This file must never be executed.');
        const result = {
            runtime: onlineRuntime(version, { prefix, executable }),
            metadataFile: path.join(prefix, 'interpreter-metadata.json'),
        };
        metadataFiles.set(executable, result.metadataFile);
        await writeMetadata(result);
        return result;
    }

    async function writeMetadata(value: RuntimeFixture, overrides: Record<string, unknown> = {}): Promise<void> {
        await fs.writeFile(value.metadataFile, JSON.stringify({
            executable: value.runtime.executable,
            prefix: value.runtime.prefix,
            basePrefix: value.runtime.prefix,
            version: value.runtime.version,
            implementation: 'CPython',
            ...overrides,
        }));
    }

    function nativeCalls(): sinon.SinonSpyCall[] {
        return run.getCalls().filter((call) => call.args[0] === managerExecutable && call.args[1]?.[0] === 'install');
    }

    function assertNoUv(): void {
        for (const stub of [uvPrompt, uvInlinePreflight, uvCatalogue, uvPicker, uvInstall]) {
            sinon.assert.notCalled(stub);
        }
    }

    function assertFailure(result: PythonInstallResult, reason: PythonInstallFailure): void {
        assert.strictEqual(result.kind, 'failed');
        assert.strictEqual(result.reason, reason);
    }

    function verificationFailure(error: unknown): boolean {
        assert.ok(error instanceof PythonInstallationError);
        assert.strictEqual(error.reason, 'verification-failed');
        return true;
    }

    function approve(version = '3.14.6'): void {
        information.resolves(PythonInstallStrings.installAction(version));
    }

    function gate(): Deferred<void> {
        const value = createDeferred<void>();
        gates.push(value);
        return value;
    }

    function track<T>(operation: Promise<T>): Promise<T> {
        pending.push(operation);
        return operation;
    }

    async function entered(value: Deferred<void>, operation: Promise<unknown>): Promise<void> {
        await Promise.race([
            value.promise,
            operation.then(() => assert.fail('Operation completed before reaching the expected blocked stage')),
        ]);
    }

    suite('provider selection and opt-out', () => {
        test('uses UV outside Windows without probing PyManager', async () => {
            (platform.isWindows as sinon.SinonStub).returns(false);
            assert.deepStrictEqual(await installer.getPythonInstaller(), { kind: 'uv' });
            sinon.assert.notCalled(detect);
            sinon.assert.notCalled(list);
            sinon.assert.notCalled(run);
        });

        test('prefers an available Windows PyManager', async () => {
            assert.deepStrictEqual(await installer.getPythonInstaller(), provider());
            sinon.assert.calledOnceWithExactly(detect);
            assertNoUv();
        });

        test('uses UV when Windows PyManager is absent', async () => {
            detect.resolves({ kind: 'absent' });
            assert.deepStrictEqual(await installer.getPythonInstaller(), { kind: 'uv' });
            sinon.assert.calledOnce(detect);
        });

        test('does not fall back to UV when PyManager is known but unusable', async () => {
            detect.resolves({ kind: 'unusable', executable: managerExecutable, error: new Error('denied') });
            await assert.rejects(installer.getPythonInstaller(), (error: unknown) => {
                assert.ok(error instanceof PythonInstallationError);
                assert.strictEqual(error.reason, 'provider-unusable');
                return true;
            });
            assertNoUv();
            sinon.assert.notCalled(list);
        });

        for (const trigger of ['activation', 'createEnvironment'] as const) {
            test(`honors the legacy opt-out before ${trigger} provider discovery`, async () => {
                optOut.resolves(true);
                assert.deepStrictEqual(await installer.promptInstallPythonDetailed(trigger, log), { kind: 'declined' });
                sinon.assert.notCalled(detect);
                sinon.assert.notCalled(information);
                sinon.assert.notCalled(run);
                assertNoUv();
            });
        }

        test('does not apply legacy opt-out or offer it to an explicit inline-script request', async () => {
            optOut.resolves(true);
            const result = await installer.promptInstallPythonDetailed('inlineScript', log, { version: '3.14.6' });
            assert.deepStrictEqual(result, { kind: 'declined' });
            sinon.assert.notCalled(optOut);
            sinon.assert.calledOnce(detect);
            assert.deepStrictEqual(information.firstCall.args.slice(1), [
                { modal: true }, PythonInstallStrings.installAction('3.14.6'),
            ]);
            sinon.assert.notCalled(setState);
            assertNoUv();
        });

        test('persists the shared legacy opt-out without installing anything', async () => {
            information.resolves(Common.dontAskAgain);
            assert.deepStrictEqual(await installer.promptInstallPythonDetailed('activation', log), { kind: 'declined' });
            sinon.assert.calledOnceWithExactly(setState, uv.UV_INSTALL_PYTHON_DONT_ASK_KEY, true);
            assert.ok(information.firstCall.args.includes(Common.dontAskAgain));
            assert.strictEqual(nativeCalls().length, 0);
            assertNoUv();
        });

        test('rejects an invalid request before opt-out, discovery, catalogue or prompt', async () => {
            const result = await installer.promptInstallPythonDetailed('inlineScript', log, { version: '3.x' });
            assertFailure(result, 'no-compatible-python');
            sinon.assert.notCalled(optOut);
            sinon.assert.notCalled(detect);
            sinon.assert.notCalled(resolveCandidate);
            sinon.assert.notCalled(information);
            sinon.assert.notCalled(errors);
        });

        for (const trigger of ['activation', 'inlineScript'] as const) {
            test(`reports an unusable manager correctly for ${trigger} without trying UV`, async () => {
                detect.resolves({ kind: 'unusable', executable: managerExecutable, error: new Error('unusable') });
                const result = await installer.promptInstallPythonDetailed(trigger, log);
                assertFailure(result, 'provider-unusable');
                assert.strictEqual(result.kind === 'failed' && result.alreadyReported, trigger !== 'inlineScript');
                assert.strictEqual(errors.callCount, trigger === 'inlineScript' ? 0 : 1);
                assertNoUv();
            });
        }
    });

    suite('UV delegation', () => {
        for (const availability of ['non-Windows', 'absent'] as const) {
            test(`delegates to the existing UV backend when ${availability}`, async () => {
                if (availability === 'non-Windows') {
                    (platform.isWindows as sinon.SinonStub).returns(false);
                } else {
                    detect.resolves({ kind: 'absent' });
                }
                const value = await fixture();
                uvPrompt.resolves({ kind: 'installed', pythonPath: value.runtime.executable });
                const result = await installer.promptInstallPythonDetailed('createEnvironment', log, { version: '3.14.6' });
                assert.deepStrictEqual(result, {
                    kind: 'installed', provider: 'uv', pythonPath: value.runtime.executable,
                });
                sinon.assert.calledOnceWithExactly(uvPrompt, 'createEnvironment', log, {
                    version: '3.14.6', requiresPython: undefined,
                });
                sinon.assert.notCalled(list);
                sinon.assert.notCalled(run);
            });
        }

        test('preserves UV decline and maps UV failure without retrying another provider', async () => {
            detect.resolves({ kind: 'absent' });
            uvPrompt.onFirstCall().resolves({ kind: 'declined' });
            uvPrompt.onSecondCall().resolves({ kind: 'failed' });
            assert.deepStrictEqual(await installer.promptInstallPythonDetailed('activation', log), { kind: 'declined' });
            assert.deepStrictEqual(await installer.promptInstallPythonDetailed('activation', log), {
                kind: 'failed', reason: 'install-failed',
            });
            sinon.assert.notCalled(list);
            sinon.assert.notCalled(run);
        });

        test('passes a simple inline-script lower bound to UV without a catalogue preflight', async () => {
            detect.resolves({ kind: 'absent' });
            await installer.promptInstallPythonDetailed('inlineScript', log, { requiresPython: '>=3.13' });
            sinon.assert.calledOnceWithExactly(uvPrompt, 'inlineScript', log, {
                version: '3.13', requiresPython: '>=3.13',
            });
            sinon.assert.notCalled(uvInlinePreflight);
            sinon.assert.notCalled(uvCatalogue);
            sinon.assert.notCalled(optOut);
        });

        test('resolves short exact equality against all UV patch versions, not a family selector', async () => {
            detect.resolves({ kind: 'absent' });
            uvCatalogue.resolves([uvRuntime('3.13.12'), uvRuntime('3.13.0')]);
            await installer.promptInstallPythonDetailed('inlineScript', log, { requiresPython: '==3.13' });
            sinon.assert.calledOnceWithExactly(uvInlinePreflight, '==3.13', log);
            sinon.assert.calledOnceWithExactly(uvCatalogue, { allVersions: true });
            sinon.assert.calledOnceWithExactly(uvPrompt, 'inlineScript', log, {
                version: '3.13.0', requiresPython: '==3.13',
            });
            sinon.assert.callOrder(uvInlinePreflight, uvCatalogue, uvPrompt);
        });

        test('filters a compound UV catalogue before asking to install the selected release', async () => {
            detect.resolves({ kind: 'absent' });
            uvCatalogue.resolves([
                uvRuntime('3.13.8'), uvRuntime('3.14.0'),
                uvRuntime('3.13.20', { implementation: 'pypy' }),
                uvRuntime('3.13.19', { variant: 'freethreaded' }),
                uvRuntime('3.13.12'),
            ]);
            await installer.promptInstallPythonDetailed('inlineScript', log, { requiresPython: '>=3.13,<3.14' });
            assert.strictEqual(uvPrompt.firstCall.args[2].version, '3.13.12');
        });

        for (const result of ['declined', 'failed'] as const) {
            test(`does not query or install a UV runtime after inline preflight ${result}`, async () => {
                detect.resolves({ kind: 'absent' });
                uvInlinePreflight.resolves(result);
                const actual = await installer.promptInstallPythonDetailed('inlineScript', log, {
                    requiresPython: '>=3.13,<3.14',
                });
                assert.strictEqual(actual.kind, result);
                sinon.assert.notCalled(uvCatalogue);
                sinon.assert.notCalled(uvPrompt);
                sinon.assert.notCalled(run);
            });
        }

        test('does not offer installation when the UV catalogue is empty', async () => {
            detect.resolves({ kind: 'absent' });
            uvCatalogue.resolves([]);
            const result = await installer.promptInstallPythonDetailed('inlineScript', log, {
                requiresPython: '>=3.13,<3.14',
            });
            assertFailure(result, 'catalogue-failed');
            sinon.assert.notCalled(uvPrompt);
        });
    });

    suite('actual base-interpreter verification', () => {
        test('reads metadata from an inert owned file and verifies its canonical executable and base prefix', async () => {
            const value = await fixture();
            const result = await installer.verifyPymanagerRuntime(value.runtime, { version: '3.14.6' });
            assert.strictEqual(Uri.file(result.executable).fsPath, Uri.file(await fs.realpath(value.runtime.executable)).fsPath);
            assert.strictEqual(result.version.toString(), '3.14.6');
            sinon.assert.calledOnce(run);
            assert.strictEqual(run.firstCall.args[2].timeoutMs, 30000);
            assert.strictEqual(nativeCalls().length, 0);
        });

        const invalidRuntimes: readonly [string, Partial<PymanagerRuntime>][] = [
            ['unmanaged', { unmanaged: true }],
            ['missing prefix', { prefix: undefined }],
            ['relative prefix', { prefix: 'relative-prefix' }],
            ['relative executable', { executable: 'python.exe' }],
            ['wrong company', { company: 'Other' }],
            ['wrong architecture', { tag: '3.14-arm64' }],
            ['required launch arguments', { executableArgs: ['-X', 'special'] }],
            ['wrong declared version', { version: '3.14.5' }],
        ];

        for (const [name, overrides] of invalidRuntimes) {
            test(`rejects ${name} before running the interpreter probe`, async () => {
                const value = await fixture();
                await assert.rejects(
                    installer.verifyPymanagerRuntime({ ...value.runtime, ...overrides }, { version: '3.14.6' }),
                    verificationFailure,
                );
                sinon.assert.notCalled(run);
            });
        }

        test('rejects an executable that does not exist', async () => {
            const value = await fixture();
            await fs.unlink(value.runtime.executable);
            await assert.rejects(installer.verifyPymanagerRuntime(value.runtime, {}), verificationFailure);
            sinon.assert.notCalled(run);
        });

        test('rejects a directory named python.exe', async () => {
            const value = await fixture();
            await fs.unlink(value.runtime.executable);
            await fs.mkdir(value.runtime.executable);
            await assert.rejects(installer.verifyPymanagerRuntime(value.runtime, {}), verificationFailure);
            sinon.assert.notCalled(run);
        });

        test('rejects a pyvenv.cfg marker rather than accepting an active virtual environment as a base', async () => {
            const value = await fixture();
            await fs.writeFile(path.join(value.runtime.prefix!, 'pyvenv.cfg'), 'home = test fixture');
            await assert.rejects(installer.verifyPymanagerRuntime(value.runtime, {}), verificationFailure);
            sinon.assert.notCalled(run);
        });

        for (const text of ['not JSON', '[]', 'null', '{}']) {
            test(`rejects interpreter metadata ${JSON.stringify(text)}`, async () => {
                const value = await fixture();
                await fs.writeFile(value.metadataFile, text);
                await assert.rejects(installer.verifyPymanagerRuntime(value.runtime, {}), verificationFailure);
            });
        }

        const invalidMetadata: readonly [string, Record<string, unknown>][] = [
            ['wrong implementation', { implementation: 'PyPy' }],
            ['wrong actual version', { version: '3.14.5' }],
            ['invalid version', { version: 'unknown' }],
            ['missing version', { version: undefined }],
            ['relative executable', { executable: 'python.exe' }],
            ['relative prefix', { prefix: 'relative' }],
            ['relative base prefix', { basePrefix: 'relative' }],
            ['non-string executable', { executable: 3 }],
            ['non-string prefix', { prefix: null }],
            ['missing base prefix', { basePrefix: undefined }],
        ];

        for (const [name, overrides] of invalidMetadata) {
            test(`rejects ${name} in interpreter metadata`, async () => {
                const value = await fixture();
                await writeMetadata(value, overrides);
                await assert.rejects(installer.verifyPymanagerRuntime(value.runtime, {}), verificationFailure);
            });
        }

        for (const field of ['executable', 'prefix', 'basePrefix'] as const) {
            test(`rejects an existing but different canonical ${field}`, async () => {
                const value = await fixture();
                const other = await fixture();
                await writeMetadata(value, {
                    [field]: field === 'executable' ? other.runtime.executable : other.runtime.prefix,
                });
                await assert.rejects(installer.verifyPymanagerRuntime(value.runtime, {}), verificationFailure);
            });
        }

        test('classifies a missing metadata-reported path as verification failure', async () => {
            const value = await fixture();
            await writeMetadata(value, { executable: path.join(root, 'missing-python.exe') });
            await assert.rejects(installer.verifyPymanagerRuntime(value.runtime, {}), verificationFailure);
        });

        test('preserves cancellation and passes the token to the isolated interpreter probe', async () => {
            const value = await fixture();
            progressToken.cancel();
            await assert.rejects(
                installer.verifyPymanagerRuntime(value.runtime, {}, progressToken.token),
                CancellationError,
            );
            assert.strictEqual(run.firstCall.args[2].cancellationToken, progressToken.token);
            assert.strictEqual(await fs.readFile(value.runtime.executable, 'utf8'), 'Inert unit-test data. This file must never be executed.');
        });
    });

    suite('consent, reuse and installation', () => {
        test('reuses an independently verified matching managed Python without querying online or prompting', async () => {
            const value = await fixture();
            list.resolves([{ ...value.runtime, installTags: [] }]);
            const result = await installer.promptInstallPythonDetailed('activation', log, { version: '3.14' });
            assert.deepStrictEqual(result, { kind: 'installed', provider: 'pymanager', pythonPath: await fs.realpath(value.runtime.executable) });
            sinon.assert.notCalled(resolveCandidate);
            sinon.assert.notCalled(information);
            assert.strictEqual(nativeCalls().length, 0);
            assertNoUv();
        });

        test('tries another compatible installed runtime when the newest fails verification', async () => {
            const bad = await fixture('3.14.7');
            const good = await fixture('3.13.12');
            await writeMetadata(bad, { version: '3.14.5' });
            list.resolves([good.runtime, bad.runtime]);
            const result = await installer.promptInstallPythonDetailed('activation', log);
            assert.strictEqual(result.kind === 'installed' && result.pythonPath, await fs.realpath(good.runtime.executable));
            assert.strictEqual(run.firstCall.args[0], bad.runtime.executable);
            assert.strictEqual(run.secondCall.args[0], good.runtime.executable);
            assert.strictEqual(nativeCalls().length, 0);
            sinon.assert.notCalled(information);
        });

        test('does not silently install or fall back when a matching reported base is unusable', async () => {
            const value = await fixture();
            await fs.writeFile(path.join(value.runtime.prefix!, 'pyvenv.cfg'), '');
            list.resolves([value.runtime]);
            assertFailure(await installer.promptInstallPythonDetailed('activation', log), 'verification-failed');
            sinon.assert.notCalled(resolveCandidate);
            sinon.assert.notCalled(information);
            assert.strictEqual(nativeCalls().length, 0);
            assertNoUv();
        });

        test('declines without mutation when consent is dismissed', async () => {
            const result = await installer.promptInstallPythonDetailed('activation', log, { version: '3.14.6' });
            assert.deepStrictEqual(result, { kind: 'declined' });
            assert.strictEqual(list.callCount, 1);
            assert.strictEqual(nativeCalls().length, 0);
            sinon.assert.notCalled(errors);
            assertNoUv();
        });

        test('waits for informative install/update consent before submitting one concrete native tag', async () => {
            const value = await fixture();
            list.onCall(0).resolves([]);
            list.onCall(1).resolves([]);
            list.onCall(2).resolves([value.runtime]);
            const choice = createDeferred<string | undefined>();
            releaseChoices.push(() => choice.resolve(undefined));
            const prompted = gate();
            information.onFirstCall().callsFake(() => {
                prompted.resolve();
                return choice.promise;
            });
            const operation = track(installer.promptInstallPythonDetailed('inlineScript', log, {
                requiresPython: '>=3.14,<3.15',
            }));
            await entered(prompted, operation);
            assert.strictEqual(nativeCalls().length, 0);
            const message: string = information.firstCall.args[0];
            assert.match(message, /Python Install Manager/);
            assert.match(message, /older.*runtime.*updated/i);
            assert.match(message, /same version family/i);
            assert.match(message, /affecting environments/i);
            assert.match(message, /newer runtimes will not be downgraded/i);
            assert.match(message, />=3\.14,<3\.15/);
            assert.deepStrictEqual(information.firstCall.args.slice(1), [
                { modal: true }, PythonInstallStrings.installAction('3.14.6'),
            ]);
            choice.resolve(PythonInstallStrings.installAction('3.14.6'));
            const result = await operation;
            assert.strictEqual(result.kind, 'installed');
            assert.strictEqual(nativeCalls().length, 1);
            assert.deepStrictEqual(nativeCalls()[0].args[1], ['install', '--update', '--yes', 'PythonCore\\3.14.6-64']);
            assert.strictEqual(nativeCalls()[0].args[2].timeoutMs, 300000);
            assert.strictEqual(nativeCalls()[0].args[2].cancellationToken, progressToken.token);
            assert.ok(information.firstCall.calledBefore(nativeCalls()[0]));
            assert.ok(nativeCalls()[0].calledBefore(run.lastCall));
            assert.strictEqual(information.callCount, 1, 'Inline caller owns any completion notification');
            assertNoUv();
        });

        test('updates an approved older slot and pauses watchers for that same canonical base', async () => {
            const old = await fixture('3.14.5');
            const updated = { ...old.runtime, version: '3.14.6', installTags: ['3.14.6-64'] };
            let installed = [old.runtime];
            list.callsFake(async () => installed);
            approve();
            nativeInstall = async () => {
                assert.strictEqual(pauseWatchers.callCount, 1);
                await writeMetadata(old, { version: '3.14.6' });
                installed = [updated];
            };
            const result = await installer.promptInstallPythonDetailed('activation', log, { version: '3.14.6' });
            assert.strictEqual(result.kind, 'installed');
            assert.strictEqual(pauseWatchers.firstCall.args[0], await fs.realpath(old.runtime.prefix!));
            assert.deepStrictEqual(nativeCalls()[0].args[1], ['install', '--update', '--yes', 'PythonCore\\3.14.6-64']);
            assert.ok(information.firstCall.calledBefore(pauseWatchers.firstCall));
            assertNoUv();
        });

        test('refuses a pre-existing newer incompatible slot before displaying install consent', async () => {
            const newer = await fixture('3.14.7');
            list.resolves([newer.runtime]);
            const result = await installer.promptInstallPythonDetailed('activation', log, { version: '3.14.6' });
            assertFailure(result, 'runtime-conflict');
            sinon.assert.notCalled(information);
            assert.strictEqual(nativeCalls().length, 0);
            assert.match(errors.firstCall.args[0], /3\.14\.7/);
            assert.match(errors.firstCall.args[0], /3\.14\.6/);
            assertNoUv();
        });

        test('rechecks the slot after consent and refuses a newer incompatible runtime that raced in', async () => {
            const newer = await fixture('3.14.7');
            list.onCall(0).resolves([]);
            list.onCall(1).resolves([newer.runtime]);
            approve();
            const result = await installer.promptInstallPythonDetailed('activation', log, { version: '3.14.6' });
            assertFailure(result, 'runtime-conflict');
            assert.strictEqual(information.callCount, 1);
            assert.strictEqual(nativeCalls().length, 0);
            assertNoUv();
        });

        test('uses update-only semantics when a newer slot appears after preflight, then enforces the exact request', async () => {
            const newer = await fixture('3.14.7');
            list.onCall(0).resolves([]);
            list.onCall(1).resolves([]);
            list.onCall(2).resolves([newer.runtime]);
            approve();
            const result = await installer.promptInstallPythonDetailed('activation', log, { version: '3.14.6' });
            assertFailure(result, 'runtime-conflict');
            assert.deepStrictEqual(nativeCalls()[0].args[1], ['install', '--update', '--yes', 'PythonCore\\3.14.6-64']);
            assert.strictEqual(nativeCalls().length, 1);
            assert.strictEqual(await fs.readFile(newer.runtime.executable, 'utf8'), 'Inert unit-test data. This file must never be executed.');
            assertNoUv();
        });

        test('accepts a newer racing slot when its actual interpreter still satisfies the family request', async () => {
            const newer = await fixture('3.14.7');
            list.onCall(0).resolves([]);
            list.onCall(1).resolves([]);
            list.onCall(2).resolves([newer.runtime]);
            approve();
            const result = await installer.promptInstallPythonDetailed('activation', log, { version: '3.14' });
            assert.strictEqual(result.kind === 'installed' && result.pythonPath, await fs.realpath(newer.runtime.executable));
            assert.strictEqual(nativeCalls().length, 1);
            assert.ok(nativeCalls()[0].args[1].includes('--update'));
        });

        test('does not treat native success as sufficient when the installed slot is absent', async () => {
            approve();
            assertFailure(
                await installer.promptInstallPythonDetailed('activation', log, { version: '3.14.6' }),
                'verification-failed',
            );
            assert.strictEqual(nativeCalls().length, 1);
            assertNoUv();
        });

        test('rejects native success when the published executable path is missing', async () => {
            const value = await fixture();
            await fs.unlink(value.runtime.executable);
            list.onCall(0).resolves([]);
            list.onCall(1).resolves([]);
            list.onCall(2).resolves([value.runtime]);
            approve();
            assertFailure(
                await installer.promptInstallPythonDetailed('activation', log, { version: '3.14.6' }),
                'verification-failed',
            );
            assert.strictEqual(nativeCalls().length, 1);
            assert.strictEqual(run.callCount, 1, 'The missing path must not be launched for verification');
            assertNoUv();
        });

        test('rejects a post-install interpreter whose actual version differs from the installed record', async () => {
            const value = await fixture();
            await writeMetadata(value, { version: '3.14.5' });
            list.onCall(0).resolves([]);
            list.onCall(1).resolves([]);
            list.onCall(2).resolves([value.runtime]);
            approve();
            assertFailure(
                await installer.promptInstallPythonDetailed('activation', log, { version: '3.14.6' }),
                'verification-failed',
            );
            assert.strictEqual(nativeCalls().length, 1);
            assertNoUv();
        });

        test('rejects a post-install virtual environment instead of returning it as a base Python', async () => {
            const value = await fixture();
            await fs.writeFile(path.join(value.runtime.prefix!, 'pyvenv.cfg'), '');
            list.onCall(0).resolves([]);
            list.onCall(1).resolves([]);
            list.onCall(2).resolves([value.runtime]);
            approve();
            assertFailure(
                await installer.promptInstallPythonDetailed('activation', log, { version: '3.14.6' }),
                'verification-failed',
            );
            assert.strictEqual(nativeCalls().length, 1);
            assert.strictEqual(run.callCount, 1, 'A non-base path must be rejected before its interpreter probe');
        });

        test('maps the convenience API to a path only for a verified installed outcome', async () => {
            const value = await fixture();
            list.resolves([value.runtime]);
            assert.strictEqual(await installer.promptInstallPython('activation', log), await fs.realpath(value.runtime.executable));
            list.resolves([]);
            assert.strictEqual(await installer.promptInstallPython('activation', log), undefined);
        });

    });

    suite('errors and cancellation', () => {
        test('does not start UV or prompt when the installed-runtime inventory fails', async () => {
            list.rejects(new InstallerProcessError('exit', 1));
            assertFailure(await installer.promptInstallPythonDetailed('activation', log), 'provider-unusable');
            sinon.assert.notCalled(resolveCandidate);
            sinon.assert.notCalled(information);
            assert.strictEqual(nativeCalls().length, 0);
            assertNoUv();
        });

        test('classifies native catalogue errors separately from no compatible runtime', async () => {
            resolveCandidate.rejects(new InstallerProcessError('exit', 1));
            assertFailure(await installer.promptInstallPythonDetailed('activation', log), 'catalogue-failed');
            sinon.assert.calledOnceWithExactly(errors, PythonInstallStrings.catalogueFailed);
            sinon.assert.notCalled(information);
            assertNoUv();
        });

        test('returns a distinct no-compatible outcome without consent or native mutation', async () => {
            resolveCandidate.resolves(undefined);
            assertFailure(await installer.promptInstallPythonDetailed('inlineScript', log), 'no-compatible-python');
            sinon.assert.notCalled(information);
            sinon.assert.notCalled(errors);
            assert.strictEqual(nativeCalls().length, 0);
            assertNoUv();
        });

        for (const trigger of ['activation', 'inlineScript'] as const) {
            test(`preserves native install cancellation for ${trigger} without starting an alternate installer`, async () => {
                approve();
                nativeInstall = async () => {
                    progressToken.cancel();
                    throw new CancellationError();
                };
                const result = await installer.promptInstallPythonDetailed(trigger, log, { version: '3.14.6' });
                assert.strictEqual(result.kind, 'cancelled');
                assert.strictEqual(result.kind === 'cancelled' && result.message, PythonInstallStrings.cancelled);
                assert.strictEqual(nativeCalls().length, 1);
                assert.strictEqual(list.callCount, 2, 'Cancellation must not trigger a post-install command');
                sinon.assert.notCalled(errors);
                assert.strictEqual(information.callCount, trigger === 'inlineScript' ? 1 : 2);
                assertNoUv();
            });
        }

        test('keeps a runtime already published before cancellation rather than deleting it or falling back', async () => {
            const value = await fixture();
            approve();
            nativeInstall = async () => {
                list.resolves([value.runtime]);
                throw new CancellationError();
            };
            const result = await installer.promptInstallPythonDetailed('activation', log, { version: '3.14.6' });
            assert.strictEqual(result.kind, 'cancelled');
            assert.strictEqual(await fs.readFile(value.runtime.executable, 'utf8'), 'Inert unit-test data. This file must never be executed.');
            assert.strictEqual(list.callCount, 2, 'Cancellation must not start another native inventory command');
            assert.strictEqual(nativeCalls().length, 1);
            assertNoUv();
        });

        test('stops an already-cancelled install before its preflight inventory or native mutation', async () => {
            const mutation = sandbox.spy(async () => undefined);
            nativeInstall = mutation;
            progress.callsFake(async (
                options: ProgressOptions,
                action: (value: Progress<{ message?: string; increment?: number }>, token: CancellationToken) => Thenable<unknown>,
            ) => {
                if (options.cancellable) {
                    progressToken.cancel();
                }
                return action({ report: () => undefined }, progressToken.token);
            });
            approve();
            assert.strictEqual((await installer.promptInstallPythonDetailed('activation', log)).kind, 'cancelled');
            assert.strictEqual(list.callCount, 1, 'Only the inventory before consent should have been queried');
            sinon.assert.notCalled(run);
            sinon.assert.notCalled(pauseWatchers);
            sinon.assert.notCalled(mutation);
            assertNoUv();
        });

        test('does not start post-install inventory when cancellation arrives as installation completes', async () => {
            const value = await fixture();
            list.onCall(2).resolves([value.runtime]);
            approve();
            nativeInstall = async () => { progressToken.cancel(); };

            const result = await installer.promptInstallPythonDetailed('inlineScript', log, { version: '3.14.6' });

            assert.strictEqual(result.kind, 'cancelled');
            assert.strictEqual(list.callCount, 2, 'Do not start a new inventory command after cancellation');
            assert.strictEqual(run.callCount, 1, 'Only the completed installation should have run');
            assert.strictEqual(await fs.readFile(value.runtime.executable, 'utf8'), 'Inert unit-test data. This file must never be executed.');
            sinon.assert.notCalled(errors);
            assertNoUv();
        });

        for (const inventory of ['pre-install', 'post-install'] as const) {
            test(`cancels the ${inventory} inventory without reporting provider failure or trying UV`, async () => {
                const inventoryCall = inventory === 'pre-install' ? 1 : 2;
                let receivedToken: CancellationToken | undefined;
                list.onCall(inventoryCall).callsFake(async (_executable: string, options: PymanagerListOptions) => {
                    receivedToken = options.cancellationToken;
                    progressToken.cancel();
                    if (receivedToken?.isCancellationRequested) {
                        throw new CancellationError();
                    }
                    throw new InstallerProcessError('timeout');
                });
                approve();

                const result = await installer.promptInstallPythonDetailed('inlineScript', log);

                assert.strictEqual(receivedToken, progressToken.token, 'Every inventory command within the approved operation needs its cancellation token');
                assert.strictEqual(result.kind, 'cancelled');
                assert.strictEqual(nativeCalls().length, inventory === 'pre-install' ? 0 : 1);
                assert.strictEqual(list.callCount, inventoryCall + 1);
                sinon.assert.notCalled(errors);
                assertNoUv();
            });
        }

        test('preserves cancellation while fetching the catalogue before consent', async () => {
            resolveCandidate.rejects(new CancellationError());
            assert.strictEqual((await installer.promptInstallPythonDetailed('inlineScript', log)).kind, 'cancelled');
            sinon.assert.notCalled(information);
            sinon.assert.notCalled(errors);
            assert.strictEqual(nativeCalls().length, 0);
            assertNoUv();
        });

        test('reports timeout uncertainty and never attempts UV after native mutation began', async () => {
            approve();
            nativeInstall = async () => { throw new InstallerProcessError('timeout', undefined, true); };
            const result = await installer.promptInstallPythonDetailed('activation', log);
            assertFailure(result, 'install-failed');
            sinon.assert.calledOnceWithExactly(errors, PythonInstallStrings.timedOut);
            assert.match(PythonInstallStrings.timedOut, /background work may still be running/i);
            assert.strictEqual(list.callCount, 2);
            assertNoUv();
        });
    });

    suite('provider-first global version picker', () => {
        test('opens the UV picker only after provider selection and installs only the picked version', async () => {
            detect.resolves({ kind: 'absent' });
            const value = await fixture();
            uvPicker.resolves('3.14.6');
            uvInstall.resolves(value.runtime.executable);
            assert.strictEqual(await installer.selectAndInstallPython(log), value.runtime.executable);
            sinon.assert.callOrder(detect, uvPicker, uvInstall);
            sinon.assert.calledOnceWithExactly(uvPicker, log);
            sinon.assert.calledOnceWithExactly(uvInstall, log, '3.14.6');
            sinon.assert.notCalled(uvInlinePreflight);
            sinon.assert.notCalled(list);
            sinon.assert.notCalled(run);
        });

        test('does not install after the UV version picker is dismissed', async () => {
            detect.resolves({ kind: 'absent' });
            assert.strictEqual(await installer.selectAndInstallPython(log), undefined);
            sinon.assert.calledOnce(uvPicker);
            sinon.assert.notCalled(uvInstall);
        });

        test('does not preflight UV when the selected Windows manager is unusable', async () => {
            detect.resolves({ kind: 'unusable', executable: managerExecutable, error: new Error('busy') });
            assert.strictEqual(await installer.selectAndInstallPython(log), undefined);
            sinon.assert.calledOnceWithExactly(errors, PythonInstallStrings.managerUnusable);
            assertNoUv();
        });

        test('uses the PIM catalogue and installed labels, then rechecks and reuses the picked runtime', async () => {
            const value = await fixture();
            list.onCall(0).resolves([value.runtime]);
            list.onCall(1).resolves([onlineRuntime()]);
            list.onCall(2).resolves([value.runtime]);
            quickPick.callsFake(async (items: readonly { candidate: PymanagerCandidate }[]) => items[0]);
            assert.strictEqual(await installer.selectAndInstallPython(log), await fs.realpath(value.runtime.executable));
            assert.deepStrictEqual(list.firstCall.args[1], { onlyManaged: true });
            assert.deepStrictEqual(list.secondCall.args[1], { online: true });
            const item = quickPick.firstCall.args[0][0];
            assert.strictEqual(item.label, 'Python 3.14.6');
            assert.strictEqual(item.description, PythonInstallStrings.installed);
            assert.strictEqual(item.detail, value.runtime.executable);
            sinon.assert.notCalled(information);
            sinon.assert.notCalled(resolveCandidate);
            assert.strictEqual(nativeCalls().length, 0);
            assertNoUv();
        });

        test('ignores legacy automatic-prompt opt-out for an explicitly opened global picker', async () => {
            optOut.resolves(true);
            list.onCall(0).resolves([]);
            list.onCall(1).resolves([onlineRuntime()]);
            assert.strictEqual(await installer.selectAndInstallPython(log), undefined);
            sinon.assert.calledOnce(quickPick);
            sinon.assert.notCalled(optOut);
            assert.strictEqual(nativeCalls().length, 0);
        });

        test('obtains install/update consent after a PIM picker selection rather than treating selection as approval', async () => {
            list.onCall(0).resolves([]);
            list.onCall(1).resolves([onlineRuntime()]);
            list.onCall(2).resolves([]);
            quickPick.callsFake(async (items: readonly { candidate: PymanagerCandidate }[]) => items[0]);
            assert.strictEqual(await installer.selectAndInstallPython(log), undefined);
            sinon.assert.calledOnce(information);
            assert.ok(quickPick.firstCall.calledBefore(information.firstCall));
            assert.deepStrictEqual(information.firstCall.args.slice(1), [
                { modal: true }, PythonInstallStrings.installAction('3.14.6'),
            ]);
            assert.strictEqual(nativeCalls().length, 0);
            assertNoUv();
        });

        test('filters nonstandard builds out of the PIM picker before any consent', async () => {
            list.onCall(0).resolves([]);
            list.onCall(1).resolves([
                onlineRuntime('3.14.6'),
                onlineRuntime('3.14.7', { company: 'Other' }),
                onlineRuntime('3.14.7', { tag: '3.14t-64' }),
                onlineRuntime('3.14.7', { executableArgs: ['-X', 'special'] }),
            ]);
            await installer.selectAndInstallPython(log);
            assert.strictEqual(quickPick.firstCall.args[0].length, 1);
            assert.strictEqual(quickPick.firstCall.args[0][0].candidate.installTag, 'PythonCore\\3.14.6-64');
            assert.strictEqual(nativeCalls().length, 0);
        });

        test('reports an empty PIM catalogue without opening a picker or trying UV', async () => {
            assert.strictEqual(await installer.selectAndInstallPython(log), undefined);
            sinon.assert.calledOnceWithExactly(errors, PythonInstallStrings.noCompatiblePython);
            sinon.assert.notCalled(quickPick);
            assertNoUv();
        });

        test('classifies a failed PIM picker catalogue as a catalogue error, not an installation failure', async () => {
            list.onCall(0).resolves([]);
            list.onCall(1).rejects(new InstallerProcessError('exit', 7));
            assert.strictEqual(await installer.selectAndInstallPython(log), undefined);
            sinon.assert.calledOnceWithExactly(errors, PythonInstallStrings.catalogueFailed);
            sinon.assert.notCalled(quickPick);
            assert.strictEqual(nativeCalls().length, 0);
            assertNoUv();
        });
    });

    suite('queue and race behavior', () => {
        test('serializes concurrent pickers as local/online/local/online with the first local query deferred', async () => {
            const firstLocalStarted = gate();
            const releaseFirstLocal = gate();
            const order: string[] = [];
            let localQueries = 0;
            let inFlight = 0;
            let maximumInFlight = 0;
            list.callsFake(async (command: string, options?: PymanagerListOptions) => {
                assert.strictEqual(command, managerExecutable);
                const phase = options?.online ? 'online' : 'local';
                assert.deepStrictEqual(options, phase === 'online' ? { online: true } : { onlyManaged: true });
                order.push(phase);
                maximumInFlight = Math.max(maximumInFlight, ++inFlight);
                try {
                    if (phase === 'local' && ++localQueries === 1) {
                        firstLocalStarted.resolve();
                        await releaseFirstLocal.promise;
                    }
                    return phase === 'online' ? [onlineRuntime()] : [];
                } finally {
                    inFlight -= 1;
                }
            });
            const first = track(installer.selectAndInstallPython(log));
            await entered(firstLocalStarted, first);
            const second = track(installer.selectAndInstallPython(log));
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.deepStrictEqual(order, ['local']);
            sinon.assert.calledOnce(list);
            sinon.assert.notCalled(quickPick);
            releaseFirstLocal.resolve();
            assert.deepStrictEqual(await Promise.all([first, second]), [undefined, undefined]);
            assert.deepStrictEqual(order, ['local', 'online', 'local', 'online']);
            assert.strictEqual(maximumInFlight, 1, 'Native commands from concurrent pickers must never overlap');
            assert.strictEqual(inFlight, 0);
            assert.strictEqual(list.callCount, 4);
            sinon.assert.calledTwice(quickPick);
            sinon.assert.calledOnce(detect);
            sinon.assert.notCalled(run);
            assertNoUv();
        });

        test('queues another request behind native installation, avoids busy-manager reprobes, and reuses the result', async () => {
            const value = await fixture();
            let installed: PymanagerRuntime[] = [];
            list.callsFake(async () => installed);
            approve();
            const started = gate();
            const release = gate();
            nativeInstall = async () => {
                started.resolve();
                await release.promise;
                installed = [value.runtime];
            };
            const first = track(installer.promptInstallPythonDetailed('activation', log, { version: '3.14.6' }));
            await entered(started, first);
            detect.onSecondCall().resolves({ kind: 'unusable', executable: managerExecutable, error: new Error('busy') });
            const second = track(installer.promptInstallPythonDetailed('activation', log, { version: '3.14.6' }));
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.strictEqual(list.callCount, 2, 'A local list must not race our in-flight install');
            sinon.assert.calledOnce(detect);
            assert.strictEqual(nativeCalls().length, 1);
            release.resolve();
            const results = await Promise.all([first, second]);
            assert.ok(results.every((result) => result.kind === 'installed'));
            assert.strictEqual(nativeCalls().length, 1);
            assert.strictEqual(list.callCount, 4);
            assert.strictEqual(resolveCandidate.callCount, 1);
            assertNoUv();
        });

        test('clears active-provider state after completion so a later independent request probes again', async () => {
            assert.strictEqual((await installer.promptInstallPythonDetailed('activation', log)).kind, 'declined');
            detect.onSecondCall().resolves({ kind: 'absent' });
            assert.deepStrictEqual(await installer.getPythonInstaller(), { kind: 'uv' });
            assert.strictEqual(detect.callCount, 2);
        });

        test('continues the queue after a failed native operation without switching providers', async () => {
            const value = await fixture();
            let installed: PymanagerRuntime[] = [];
            let attempts = 0;
            list.callsFake(async () => installed);
            approve();
            const started = gate();
            const release = gate();
            nativeInstall = async () => {
                if (++attempts === 1) {
                    started.resolve();
                    await release.promise;
                    throw new InstallerProcessError('exit', 7);
                }
                installed = [value.runtime];
            };
            const first = track(installer.promptInstallPythonDetailed('activation', log, { version: '3.14.6' }));
            await entered(started, first);
            const second = track(installer.promptInstallPythonDetailed('activation', log, { version: '3.14.6' }));
            release.resolve();
            const [failed, succeeded] = await Promise.all([first, second]);
            assertFailure(failed, 'install-failed');
            assert.strictEqual(succeeded.kind, 'installed');
            assert.strictEqual(nativeCalls().length, 2);
            assertNoUv();
        });

        test('serializes picker inventory/catalogue work with another request instead of timing out a local query', async () => {
            const onlineStarted = gate();
            const releaseOnline = gate();
            list.callsFake(async (_command: string, options?: PymanagerListOptions) => {
                if (options?.online) {
                    onlineStarted.resolve();
                    await releaseOnline.promise;
                    return [onlineRuntime()];
                }
                return [];
            });
            const first = track(installer.selectAndInstallPython(log));
            await entered(onlineStarted, first);
            const second = track(installer.promptInstallPythonDetailed('activation', log));
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.strictEqual(list.callCount, 2);
            assert.deepStrictEqual(list.firstCall.args[1], { onlyManaged: true });
            assert.deepStrictEqual(list.secondCall.args[1], { online: true });
            sinon.assert.calledOnce(detect);
            releaseOnline.resolve();
            const [selected, result] = await Promise.all([first, second]);
            assert.strictEqual(selected, undefined);
            assert.strictEqual(result.kind, 'declined');
            assert.strictEqual(list.callCount, 3);
            assert.strictEqual(nativeCalls().length, 0);
            assertNoUv();
        });
    });
});
