// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as fs from 'fs-extra';
import { promises as nativeFs } from 'fs';
import * as path from 'path';
import { CancellationError, CancellationToken, LogOutputChannel, ProgressLocation, QuickPickItem } from 'vscode';
import { Common, PythonInstallStrings } from '../../common/localize';
import { InstallerProcessError, runInstallerProcess } from '../../common/installerProcess';
import { traceError, traceInfo, traceWarn } from '../../common/logging';
import { PythonVersion } from '../../common/pythonVersion';
import { EventNames } from '../../common/telemetry/constants';
import { sendTelemetryEvent } from '../../common/telemetry/sender';
import { normalizePath } from '../../common/utils/pathUtils';
import { isWindows } from '../../common/utils/platformUtils';
import { showErrorMessage, showInformationMessage, showQuickPick, withProgress } from '../../common/window.apis';
import { getGlobalPersistentState } from '../../common/persistentState';
import { extractLowerBoundVersion } from '../../common/inlineScript/interpreter';
import { PythonVersionSpecifier, splitClause } from '../../common/pythonVersionSpecifier';
import { detectPymanager, listPymanagerRuntimes, PymanagerRuntime } from './pymanagerPythonInstaller';
import {
    getPymanagerCandidates,
    getPymanagerRuntimeVersion,
    matchesPythonInstallRequest,
    PymanagerCandidate,
    resolvePymanagerCandidate,
    validatePythonInstallRequest,
} from './pythonRuntimeCandidates';
import {
    PythonInstallationError,
    PythonInstaller,
    PythonInstallFailure,
    PythonInstallRequest,
    PythonInstallResult,
    PythonInstallTrigger,
} from './pythonInstallerTypes';
import * as uvInstaller from './uvPythonInstaller';
import { withPackageWatchersPaused } from '../common/packageWatcher';

type InstallTelemetryTrigger = PythonInstallTrigger | 'globalCreate';
type InstallPhase = 'prompted' | 'started' | 'completed' | 'failed' | 'cancelled' | 'declined' | 'reused';

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const INTERPRETER_PROBE_TIMEOUT_MS = 30_000;
const INTERPRETER_PROBE =
    'import json, platform, sys; ' +
    'print(json.dumps({"executable":sys.executable,"prefix":sys.prefix,"basePrefix":sys.base_prefix,' +
    '"version":platform.python_version(),"implementation":platform.python_implementation()}))';

let pymanagerOperations: Promise<void> = Promise.resolve();
let activePymanager: Extract<PythonInstaller, { kind: 'pymanager' }> | undefined;
let pendingPymanagerOperations = 0;

interface VerifiedPython {
    readonly executable: string;
    readonly version: PythonVersion;
}

interface RuntimeQuickPickItem extends QuickPickItem {
    readonly candidate: PymanagerCandidate;
}

function enqueuePymanagerOperation<T>(
    installer: Extract<PythonInstaller, { kind: 'pymanager' }>,
    operation: () => Promise<T>,
): Promise<T> {
    activePymanager ??= installer;
    pendingPymanagerOperations += 1;
    const next = pymanagerOperations.then(operation);
    pymanagerOperations = next.then(() => undefined, () => undefined);
    return next.finally(() => {
        if (--pendingPymanagerOperations === 0) {
            activePymanager = undefined;
        }
    });
}

/** Choose a runtime installer without querying the environment API or installing an installer. */
export async function getPythonInstaller(): Promise<PythonInstaller> {
    if (!isWindows()) {
        return { kind: 'uv' };
    }
    // A probe would wait behind our own native PyManager operation. Queue the
    // caller instead of misreporting a busy, already verified manager as unusable.
    if (activePymanager) {
        return activePymanager;
    }
    const detected = await detectPymanager();
    if (detected.kind === 'absent') {
        return { kind: 'uv' };
    }
    if (detected.kind === 'unusable') {
        traceWarn('Python Install Manager is present but unavailable:', detected.error);
        throw new PythonInstallationError('provider-unusable', PythonInstallStrings.managerUnusable);
    }
    return { kind: 'pymanager', executable: detected.executable };
}

