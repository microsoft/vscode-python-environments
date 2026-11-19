// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { promises as fs } from 'fs';
import * as path from 'path';
import { CancellationToken, l10n, Uri } from 'vscode';
import which from 'which';
import { InstallerProcessError, runInstallerProcess } from '../../common/installerProcess';
import { traceVerbose } from '../../common/logging';
import { isFileNotFoundError } from '../../common/utils/filesystem';
import { normalizePath } from '../../common/utils/pathUtils';
import { isWindows } from '../../common/utils/platformUtils';

const DETECTION_BUDGET_MS = 15000;
const LOOKUP_TIMEOUT_MS = 1000;
const PROBE_TIMEOUT_MS = 3000;
const LOCAL_LIST_TIMEOUT_MS = 10000;
const CATALOGUE_TIMEOUT_MS = 60000;

export interface PymanagerRuntime {
    readonly id: string;
    readonly company: string;
    readonly version: string;
    readonly tag: string;
    readonly installTags: readonly string[];
    readonly executable: string;
    readonly executableArgs: readonly string[];
    readonly prefix?: string;
    readonly unmanaged: boolean;
}

export type PymanagerDetection =
    | { readonly kind: 'absent' }
    | { readonly kind: 'available'; readonly executable: string }
    | { readonly kind: 'unusable'; readonly executable: string; readonly error: Error };

export interface PymanagerListOptions {
    readonly online?: boolean;
    readonly selectors?: readonly string[];
    readonly onlyManaged?: boolean;
    /** Cancels this native listing as part of its owning installation operation. */
    readonly cancellationToken?: CancellationToken;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaError(field: string): Error {
    return new Error(l10n.t('PyManager returned an invalid runtime list field: {0}.', field));
}

function requiredString(record: Record<string, unknown>, field: string): string {
    const value = record[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw schemaError(field);
    }
    return value;
}

function optionalStrings(value: unknown, field: string): string[] {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === 'string')) {
        throw schemaError(field);
    }
    return [...value];
}

/**
 * Validates PyManager's native { versions: [...] } JSON and preserves runtime metadata.
 * @param output Complete JSON output from a local or online list command.
 * @returns Runtime records; relative online executables remain relative.
 * @throws When JSON or a required field is invalid, without echoing native output.
 */
export function parsePymanagerRuntimes(output: string): PymanagerRuntime[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(output);
    } catch (_error) {
        throw new Error(l10n.t('PyManager returned invalid JSON.'));
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.versions)) {
        throw schemaError('versions');
    }
    const versions: unknown[] = parsed.versions;
    return versions.map((value) => {
        if (!isRecord(value)) {
            throw schemaError('versions');
        }
        if (value.prefix !== undefined && typeof value.prefix !== 'string') {
            throw schemaError('prefix');
        }
        if (value.unmanaged !== undefined && typeof value.unmanaged !== 'boolean') {
            throw schemaError('unmanaged');
        }
        return {
            id: requiredString(value, 'id'),
            company: requiredString(value, 'company'),
            version: requiredString(value, 'sort-version'),
            tag: requiredString(value, 'tag'),
            installTags: optionalStrings(value['install-for'], 'install-for'),
            executable: requiredString(value, 'executable'),
            executableArgs: optionalStrings(value.executable_args, 'executable_args'),
            prefix: value.prefix,
            unmanaged: value.unmanaged ?? false,
        };
    });
}

/**
 * Lists installed or online runtimes without filtering versions or changing installations.
 * @param executable An existing PyManager executable.
 * @param options Native listing switches/selectors and optional cancellation for the owning operation.
 * @returns All native list results, including distinct runtime families.
 */
export async function listPymanagerRuntimes(
    executable: string,
    options: PymanagerListOptions = {},
): Promise<PymanagerRuntime[]> {
    const args = [
        'list',
        ...(options.online ? ['--online'] : []),
        ...(options.onlyManaged ? ['--only-managed'] : []),
        '--format=json',
        '-q',
        ...(options.selectors ?? []),
    ];
    const result = await runInstallerProcess(executable, args, {
        timeoutMs: options.online ? CATALOGUE_TIMEOUT_MS : LOCAL_LIST_TIMEOUT_MS,
        ...(options.cancellationToken ? { cancellationToken: options.cancellationToken } : {}),
    });
    return parsePymanagerRuntimes(result.stdout);
}

