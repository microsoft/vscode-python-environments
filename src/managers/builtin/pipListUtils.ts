export interface PipPackage {
    name: string;
    version: string;
    displayName: string;
    description: string;
}

export function parsePipListJson(data: string): PipPackage[] {
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
    } catch (_) {
        // If JSON parsing fails, return an empty array. The caller can decide how to handle this case.
    }
    return [];
}
