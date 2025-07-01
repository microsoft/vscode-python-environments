import * as path from 'path';
import * as fs from 'fs-extra';
import { Uri } from 'vscode';
import { PythonEnvironment } from '../../api';
import { traceVerbose, traceWarn } from '../../common/logging';

/**
 * Resolves the site-packages directory path for a given Python environment.
 * This function handles different platforms and Python versions.
 * 
 * @param environment The Python environment to resolve site-packages for
 * @returns Promise<Uri | undefined> The Uri to the site-packages directory, or undefined if not found
 */
export async function resolveSitePackagesPath(environment: PythonEnvironment): Promise<Uri | undefined> {
    const sysPrefix = environment.sysPrefix;
    if (!sysPrefix) {
        traceWarn(`No sysPrefix available for environment: ${environment.displayName}`);
        return undefined;
    }

    traceVerbose(`Resolving site-packages for environment: ${environment.displayName}, sysPrefix: ${sysPrefix}`);

    // Common site-packages locations to check
    const candidates = getSitePackagesCandidates(sysPrefix);
    
    // Check each candidate path
    for (const candidate of candidates) {
        try {
            if (await fs.pathExists(candidate)) {
                const uri = Uri.file(candidate);
                traceVerbose(`Found site-packages at: ${candidate}`);
                return uri;
            }
        } catch (error) {
            traceVerbose(`Error checking site-packages candidate ${candidate}: ${error}`);
        }
    }

    traceWarn(`Could not find site-packages directory for environment: ${environment.displayName}`);
    return undefined;
}

/**
 * Gets candidate site-packages paths for different platforms and Python versions.
 * 
 * @param sysPrefix The sys.prefix of the Python environment
 * @returns Array of candidate paths to check
 */
function getSitePackagesCandidates(sysPrefix: string): string[] {
    const candidates: string[] = [];
    
    // Windows: typically in Lib/site-packages
    if (process.platform === 'win32') {
        candidates.push(path.join(sysPrefix, 'Lib', 'site-packages'));
    }
    
    // Unix-like systems: typically in lib/python*/site-packages
    // We'll check common Python version patterns
    const pythonVersions = [
        'python3.12', 'python3.11', 'python3.10', 'python3.9', 'python3.8', 'python3.7',
        'python3', // fallback
    ];
    
    for (const pyVer of pythonVersions) {
        candidates.push(path.join(sysPrefix, 'lib', pyVer, 'site-packages'));
    }
    
    // Additional locations for conda environments
    candidates.push(path.join(sysPrefix, 'site-packages')); // Some minimal environments
    
    return candidates;
}

/**
 * Checks if a path is likely a site-packages directory by looking for common markers.
 * 
 * @param sitePkgPath Path to check
 * @returns Promise<boolean> True if the path appears to be a site-packages directory
 */
export async function isSitePackagesDirectory(sitePkgPath: string): Promise<boolean> {
    try {
        const stat = await fs.stat(sitePkgPath);
        if (!stat.isDirectory()) {
            return false;
        }

        // Check for common site-packages markers
        const contents = await fs.readdir(sitePkgPath);
        
        // Look for common packages or pip-related files
        const markers = [
            'pip', 'setuptools', 'wheel', // Common packages
            '__pycache__', // Python cache directory
        ];
        
        return markers.some(marker => contents.includes(marker)) || contents.length > 0;
    } catch {
        return false;
    }
}