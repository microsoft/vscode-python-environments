import { ENVS_EXTENSION_ID, PYTHON_EXTENSION_ID } from '../constants';
import { parseStack } from '../errors/utils';
import { allExtensions, getExtension } from '../extension.apis';

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

export function getCallingExtension(): string {
    const pythonExts = [ENVS_EXTENSION_ID, PYTHON_EXTENSION_ID];

    const extensions = allExtensions();
    const otherExts = extensions.map((ext) => ext.id).filter((id) => !pythonExts.includes(id));
    const frames = getFrameData();

    for (const frame of frames) {
        for (const ext of otherExts) {
            const filename = frame.filePath;
            if (filename) {
                const parts = filename.split(/\\\//);
                if (parts.includes(ext)) {
                    return ext;
                }
            }
        }
    }

    // development mode
    const otherExtPaths = extensions.map((ext) => ext.extensionPath);
    const candidates = frames.filter((frame) => otherExtPaths.includes(frame.filePath));
    const envsExtPath = getExtension(ENVS_EXTENSION_ID)?.extensionPath;
    if (!envsExtPath) {
        throw new Error('Something went wrong with feature registration');
    }

    if (
        candidates.length === 0 &&
        frames.filter((frame) => !!frame.filePath).every((frame) => frame.filePath.startsWith(envsExtPath))
    ) {
        return PYTHON_EXTENSION_ID;
    }

    // get package json for the environment in candidate
    const candidateExt = extensions.find((ext) => ext.extensionPath === candidates[0].filePath);
    if (candidateExt) {
        return candidateExt.id;
    }

    throw new Error('Unable to determine calling extension');
}
