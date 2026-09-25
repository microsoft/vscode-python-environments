// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/*
 * Concrete, public runtime error type(s) for the Python Environments API.
 * Kept separate from `./types.ts` (pure contracts) and re-exported from `./api.ts` to keep
 * that facade small.
 */

/**
 * Error thrown when a project-aware package manager cannot determine which Python project to use.
 *
 * The {@link code} property is a stable discriminator that can be checked across extension bundle
 * boundaries with {@link isPackageManagerRequiresProjectError}.
 */
export class PackageManagerRequiresProjectError extends Error {
    /**
     * Stable discriminator identifying this error type across bundle boundaries.
     */
    public readonly code = 'PackageManagerRequiresProject';

    /**
     * Creates a project-required package error.
     *
     * @param message Optional caller-facing explanation.
     */
    constructor(message?: string) {
        super(message ?? 'Package operations require a Python project.');
        this.name = 'PackageManagerRequiresProjectError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * Reports whether an error means that a package operation requires an unambiguous Python project.
 *
 * @param error The value to test.
 * @returns `true` when the error carries the project-required discriminator.
 */
export function isPackageManagerRequiresProjectError(
    error: unknown,
): error is PackageManagerRequiresProjectError {
    return (
        error instanceof PackageManagerRequiresProjectError ||
        (typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error as { code?: unknown }).code === 'PackageManagerRequiresProject')
    );
}

/**
 * Error thrown when a package manager cannot list available package versions.
 *
 * This distinguishes an *unsupported capability* from an *operational failure* (such as a
 * failed command, a network error, or malformed/unparseable output). Consumers of
 * {@link PythonPackageGetterApi.getPackageAvailableVersions} should treat this specific error
 * as a signal to fall back to manual version entry, while letting any other error propagate.
 *
 * The {@link code} property carries a stable, string-literal discriminator so the error can be
 * recognized reliably across extension bundle boundaries, where `instanceof` may fail because
 * each bundle can load its own copy of this class. Prefer {@link isPackageVersionLookupNotSupportedError}
 * over a bare `instanceof` check for that reason.
 */
export class PackageVersionLookupNotSupportedError extends Error {
    /**
     * Stable discriminator identifying this error type across bundle boundaries.
     */
    public readonly code = 'PackageVersionLookupNotSupported';

    constructor(message?: string) {
        super(message ?? 'The package manager does not support looking up available package versions.');
        this.name = 'PackageVersionLookupNotSupportedError';
        // Preserve the prototype chain when this class is transpiled to older targets so that
        // `instanceof` continues to work within a single bundle.
        Object.setPrototypeOf(this, PackageVersionLookupNotSupportedError.prototype);
    }
}

/**
 * Type guard reporting whether an error represents unsupported package version lookup.
 *
 * Uses the stable {@link PackageVersionLookupNotSupportedError.code} discriminator, so it returns
 * `true` even when the error crossed an extension bundle boundary and `instanceof` would fail.
 *
 * @param error The value to test.
 * @returns `true` if `error` is a {@link PackageVersionLookupNotSupportedError} (or a structurally
 *          equivalent error carrying the same `code`).
 */
export function isPackageVersionLookupNotSupportedError(
    error: unknown,
): error is PackageVersionLookupNotSupportedError {
    return (
        error instanceof PackageVersionLookupNotSupportedError ||
        (typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error as { code?: unknown }).code === 'PackageVersionLookupNotSupported')
    );
}
