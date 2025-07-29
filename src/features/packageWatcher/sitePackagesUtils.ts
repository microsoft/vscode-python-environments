import * as path from 'path';
import { Uri } from 'vscode';
import { traceVerbose } from '../../common/logging';

/**
 * Resolves the package directory path for a given Python environment based on sysPrefix.
 * This is a utility function for environment managers to set the packageFolder property.
 * 
 * @param sysPrefix The sys.prefix of the Python environment
 * @returns Uri | undefined The Uri to the package directory, or undefined if it cannot be determined
 */
export function resolvePackageFolderFromSysPrefix(sysPrefix: string): Uri | undefined {
    if (!sysPrefix) {
        return undefined;
    }

    traceVerbose(`Resolving package folder for sysPrefix: ${sysPrefix}`);

    // For most environments, we can use a simple heuristic:
    // Windows: {sysPrefix}/Lib/site-packages
    // Unix/Linux/macOS: {sysPrefix}/lib/python*/site-packages (we'll use a common pattern)
    // Conda: {sysPrefix}/site-packages

    let packageFolderPath: string;

    if (process.platform === 'win32') {
        // Windows: typically in Lib/site-packages
        packageFolderPath = path.join(sysPrefix, 'Lib', 'site-packages');
    } else {
        // Unix-like systems: try common locations
        // First try conda style
        const condaPath = path.join(sysPrefix, 'site-packages');
        // Then try standard site-packages location (use python3 as a reasonable default)
        const standardPath = path.join(sysPrefix, 'lib', 'python3', 'site-packages');
        
        // For simplicity, we'll prefer the conda style if this looks like a conda environment,
        // otherwise use the standard path
        if (sysPrefix.includes('conda') || sysPrefix.includes('miniconda') || sysPrefix.includes('anaconda')) {
            packageFolderPath = condaPath;
        } else {
            packageFolderPath = standardPath;
        }
    }

    const uri = Uri.file(packageFolderPath);
    traceVerbose(`Resolved package folder to: ${uri.fsPath}`);
    return uri;
}