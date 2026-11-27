import * as tomljs from '@iarna/toml';
import * as fse from 'fs-extra';
import * as path from 'path';
import { Uri } from 'vscode';
import { PythonEnvironment } from '../../api';
import { traceWarn } from '../../common/logging';
import { PythonVersion } from '../../common/pythonVersion';
import { PythonVersionSpecifier } from '../../common/pythonVersionSpecifier';
import { isSameOrParentPath, normalizePath } from '../../common/utils/pathUtils';
import { findFiles } from '../../common/workspace.apis';
import { sortEnvironments } from '../common/utils';

/** Directories whose `pyproject.toml` does not describe the project being created. */
const IGNORED_DIRECTORY = /^(?:\.venv.*|\.git|node_modules|\.tox|\.nox|\.conda|site-packages|__pypackages__)$/i;

const PYPROJECT_EXCLUDE = '**/{.venv*,.git,.nox,.tox,.conda,site-packages,__pypackages__,node_modules}/**';

export type RequiresPythonSelectionOutcome = 'unconstrained' | 'applied' | 'unparseable' | 'none-compatible';

export interface RequiresPythonInterpreterSelection {
    /** Interpreters to offer. Order matches the input when no extra sorting is applied. */
    readonly interpreters: PythonEnvironment[];
    /** Set only when incompatible interpreters were removed. */
    readonly requiresPython?: string;
    readonly outcome: RequiresPythonSelectionOutcome;
}

/**
 * Reads `[project].requires-python` from a `pyproject.toml` file.
 *
 * @returns The trimmed specifier, or `undefined` when the file is missing, unreadable, or has no specifier.
 */
export async function readRequiresPython(fsPath: string): Promise<string | undefined> {
    let content: string;
    try {
        content = await fse.readFile(fsPath, 'utf-8');
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
            traceWarn(`Unable to read ${fsPath}:`, error instanceof Error ? error.message : String(error));
        }
        return undefined;
    }

    try {
        return requiresPythonFromToml(tomljs.parse(content));
    } catch (error) {
        traceWarn(
            `Unable to parse requires-python from ${fsPath}:`,
            error instanceof Error ? error.message : String(error),
        );
        return undefined;
    }
}

/**
 * Resolves the `requires-python` specifier that should guide environment creation for `root`.
 *
 * The `pyproject.toml` in the creation root wins. Otherwise the closest related file is used:
 * an ancestor project before a nested package. Conflicting specifiers at the same distance are ignored.
 */
export async function resolveProjectRequiresPython(root: Uri): Promise<string | undefined> {
    const rootFile = path.join(root.fsPath, 'pyproject.toml');
    if (await fse.pathExists(rootFile)) {
        const rootSpecifier = await readRequiresPython(rootFile);
        if (rootSpecifier) {
            return rootSpecifier;
        }
    }

    const candidates = await findRelatedPyprojects(root);
    const declared: { rank: number; specifier: string }[] = [];
    for (const fsPath of candidates) {
        if (normalizePath(fsPath) === normalizePath(rootFile) || isIgnoredPyproject(fsPath)) {
            continue;
        }
        const rank = rankPyproject(root.fsPath, fsPath);
        if (rank === undefined) {
            continue;
        }
        const specifier = await readRequiresPython(fsPath);
        if (!specifier) {
            continue;
        }
        declared.push({ rank, specifier });
    }

    if (declared.length === 0) {
        return undefined;
    }

    declared.sort((left, right) => left.rank - right.rank);
    const bestRank = declared[0].rank;
    const specifiers = new Set(declared.filter((item) => item.rank === bestRank).map((item) => item.specifier));
    if (specifiers.size !== 1) {
        traceWarn(
            `Conflicting requires-python values for ${root.fsPath}; Create Environment will not filter interpreters.`,
        );
        return undefined;
    }
    return declared[0].specifier;
}

/**
 * Keeps interpreters that satisfy `requiresPython` when at least one does.
 *
 * An empty result is avoided: when nothing matches, or the specifier cannot be parsed, the original
 * list is returned so creation can still continue.
 */