function report(
    provider: PythonInstaller['kind'],
    trigger: InstallTelemetryTrigger,
    phase: InstallPhase,
    reason?: PythonInstallFailure,
    duration?: number,
): void {
    sendTelemetryEvent(EventNames.PYTHON_INSTALLER_OPERATION, duration, { provider, trigger, phase, reason });
}

function failureMessage(reason: PythonInstallFailure): string {
    switch (reason) {
        case 'provider-unusable':
            return PythonInstallStrings.managerUnusable;
        case 'catalogue-failed':
            return PythonInstallStrings.catalogueFailed;
        case 'no-compatible-python':
            return PythonInstallStrings.noCompatiblePython;
        case 'verification-failed':
            return PythonInstallStrings.verificationFailed;
        default:
            return PythonInstallStrings.installFailed;
    }
}

function failedResult(error: unknown, trigger: InstallTelemetryTrigger): PythonInstallResult {
    if (error instanceof CancellationError) {
        if (trigger !== 'inlineScript') {
            void showInformationMessage(PythonInstallStrings.cancelled);
        }
        return { kind: 'cancelled', message: PythonInstallStrings.cancelled };
    }
    const reason = error instanceof PythonInstallationError ? error.reason : 'install-failed';
    const message = error instanceof InstallerProcessError && error.kind === 'timeout'
        ? PythonInstallStrings.timedOut
        : reason === 'runtime-conflict' && error instanceof PythonInstallationError
          ? error.message
          : failureMessage(reason);
    traceError(`Python runtime installation failed (${reason}):`, error);
    if (trigger !== 'inlineScript') {
        void showErrorMessage(message);
    }
    return {
        kind: 'failed',
        reason,
        ...(reason !== 'no-compatible-python' ? { message } : {}),
        alreadyReported: trigger !== 'inlineScript',
    };
}

async function readPymanagerInstalled(
    installer: Extract<PythonInstaller, { kind: 'pymanager' }>,
    cancellationToken?: CancellationToken,
): Promise<PymanagerRuntime[]> {
    if (cancellationToken?.isCancellationRequested) {
        throw new CancellationError();
    }
    try {
        return await listPymanagerRuntimes(installer.executable, {
            onlyManaged: true,
            ...(cancellationToken ? { cancellationToken } : {}),
        });
    } catch (error) {
        if (error instanceof CancellationError) {
            throw error;
        }
        traceWarn('Unable to inspect Python Install Manager runtime state:', error);
        throw new PythonInstallationError('provider-unusable', PythonInstallStrings.managerUnusable);
    }
}

async function queryPymanagerCatalogue<T>(query: () => PromiseLike<T>): Promise<T> {
    try {
        return await query();
    } catch (error) {
        if (error instanceof PythonInstallationError || error instanceof CancellationError) {
            throw error;
        }
        traceWarn('PyManager catalogue lookup failed:', error);
        throw new PythonInstallationError('catalogue-failed', PythonInstallStrings.catalogueFailed);
    }
}

/**
 * Verify the actual base interpreter rather than treating catalogue metadata, a launcher,
 * or a successful installer exit code as sufficient evidence.
 */
export async function verifyPymanagerRuntime(
    runtime: PymanagerRuntime,
    request: PythonInstallRequest,
    cancellationToken?: CancellationToken,
): Promise<VerifiedPython> {
    try {
        return await verifyPymanagerRuntimeCore(runtime, request, cancellationToken);
    } catch (error) {
        if (error instanceof CancellationError || error instanceof PythonInstallationError) {
            throw error;
        }
        traceWarn('The installed Python could not be verified:', error);
        throw new PythonInstallationError('verification-failed', PythonInstallStrings.verificationFailed);
    }
}

