import { BaseError } from './types';

export class CreateEnvironmentNotSupported extends BaseError {
    constructor(message: string) {
        super('NotSupported', message);
    }
}

export class RemoveEnvironmentNotSupported extends BaseError {
    constructor(message: string) {
        super('NotSupported', message);
    }
}

/**
 * Indicates that a package manager cannot list available package versions.
 */
export class PackageVersionLookupNotSupportedError extends BaseError {
    readonly code = 'PackageVersionLookupNotSupported';

    constructor(message: string) {
        super('NotSupported', message);
    }
}

/**
 * Checks whether an error represents unsupported package version lookup.
 *
 * The stable code check supports errors crossing extension bundle boundaries,
 * where `instanceof` may not use the same class constructor.
 */
export function isPackageVersionLookupNotSupportedError(
    error: unknown,
): error is PackageVersionLookupNotSupportedError {
    return (
        error instanceof PackageVersionLookupNotSupportedError ||
        (typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'PackageVersionLookupNotSupported')
    );
}
