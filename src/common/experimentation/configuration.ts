// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

export type ExperimentationPopulation = 'public' | 'insider' | 'internal' | 'team';
export type AssignmentParameterSource = 'machineId' | 'extensionVersion' | 'language';

export interface ExperimentationConfiguration {
    readonly assignmentsEndpoint: string;
    readonly targetPopulation: ExperimentationPopulation;
    readonly identityParameter: string;
    readonly assignmentParameters: Readonly<Record<string, AssignmentParameterSource>>;
}

const GENERIC_PARAMETERS = new Set([
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
    const endpoint = config.assignmentsEndpoint;
    if (typeof endpoint !== 'string') {
        throw new Error('Experimentation requires an approved assignmentsEndpoint.');
    }
    const url = new URL(endpoint);
    if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !url.pathname.endsWith('/api/v1/assignments')
    ) {
        throw new Error(
            'assignmentsEndpoint must be an HTTPS assignments API URL without credentials or query parameters.',
        );
    }
    const population = config.targetPopulation;
    if (population !== 'public' && population !== 'insider' && population !== 'internal' && population !== 'team') {
        throw new Error('Experimentation requires an explicitly approved targetPopulation.');
    }
    if (!isRecord(config.assignmentParameters)) {
        throw new Error('Experimentation requires approved assignment parameter bindings.');
    }

    const parameters: Record<string, AssignmentParameterSource> = {};
    for (const [name, source] of Object.entries(config.assignmentParameters)) {
        if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name) || /^x-/i.test(name) || GENERIC_PARAMETERS.has(name)) {
            throw new Error(
                'Assignment parameters must use new API names and must not replace generic SDK parameters.',
            );
        }
        if (source !== 'machineId' && source !== 'extensionVersion' && source !== 'language') {
            throw new Error(
                'Unsupported assignment parameter source. Add an approved identity provider before enabling TAS.',
            );
        }
        parameters[name] = source;
    }
    const identityParameter = config.identityParameter;
    if (
        typeof identityParameter !== 'string' ||
        parameters[identityParameter] !== 'machineId' ||
        Object.values(parameters).filter((source) => source === 'machineId').length !== 1 ||
        Object.keys(parameters).length > 45
    ) {
        throw new Error(
            'Experimentation requires one explicitly approved machineId identity binding and at most 45 parameters.',
        );
    }

    return {
        assignmentsEndpoint: url.toString(),
        targetPopulation: population,
        identityParameter,
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