async function verifyPymanagerRuntimeCore(
    runtime: PymanagerRuntime,
    request: PythonInstallRequest,
    cancellationToken?: CancellationToken,
): Promise<VerifiedPython> {
    const expectedVersion = getPymanagerRuntimeVersion(runtime);
    if (
        runtime.unmanaged ||
        !expectedVersion ||
        !runtime.prefix ||
        !path.isAbsolute(runtime.executable) ||
        !path.isAbsolute(runtime.prefix) ||
        !matchesPythonInstallRequest(expectedVersion, request) ||
        !(await fs.stat(runtime.executable)).isFile() ||
        await fs.pathExists(path.join(runtime.prefix, 'pyvenv.cfg'))
    ) {
        throw new PythonInstallationError('verification-failed', 'The reported PyManager runtime is not a usable matching base Python.');
    }
    const output = await runInstallerProcess(
        runtime.executable,
        ['-I', '-S', '-c', INTERPRETER_PROBE],
        { timeoutMs: INTERPRETER_PROBE_TIMEOUT_MS, cancellationToken },
    );
    let parsed: unknown;
    try {
        parsed = JSON.parse(output.stdout);
    } catch {
        throw new PythonInstallationError('verification-failed', 'The installed Python did not return interpreter metadata.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new PythonInstallationError('verification-failed', 'Invalid installed Python metadata.');
    }
    const info = parsed as Record<string, unknown>;
    const actualVersion = PythonVersion.tryParse(info.version);
    if (
        typeof info.executable !== 'string' ||
        typeof info.prefix !== 'string' ||
        typeof info.basePrefix !== 'string' ||
        !path.isAbsolute(info.executable) ||
        !path.isAbsolute(info.prefix) ||
        !path.isAbsolute(info.basePrefix) ||
        info.implementation !== 'CPython' ||
        !actualVersion ||
        actualVersion.compareTo(expectedVersion) !== 0 ||
        !matchesPythonInstallRequest(actualVersion, request)
    ) {
        throw new PythonInstallationError('verification-failed', 'The installed Python does not match its requested runtime.');
    }
    const [expectedExecutable, actualExecutable, expectedPrefix, actualPrefix, basePrefix] = await Promise.all([
        nativeFs.realpath(runtime.executable),
        nativeFs.realpath(info.executable),
        nativeFs.realpath(runtime.prefix),
        nativeFs.realpath(info.prefix),
        nativeFs.realpath(info.basePrefix),
    ]);
    if (
        normalizePath(expectedExecutable) !== normalizePath(actualExecutable) ||
        normalizePath(expectedPrefix) !== normalizePath(actualPrefix) ||
        normalizePath(actualPrefix) !== normalizePath(basePrefix)
    ) {
        throw new PythonInstallationError('verification-failed', 'The installed Python resolved outside its reported base installation.');
    }
    return { executable: actualExecutable, version: actualVersion };
}

async function reusePymanagerRuntime(
    runtimes: readonly PymanagerRuntime[],
    request: PythonInstallRequest,
    trigger: InstallTelemetryTrigger,
): Promise<PythonInstallResult | undefined> {
    const compatible = runtimes.flatMap((runtime) => {
        const version = getPymanagerRuntimeVersion(runtime);
        return version && matchesPythonInstallRequest(version, request) ? [{ runtime, version }] : [];
    }).sort((a, b) => b.version.compareTo(a.version));
    let validationError: unknown;
    for (const { runtime } of compatible) {
        try {
            const verified = await verifyPymanagerRuntime(runtime, request);
            report('pymanager', trigger, 'reused');
            return { kind: 'installed', provider: 'pymanager', pythonPath: verified.executable };
        } catch (error) {
            validationError = error;
            traceWarn('A matching Python Install Manager runtime could not be verified:', error);
        }
    }
    if (validationError) {
        throw new PythonInstallationError('verification-failed', PythonInstallStrings.verificationFailed);
    }
    return undefined;
}

function checkPymanagerSlot(
    candidate: PymanagerCandidate,
    installed: readonly PymanagerRuntime[],
    request: PythonInstallRequest,
): void {
    const current = installed.find((runtime) => runtime.id.toLowerCase() === candidate.runtime.id.toLowerCase());
    if (!current) {
        return;
    }
    const version = PythonVersion.tryParse(current.version);
    if (!version) {
        throw new PythonInstallationError('verification-failed', 'Cannot verify the existing PyManager installation slot.');
    }
    if (version.compareTo(candidate.version) > 0 && !matchesPythonInstallRequest(version, request)) {
        throw new PythonInstallationError(
            'runtime-conflict',
            PythonInstallStrings.runtimeConflict(version.toString(), candidate.version.toString()),
        );
    }
}

/**
 * Install one approved runtime slot. The caller must obtain informed consent to install or
 * update older runtimes in this family. An explicit tag plus --update cannot downgrade a
 * newer runtime which appeared after preflight; post-verification still enforces the request.
 */
async function installApprovedPymanagerRuntime(
    installer: Extract<PythonInstaller, { kind: 'pymanager' }>,
    candidate: PymanagerCandidate,
    request: PythonInstallRequest,
    log?: LogOutputChannel,
    cancellationToken?: CancellationToken,
): Promise<string> {
    const installed = await readPymanagerInstalled(installer, cancellationToken);
    checkPymanagerSlot(candidate, installed, request);
    const current = installed.find((runtime) => runtime.id.toLowerCase() === candidate.runtime.id.toLowerCase());
    const operation = () => installAndVerifyPymanagerRuntime(installer, candidate, request, log, cancellationToken);
    return current?.prefix
        ? withPackageWatchersPaused(await nativeFs.realpath(current.prefix), operation)
        : operation();
}

async function installAndVerifyPymanagerRuntime(
    installer: Extract<PythonInstaller, { kind: 'pymanager' }>,
    candidate: PymanagerCandidate,
    request: PythonInstallRequest,
    log?: LogOutputChannel,
    cancellationToken?: CancellationToken,
): Promise<string> {
    await runInstallerProcess(
        installer.executable,
        ['install', '--update', '--yes', candidate.installTag],
        {
            timeoutMs: INSTALL_TIMEOUT_MS,
            cancellationToken,
            onOutput: (text) => log?.append(text),
        },
    );
    const refreshed = await readPymanagerInstalled(installer, cancellationToken);
    const runtime = refreshed.find((item) => item.id.toLowerCase() === candidate.runtime.id.toLowerCase());
    if (!runtime) {
        throw new PythonInstallationError('verification-failed', 'PyManager did not report the installed runtime.');
    }
    checkPymanagerSlot(candidate, refreshed, request);
    return (await verifyPymanagerRuntime(runtime, request, cancellationToken)).executable;
}

async function promptPymanagerInstallation(
    installer: Extract<PythonInstaller, { kind: 'pymanager' }>,
    request: PythonInstallRequest,
    trigger: InstallTelemetryTrigger,
    log?: LogOutputChannel,
    selectedCandidate?: PymanagerCandidate,
): Promise<PythonInstallResult> {
    return enqueuePymanagerOperation(installer, async () => {
        const installed = await readPymanagerInstalled(installer);
        const reused = await reusePymanagerRuntime(installed, request, trigger);
        if (reused) {
            return reused;
        }
        let candidate = selectedCandidate;
        if (!candidate) {
            candidate = await queryPymanagerCatalogue(
                () => withProgress(
                    { location: ProgressLocation.Notification, title: PythonInstallStrings.fetchingVersions },
                    () => resolvePymanagerCandidate(installer.executable, request),
                ),
            );
        }
        if (!candidate) {
            throw new PythonInstallationError('no-compatible-python', PythonInstallStrings.noCompatiblePython);
        }
        checkPymanagerSlot(candidate, installed, request);
        const version = candidate.version.toString();
        const action = PythonInstallStrings.installAction(version);
        const message = PythonInstallStrings.installPrompt(
            version,
            uvInstaller.sanitizePromptDetail(request.requiresPython),
        );
        report('pymanager', trigger, 'prompted');
        const choice = trigger === 'activation' || trigger === 'createEnvironment'
            ? await showInformationMessage(message, { modal: true }, action, Common.dontAskAgain)
            : await showInformationMessage(message, { modal: true }, action);
        if (choice === Common.dontAskAgain) {
            const state = await getGlobalPersistentState();
            await state.set(uvInstaller.UV_INSTALL_PYTHON_DONT_ASK_KEY, true);
        }
        if (choice !== action) {
            report('pymanager', trigger, 'declined');
            return { kind: 'declined' };
        }
        const approvedCandidate = candidate;
        const started = Date.now();
        report('pymanager', trigger, 'started');
        try {
            const pythonPath = await withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: PythonInstallStrings.installing(version),
                    cancellable: true,
                },
                (_progress, token) => installApprovedPymanagerRuntime(
                    installer, approvedCandidate, request, log, token,
                ),
            );
            report('pymanager', trigger, 'completed', undefined, Date.now() - started);
            traceInfo(`Python Install Manager supplied a verified interpreter at ${pythonPath}`);
            if (trigger !== 'inlineScript') {
                void showInformationMessage(PythonInstallStrings.complete(pythonPath));
            }
            return { kind: 'installed', provider: 'pymanager', pythonPath };
        } catch (error) {
            const phase = error instanceof CancellationError ? 'cancelled' : 'failed';
            report('pymanager', trigger, phase, error instanceof PythonInstallationError ? error.reason : 'install-failed',
                Date.now() - started);
            throw error;
        }
    });
}

