import { Uri } from 'vscode';
import { ENVS_EXTENSION_ID, PYTHON_EXTENSION_ID } from '../constants';
import { parseStack } from '../errors/utils';
import { allExtensions, getExtension } from '../extension.apis';
import { normalizePath } from './pathUtils';
interface FrameData {
    filePath: string;
    functionName: string;
}

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
    const filePaths: string[] = [];

    for (const frame of frames) {
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

    // `ms-python.vscode-python-envs` extension in Development mode
    const candidates = filePaths.filter((filePath) =>
        otherExts.some((s) => filePath.includes(normalizePath(s.extensionPath))),
    );
    const envExt = getExtension(ENVS_EXTENSION_ID);

    if (!envExt) {
        throw new Error('Something went wrong with feature registration');
    }
    const envsExtPath = normalizePath(envExt.extensionPath);
    if (candidates.length === 0 && filePaths.every((filePath) => filePath.startsWith(envsExtPath))) {
        return PYTHON_EXTENSION_ID;
    } else if (candidates.length > 0) {
        // 3rd party extension in Development mode
        const candidateExt = otherExts.find((ext) => candidates[0].includes(ext.extensionPath));
        if (candidateExt) {
            return candidateExt.id;
        }
    }

    throw new Error('Unable to determine calling extension id, registration failed');
}