function comparisonKey(value: string): string {
    return normalizePath(Uri.file(path.resolve(value)).fsPath);
}

function candidatePaths(): string[] {
    const candidates: string[] = [];
    const seen = new Set<string>();
    const cwd = comparisonKey(process.cwd());
    const add = (directory: string | undefined, ...parts: string[]): void => {
        if (!directory || !path.isAbsolute(directory)) {
            return;
        }
        const executable = path.resolve(path.join(directory, ...parts, 'pymanager.exe'));
        const key = comparisonKey(executable);
        if (comparisonKey(path.dirname(executable)) !== cwd && !seen.has(key)) {
            seen.add(key);
            candidates.push(executable);
        }
    };
    for (const directory of (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)) {
        add(directory.replace(/^"(.*)"$/, '$1'));
    }
    for (const family of [
        'PythonSoftwareFoundation.PythonManager_3847v3x7pw1km',
        'PythonSoftwareFoundation.PythonManager_qbz5n2kfra8p0',
    ]) {
        add(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', family);
    }
    add(process.env.ProgramFiles, 'PyManager');
    return candidates;
}

async function isCandidate(executable: string): Promise<boolean> {
    try {
        const stat = await fs.lstat(executable);
        if (stat.isSymbolicLink()) {
            // MSIX App Execution Aliases are executable reparse points whose
            // targets cannot be opened with stat/which. Probe the public alias itself.
            return true;
        }
        if (!stat.isFile()) {
            throw new Error(l10n.t('The PyManager executable is not a file.'));
        }
    } catch (error) {
        if (isFileNotFoundError(error) || (isRecord(error) && error.code === 'ENOTDIR')) {
            return false;
        }
        throw error;
    }
    // which adds cwd on Windows for bare commands. Absolute candidates avoid
    // that search and restrict resolution to .exe, regardless of PATHEXT.
    const resolved = await which(executable, { nothrow: true, pathExt: '.EXE' });
    if (!resolved || comparisonKey(resolved) !== comparisonKey(executable)) {
        throw new Error(l10n.t('The PyManager executable could not be resolved.'));
    }
    return true;
}

async function boundedLookup(executable: string, timeoutMs: number): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            isCandidate(executable),
            new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(() => reject(new InstallerProcessError('timeout')), timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timeout);
    }
}

async function detectWindowsPymanager(): Promise<PymanagerDetection> {
    const deadline = Date.now() + DETECTION_BUDGET_MS;
    let unusable: Extract<PymanagerDetection, { kind: 'unusable' }> | undefined;
    for (const executable of candidatePaths()) {
        try {
            if (Date.now() >= deadline) {
                throw new InstallerProcessError('timeout');
            }
            if (!(await boundedLookup(executable, Math.min(LOOKUP_TIMEOUT_MS, deadline - Date.now())))) {
                continue;
            }
            if (Date.now() >= deadline) {
                throw new InstallerProcessError('timeout');
            }
            const result = await runInstallerProcess(
                executable,
                ['list', '--only-managed', '--one', '--format=json', '-q'],
                { timeoutMs: Math.min(PROBE_TIMEOUT_MS, deadline - Date.now()) },
            );
            parsePymanagerRuntimes(result.stdout);
            return { kind: 'available', executable };
        } catch (error) {
            traceVerbose('A PyManager candidate could not be queried.');
            unusable ??= {
                kind: 'unusable',
                executable,
                error: error instanceof Error ? error : new Error(l10n.t('PyManager could not be queried.')),
            };
            if (Date.now() >= deadline) {
                break;
            }
        }
    }
    return unusable ?? { kind: 'absent' };
}

let detectionInFlight: Promise<PymanagerDetection> | undefined;

/**
 * Detects an existing, usable Windows PyManager without bootstrapping or configuring it.
 * @returns Absent, available (including zero installed runtimes), or a candidate's failure.
 * Concurrent calls share one bounded probe; subsequent calls retry instead of caching absence.
 */
export async function detectPymanager(): Promise<PymanagerDetection> {
    if (!isWindows()) {
        return { kind: 'absent' };
    }
    detectionInFlight ??= detectWindowsPymanager().finally(() => {
        detectionInFlight = undefined;
    });
    return detectionInFlight;
}
