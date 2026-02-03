import { Uri } from 'vscode';
import { ENVS_EXTENSION_ID, PYTHON_EXTENSION_ID } from '../constants';
import { parseStack } from '../errors/utils';
import { allExtensions, getExtension } from '../extension.apis';
import { traceVerbose, traceWarn } from '../logging';
import { normalizePath } from './pathUtils';

interface FrameData {
    filePath: string;
    functionName: string;
}

// Cache to avoid repeated stack walks for the same caller location
const extensionIdCache = new Map<string, string>();

function getFrameData(): FrameData[] {
    const frames = parseStack(new Error());
    return frames.map((frame) => ({
        filePath: frame.getFileName(),
        functionName: frame.getFunctionName(),
    }));
}

function getPathFromFrame(frame: FrameData): string {
    if (frame.filePath && frame.filePath.startsWith('file://')) {
        return Uri.parse(frame.filePath).fsPath;
    }
    return frame.filePath;
}

export function getCallingExtension(): string {
    const pythonExts = [ENVS_EXTENSION_ID, PYTHON_EXTENSION_ID];
    const extensions = allExtensions();
    const otherExts = extensions.filter((ext) => !pythonExts.includes(ext.id));
    const frames = getFrameData();

    const registerEnvManagerFrameIndex = frames.findIndex(
        (frame) =>
            frame.functionName &&
            (frame.functionName.includes('registerEnvironmentManager') ||
                frame.functionName.includes('registerPackageManager')),
    );

    const relevantFrames =
        registerEnvManagerFrameIndex !== -1 ? frames.slice(registerEnvManagerFrameIndex + 1) : frames;

    const filePaths: string[] = [];
    for (const frame of relevantFrames) {
        if (!frame || !frame.filePath) {
            continue;
        }
        const filePath = normalizePath(getPathFromFrame(frame));
        if (!filePath) {
            continue;
        }

        if (filePath.toLowerCase().endsWith('extensionhostprocess.js')) {
            continue;
        }

        if (filePath.startsWith('node:')) {
            continue;
        }

        filePaths.push(filePath);

        const ext = otherExts.find((ext) => filePath.includes(ext.id));
        if (ext) {
            return ext.id;
        }
    }

    // Generate cache key from the first relevant file path (the immediate caller)
    const cacheKey = filePaths[0] ?? '';
    const cachedResult = extensionIdCache.get(cacheKey);
    if (cachedResult) {
        traceVerbose(`Using cached extension ID for caller: ${cachedResult}`);
        return cachedResult;
    }

    const envExt = getExtension(ENVS_EXTENSION_ID);
    const envsExtPath = envExt ? normalizePath(envExt.extensionPath) : undefined;

    if (envsExtPath && filePaths.every((filePath) => filePath.startsWith(envsExtPath))) {
        extensionIdCache.set(cacheKey, PYTHON_EXTENSION_ID);
        return PYTHON_EXTENSION_ID;
    }

    for (const ext of otherExts) {
        const extPath = normalizePath(ext.extensionPath);
        if (filePaths.some((filePath) => filePath.startsWith(extPath))) {
            extensionIdCache.set(cacheKey, ext.id);
            return ext.id;
        }
    }

    // Fallback - we're likely being called from Python extension or built-in managers
    traceWarn(
        `Could not determine calling extension from stack frames. ` +
            `Using fallback namespace '${PYTHON_EXTENSION_ID}'. ` +
            `Caller paths: ${filePaths.slice(0, 3).join(', ')}`,
    );
    extensionIdCache.set(cacheKey, PYTHON_EXTENSION_ID);
    return PYTHON_EXTENSION_ID;
}
