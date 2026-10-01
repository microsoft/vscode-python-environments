// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { createHash } from 'crypto';
import type { Memento } from 'vscode';
import { traceWarn } from '../logging';
import type { ExperimentationConfiguration } from './configuration';

export const TAS_CACHE_KEY = 'VSCode.ABExp.FeatureData';

function isCacheData(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const cache = value as Record<string, unknown>;
    return (
        Array.isArray(cache.features) &&
        cache.features.every((feature) => typeof feature === 'string') &&
        typeof cache.assignmentContext === 'string' &&
        Array.isArray(cache.configs) &&
        cache.configs.every((config: unknown) => {
            if (typeof config !== 'object' || config === null) {
                return false;
            }
            const entry = config as Record<string, unknown>;
            return typeof entry.Id === 'string' &&
                typeof entry.Parameters === 'object' && entry.Parameters !== null && !Array.isArray(entry.Parameters);
        })
    );
}

/** Scope globalState assignments by identity and configuration, ignoring stopped SDK writes. */
export class ExperimentationStorage implements Memento {
    private readonly prefix: string;
    private reportedInvalidCache = false;

    constructor(
        private readonly storage: Memento,
        configuration: ExperimentationConfiguration,
        identity: string,
        extensionVersion: string,
        private readonly isActive: () => boolean,
    ) {
        const namespace = JSON.stringify([
            configuration.assignmentsEndpoint,
            configuration.targetPopulation,
            configuration.identityParameter,
            Object.entries(configuration.assignmentParameters).sort(([a], [b]) => a.localeCompare(b)),
            identity,
            extensionVersion,
        ]);
        this.prefix = `python-envs.experimentation.${createHash('sha256').update(namespace).digest('hex')}.`;
    }

    /** Check for a valid cached snapshot, including an empty one. */
    public hasCachedAssignments(): boolean {
        return this.get<unknown>(TAS_CACHE_KEY) !== undefined;
    }

    public keys(): readonly string[] {
        return this.storage.keys()
            .filter((key) => key.startsWith(this.prefix))
            .map((key) => key.slice(this.prefix.length));
    }

    public get<T>(key: string): T | undefined;
    public get<T>(key: string, defaultValue: T): T;
    public get<T>(key: string, defaultValue?: T): T | undefined {
        const value = this.storage.get<T>(`${this.prefix}${key}`);
        if (key === TAS_CACHE_KEY && value !== undefined && !isCacheData(value)) {
            if (!this.reportedInvalidCache) {
                this.reportedInvalidCache = true;
                traceWarn('[experimentation] Ignoring malformed cached assignments; awaiting a fresh fetch.');
            }
            return defaultValue;
        }
        return value === undefined ? defaultValue : value;
    }

    public async update(key: string, value: unknown): Promise<void> {
        if (!this.isActive()) {
            return;
        }
        try {
            await this.storage.update(`${this.prefix}${key}`, value);
        } catch (error) {
            traceWarn('[experimentation] Unable to persist assignments; they may not survive reload:', error);
        }
    }
}