type UvVersionResolution =
    | { readonly kind: 'selected'; readonly version?: string }
    | { readonly kind: 'declined' }
    | { readonly kind: 'failed'; readonly reason: PythonInstallFailure };

async function resolveUvVersion(request: PythonInstallRequest, log?: LogOutputChannel): Promise<UvVersionResolution> {
    if (request.version !== undefined || !request.requiresPython) {
        return { kind: 'selected', version: request.version };
    }
    const requiresPython = request.requiresPython;
    const lowerBound = extractLowerBoundVersion(requiresPython);
    const prerelease = requiresPython.split(',').map(splitClause)
        .filter((clause) => clause && ['>=', '==', '~='].includes(clause.operator))
        .map((clause) => PythonVersion.tryParse(clause?.literal))
        .find((version) => version && version.releaseLevel !== 'final');
    if (prerelease) {
        return { kind: 'selected', version: prerelease.toString() };
    }
    const version = PythonVersion.tryParse(lowerBound);
    const specifier = PythonVersionSpecifier.tryParse(requiresPython);
    let allVersions = false;
    if (lowerBound && version?.major === 3 && specifier?.matches(version)) {
        if (/^>=\s*[^,]+$/.test(requiresPython)) {
            return { kind: 'selected', version: lowerBound };
        }
        if (/^==\s*[^,*]+$/.test(requiresPython)) {
            if (version.precision >= 3) {
                return { kind: 'selected', version: lowerBound };
            }
            allVersions = true;
        }
    }
    const available = await uvInstaller.ensureUvForInlineScriptVersionLookupDetailed(requiresPython, log);
    if (available !== 'available') {
        return available === 'declined' ? { kind: 'declined' } : { kind: 'failed', reason: 'install-failed' };
    }
    const catalogue = allVersions
        ? await uvInstaller.getAvailablePythonVersions({ allVersions: true })
        : await uvInstaller.getAvailablePythonVersions();
    if (catalogue.length === 0) {
        return { kind: 'failed', reason: 'catalogue-failed' };
    }
    const best = catalogue.flatMap((item) => {
        const parsed = PythonVersion.tryParse(item.version);
        return parsed && item.implementation === 'cpython' && item.variant === 'default' &&
            matchesPythonInstallRequest(parsed, request) ? [{ parsed, version: item.version }] : [];
    }).sort((a, b) => b.parsed.compareTo(a.parsed))[0];
    return best ? { kind: 'selected', version: best.version } : { kind: 'failed', reason: 'no-compatible-python' };
}

