import { LogOutputChannel } from 'vscode';

export interface PipPackage {
    name: string;
    version: string;
    displayName: string;
    description: string;
}
export function parseUvTree(data: string): string[] {
    return data
        .split('\n')
        .map((line) => line.trim())
        .map((line) => line.split(/\s+/, 1)[0])
        .filter((name) => !!name);
}

export function parsePipListJson(data: string, log?: LogOutputChannel): PipPackage[] {
    try {
        const json = JSON.parse(data);
        if (Array.isArray(json)) {
            return json
                .filter((item) => item.name && item.version)
                .map(({ name, version }) => ({
                    name,
                    version,
                    displayName: name,
                    description: version,
                }));
        }
    } catch (ex) {
        log?.error('Failed to parse pip list JSON output', ex);
    }
    return [];
}
