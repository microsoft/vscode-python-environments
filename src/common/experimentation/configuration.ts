// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

export type ExperimentationPopulation = 'public' | 'insider' | 'internal' | 'team';
export type AssignmentParameterSource = 'devDeviceId' | 'extensionVersion' | 'language';

export const EXPERIMENTATION_ASSIGNMENTS_ENDPOINT =
    'https://exp.individual.githubcopilot.com/api/v1/assignments';
export const EXPERIMENTATION_IDENTITY_PARAMETER = 'devdeviceid';

export interface ExperimentationConfiguration {
    readonly assignmentsEndpoint: string;
    readonly targetPopulation: ExperimentationPopulation;
    readonly identityParameter: string;
    readonly assignmentParameters: Readonly<Record<string, AssignmentParameterSource>>;
}

const GENERIC_PARAMETERS = new Set([
    EXPERIMENTATION_IDENTITY_PARAMETER,
    'vscode_core_appversion',
    'vscode_core_build',
    'vscode_core_extensionname',
    'extensionname',
    'vscode_core_targetpopulation',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read publisher configuration; return undefined if absent and throw if invalid. */
export function readExperimentationConfiguration(manifest: unknown): ExperimentationConfiguration | undefined {
    if (!isRecord(manifest) || manifest.experimentation === undefined) {
        return undefined;
    }
    const config = manifest.experimentation;
    if (!isRecord(config)) {
        throw new Error('The experimentation manifest entry must be an object.');
    }
    if (config.assignmentsEndpoint !== undefined || config.identityParameter !== undefined) {
        throw new Error(
            'The experimentation endpoint and identity parameter are platform-owned and cannot be overridden.',
        );
    }
    const population = config.targetPopulation;
    if (population !== 'public' && population !== 'insider' && population !== 'internal' && population !== 'team') {
        throw new Error('Experimentation requires an explicitly approved targetPopulation.');
    }
    if (config.assignmentParameters !== undefined && !isRecord(config.assignmentParameters)) {
        throw new Error('Experimentation requires approved assignment parameter bindings.');
    }

    const parameters: Record<string, AssignmentParameterSource> = {
        [EXPERIMENTATION_IDENTITY_PARAMETER]: 'devDeviceId',
    };
    for (const [name, source] of Object.entries(config.assignmentParameters ?? {})) {
        if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name) || /^x-/i.test(name) || GENERIC_PARAMETERS.has(name)) {
            throw new Error(
                'Assignment parameters must use new API names and must not replace generic SDK parameters.',
            );
        }
        if (source !== 'extensionVersion' && source !== 'language') {
            throw new Error(
                'Unsupported assignment parameter source. The DevDeviceId binding is platform-owned.',
            );
        }
        parameters[name] = source;
    }
    if (Object.keys(parameters).length > 45) {
        throw new Error('Experimentation supports at most 45 assignment parameters.');
    }

    return {
        assignmentsEndpoint: EXPERIMENTATION_ASSIGNMENTS_ENDPOINT,
        targetPopulation: population,
        identityParameter: EXPERIMENTATION_IDENTITY_PARAMETER,
        assignmentParameters: Object.freeze(parameters),
    };
}

/** Read and validate the extension version from its manifest. */
export function getExperimentationExtensionVersion(manifest: unknown): string {
    if (!isRecord(manifest) || typeof manifest.version !== 'string' || !manifest.version.trim()) {
        throw new Error('Experimentation requires the extension version.');
    }
    return manifest.version;
}
