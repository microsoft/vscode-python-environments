/**
 * Converts package specification strings to command package arguments.
 *
 * The version remains embedded in the package name because each package manager
 * accepts its own specification syntax.
 */
export function parsePackageSpecs(packageStrings: string[]): { packageName: string; version?: string }[] {
    return packageStrings.map((packageName) => ({ packageName }));
}

/**
 * Normalizes a Python package name according to PEP 503 comparison rules.
 */
export function normalizePackageName(name: string): string {
    return name.replace(/[-_.]+/g, '-').toLowerCase();
}