/**
 * Acquire a base Python without querying global environment enumeration. Callers remain
 * responsible for PET resolution, selection, settings, and creating their virtual environment.
 */
export async function promptInstallPythonDetailed(
    trigger: PythonInstallTrigger,
    log?: LogOutputChannel,
    request: PythonInstallRequest = {},
): Promise<PythonInstallResult> {
    try {
        validatePythonInstallRequest(request);
        if (trigger !== 'inlineScript' && await uvInstaller.isDontAskAgainSet()) {
            return { kind: 'declined' };
        }
        const installer = await getPythonInstaller();
        if (installer.kind === 'pymanager') {
            return await promptPymanagerInstallation(installer, request, trigger, log);
        }
        const selection = trigger === 'inlineScript'
            ? await resolveUvVersion(request, log)
            : { kind: 'selected' as const, version: request.version };
        if (selection.kind !== 'selected') {
            return selection;
        }
        const result = await uvInstaller.promptInstallPythonViaUvDetailed(trigger, log, {
            requiresPython: request.requiresPython,
            version: selection.version,
        });
        report('uv', trigger, result.kind === 'installed' ? 'completed' : result.kind === 'declined' ? 'declined' : 'failed');
        return result.kind === 'installed'
            ? { ...result, provider: 'uv' }
            : result.kind === 'failed'
              ? { kind: 'failed', reason: 'install-failed' }
              : result;
    } catch (error) {
        if (error instanceof InstallerProcessError && error.kind === 'timeout') {
            traceWarn('Python installer timed out; no alternate installer will be started.', error);
        }
        return failedResult(error, trigger);
    }
}

