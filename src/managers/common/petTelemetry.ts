interface RefreshTelemetryInfo {
    kind?: string;
    tool?: string;
}

/** Performance breakdown sent by PET via the `telemetry` notification after a refresh. */
export interface RefreshPerformance {
    total: number;
    /** Phase name (Locators | Path | GlobalVirtualEnvs | Workspaces) to wall-clock ms. */
    breakdown: Record<string, number>;
    /** Locator name (Conda | WindowsRegistry | ...) to wall-clock ms; only ran locators are present. */
    locators: Record<string, number>;
}

export interface RefreshTelemetryMeasuresInput {
    duration: number;
    nativeInfo: readonly RefreshTelemetryInfo[];
    condaKind: string;
    unresolvedCount: number;
    attempt: number;
    workspaceDirCount?: number;
    searchPathCount?: number;
    refreshPerformance?: RefreshPerformance;
}

const REFRESH_BREAKDOWN_MEASURES = [
    ['Locators', 'breakdownLocators'],
    ['Path', 'breakdownPathEnv'],
    ['GlobalVirtualEnvs', 'breakdownGlobalVirtualEnvs'],
    ['Workspaces', 'breakdownWorkspaces'],
] as const;

/** Builds the numeric PET refresh payload sent through telemetry measurements. */
export function getRefreshTelemetryMeasures(input: RefreshTelemetryMeasuresInput): Record<string, number> {
    let envCount = 0;
    let condaEnvCount = 0;
    let managerCount = 0;
    for (const info of input.nativeInfo) {
        if (info.tool) {
            managerCount++;
        } else {
            envCount++;
            if (info.kind === input.condaKind) {
                condaEnvCount++;
            }
        }
    }

    const measures: Record<string, number> = {
        duration: input.duration,
        envCount,
        condaEnvCount,
        managerCount,
        unresolvedCount: input.unresolvedCount,
        attempt: input.attempt,
    };
    if (input.workspaceDirCount !== undefined) {
        measures.workspaceDirCount = input.workspaceDirCount;
    }
    if (input.searchPathCount !== undefined) {
        measures.searchPathCount = input.searchPathCount;
    }

    const breakdown = input.refreshPerformance?.breakdown;
    if (breakdown) {
        for (const [phase, measure] of REFRESH_BREAKDOWN_MEASURES) {
            if (breakdown[phase] !== undefined) {
                measures[measure] = breakdown[phase];
            }
        }
    }
    return measures;
}

/** Returns true only when cached PET attribution is absent or the binary is provably unchanged. */
export function shouldRetainPetInfo(
    hasPetInfo: boolean,
    previousFingerprint: string | undefined,
    currentFingerprint: string | undefined,
): boolean {
    return !hasPetInfo ||
        (previousFingerprint !== undefined &&
            currentFingerprint !== undefined &&
            previousFingerprint === currentFingerprint);
}