export function selectInterpretersForRequiresPython(
    interpreters: readonly PythonEnvironment[],
    requiresPython: string | undefined,
): RequiresPythonInterpreterSelection {
    const specifier = requiresPython?.trim();
    if (!specifier) {
        return { interpreters: [...interpreters], outcome: 'unconstrained' };
    }

    const parsed = PythonVersionSpecifier.tryParse(specifier);
    if (!parsed) {
        return { interpreters: [...interpreters], outcome: 'unparseable' };
    }

    const matching = interpreters.filter((interpreter) => {
        const version = PythonVersion.tryParse(interpreter.version);
        return version !== undefined && parsed.matches(version);
    });
    if (matching.length === 0) {
        return { interpreters: [...interpreters], outcome: 'none-compatible' };
    }

    return { interpreters: matching, requiresPython: specifier, outcome: 'applied' };
}

/**
 * Picks the base interpreter for Quick Create.
 *
 * The preferred interpreter is kept when it already satisfies `requires-python`. Otherwise the newest
 * compatible Python 3 interpreter is used. The preferred interpreter is kept when the constraint cannot
 * be applied.
 */
export function chooseQuickCreateInterpreter(
    preferred: PythonEnvironment,
    candidates: readonly PythonEnvironment[],
    requiresPython: string | undefined,
): PythonEnvironment {
    const python3 = candidates.filter((interpreter) => PythonVersion.tryParse(interpreter.version)?.major === 3);
    const selection = selectInterpretersForRequiresPython(sortEnvironments([...python3]), requiresPython);
    if (selection.outcome !== 'applied' || !selection.requiresPython) {
        return preferred;
    }

    const preferredVersion = PythonVersion.tryParse(preferred.version);
    const parsed = PythonVersionSpecifier.tryParse(selection.requiresPython);
    if (preferredVersion && parsed?.matches(preferredVersion)) {
        return preferred;
    }
    return selection.interpreters[0] ?? preferred;
}

function requiresPythonFromToml(toml: tomljs.JsonMap): string | undefined {
    const project = toml.project;
    if (!isTomlTable(project)) {
        return undefined;
    }
    const requiresPython = project['requires-python'];
    if (typeof requiresPython !== 'string') {
        return undefined;
    }
    const trimmed = requiresPython.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function isTomlTable(value: unknown): value is tomljs.JsonMap {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

async function findRelatedPyprojects(root: Uri): Promise<string[]> {
    let found: readonly Uri[] = [];
    try {
        const result = await findFiles('**/pyproject.toml', PYPROJECT_EXCLUDE);
        if (Array.isArray(result)) {
            found = result;
        }
    } catch (error) {
        traceWarn(
            'Failed to search for pyproject.toml while resolving requires-python:',
            error instanceof Error ? error.message : String(error),
        );
        return [];
    }

    const related = new Map<string, string>();
    for (const uri of found) {
        if (isIgnoredPyproject(uri.fsPath) || !isRelatedPyproject(root.fsPath, uri.fsPath)) {
            continue;
        }
        related.set(normalizePath(uri.fsPath), uri.fsPath);
    }
    return [...related.values()];
}

function isIgnoredPyproject(fsPath: string): boolean {
    return path
        .normalize(fsPath)
        .split(path.sep)
        .some((segment) => IGNORED_DIRECTORY.test(segment));
}

function isRelatedPyproject(rootFsPath: string, pyprojectFsPath: string): boolean {
    const directory = path.dirname(pyprojectFsPath);
    return isSameOrParentPath(rootFsPath, directory) || isSameOrParentPath(directory, rootFsPath);
}

/**
 * Ranks a `pyproject.toml` by how directly it owns the creation root.
 *
 * `0` is the creation root. Ancestors use their distance (`1` is the parent). Nested packages start at `1000`
 * so an enclosing project is preferred over a nested one.
 */
function rankPyproject(rootFsPath: string, pyprojectFsPath: string): number | undefined {
    const directory = path.resolve(path.dirname(pyprojectFsPath));
    const root = path.resolve(rootFsPath);
    if (normalizePath(directory) === normalizePath(root)) {
        return 0;
    }
    if (isSameOrParentPath(root, directory)) {
        const depth = relativeDepth(root, directory);
        return depth === undefined ? undefined : 1000 + depth;
    }
    if (isSameOrParentPath(directory, root)) {
        return relativeDepth(directory, root);
    }
    return undefined;
}

function relativeDepth(parent: string, candidate: string): number | undefined {
    const relative = path.relative(parent, candidate);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return undefined;
    }
    return relative.split(path.sep).filter((segment) => segment.length > 0).length;
}