/** Compatibility convenience for the ordinary missing-Python flows. */
export async function promptInstallPython(
    trigger: PythonInstallTrigger,
    log?: LogOutputChannel,
    request: PythonInstallRequest = {},
): Promise<string | undefined> {
    const result = await promptInstallPythonDetailed(trigger, log, request);
    return result.kind === 'installed' ? result.pythonPath : undefined;
}

/** Pick a global Python using the chosen provider's catalogue, then acquire that exact release. */
export async function selectAndInstallPython(log?: LogOutputChannel): Promise<string | undefined> {
    try {
        const installer = await getPythonInstaller();
        if (installer.kind === 'uv') {
            const selected = await uvInstaller.selectPythonVersionToInstall(log);
            return selected ? uvInstaller.installPythonWithUv(log, selected) : undefined;
        }
        const { runtimes, installed } = await enqueuePymanagerOperation(
            installer,
            async () => withProgress(
                { location: ProgressLocation.Notification, title: PythonInstallStrings.fetchingVersions },
                async () => {
                    // PyManager serializes native commands. Do not let a short local
                    // lookup time out behind our own catalogue query or installation.
                    const installed = await readPymanagerInstalled(installer);
                    const runtimes = await queryPymanagerCatalogue(
                        () => listPymanagerRuntimes(installer.executable, { online: true }),
                    );
                    return { runtimes, installed };
                },
            ),
        );
        const candidates = getPymanagerCandidates(runtimes);
        if (candidates.length === 0) {
            throw new PythonInstallationError('no-compatible-python', PythonInstallStrings.noCompatiblePython);
        }
        const items: RuntimeQuickPickItem[] = candidates.map((candidate) => {
            const current = installed.find((runtime) => runtime.id.toLowerCase() === candidate.runtime.id.toLowerCase() &&
                PythonVersion.tryParse(runtime.version)?.compareTo(candidate.version) === 0);
            return {
                label: `Python ${candidate.version.toString()}`,
                description: current ? PythonInstallStrings.installed : PythonInstallStrings.pymanager,
                detail: current?.executable,
                candidate,
            };
        });
        const selected = await showQuickPick(items, { placeHolder: PythonInstallStrings.selectVersion, ignoreFocusOut: true });
        if (!selected) {
            return undefined;
        }
        const result = await promptPymanagerInstallation(
            installer, { version: selected.candidate.version.toString() }, 'globalCreate', log, selected.candidate,
        );
        return result.kind === 'installed' ? result.pythonPath : undefined;
    } catch (error) {
        failedResult(error, 'globalCreate');
        return undefined;
    }
}
