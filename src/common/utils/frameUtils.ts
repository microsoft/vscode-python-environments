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
    const otherExts = extensions.filter((ext) => !pythonExts.includes(ext.id));
    const frames = getFrameData().filter((frame) => !!frame.filePath);

    for (const frame of frames) {
        const filename = frame.filePath;
        if (filename) {
            const ext = otherExts.find((ext) => filename.includes(ext.id));
            if (ext) {
                return ext.id;
            }
        }
    }

    // `ms-python.vscode-python-envs` extension in Development mode
    const candidates = frames.filter((frame) => otherExts.some((s) => frame.filePath.includes(s.extensionPath)));
    const envsExtPath = getExtension(ENVS_EXTENSION_ID)?.extensionPath;
    if (!envsExtPath) {
        throw new Error('Something went wrong with feature registration');
    }

    if (candidates.length === 0 && frames.every((frame) => frame.filePath.startsWith(envsExtPath))) {
        return PYTHON_EXTENSION_ID;
    }

    // 3rd party extension in Development mode
    const candidateExt = otherExts.find((ext) => candidates[0].filePath.includes(ext.extensionPath));
    if (candidateExt) {
        return candidateExt.id;
    }

    throw new Error('Unable to determine calling extension id, registration failed');
}
