// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'node:assert';
import {
    EXPERIMENTATION_ASSIGNMENTS_ENDPOINT,
    EXPERIMENTATION_IDENTITY_PARAMETER,
    getExperimentationExtensionVersion,
    readExperimentationConfiguration,
} from '../../../common/experimentation/configuration';

const configuration = {
    targetPopulation: 'public',
    assignmentParameters: {
        approved_version: 'extensionVersion',
        approved_language: 'language',
    },
};

suite('Experimentation configuration', () => {
    test('an unconfigured build has no implicit endpoint or identity mapping', () => {
        assert.strictEqual(readExperimentationConfiguration({ version: '1.0.0' }), undefined);
        assert.strictEqual(readExperimentationConfiguration(undefined), undefined);
    });

    test('reads only the publisher manifest entry and copies approved bindings', () => {
        const result = readExperimentationConfiguration({ experimentation: configuration });
        assert.deepStrictEqual(result, {
            ...configuration,
            assignmentsEndpoint: EXPERIMENTATION_ASSIGNMENTS_ENDPOINT,
            identityParameter: EXPERIMENTATION_IDENTITY_PARAMETER,
            assignmentParameters: {
                devdeviceid: 'devDeviceId',
                ...configuration.assignmentParameters,
            },
        });
        assert.notStrictEqual(result?.assignmentParameters, configuration.assignmentParameters);
        assert.ok(Object.isFrozen(result?.assignmentParameters));
    });

    test('rejects publisher overrides of the platform-owned endpoint or identity parameter', () => {
        for (const override of [
            { assignmentsEndpoint: 'https://other.example.invalid/api/v1/assignments' },
            { identityParameter: 'other_identity' },
        ]) {
            assert.throws(() => readExperimentationConfiguration({
                experimentation: { ...configuration, ...override },
            }));
        }
    });

    test('requires an explicit supported population', () => {
        for (const targetPopulation of [undefined, 'insiders', 'unknown', true]) {
            assert.throws(() => readExperimentationConfiguration({
                experimentation: { ...configuration, targetPopulation },
            }));
        }
    });

    test('refuses legacy header names and overrides of generic SDK filters', () => {
        for (const name of ['X-MSEdge-ClientId', 'x-client-id', 'extensionname', 'vscode_core_build', '../identity']) {
            assert.throws(() => readExperimentationConfiguration({
                experimentation: {
                    ...configuration,
                    assignmentParameters: { [name]: 'devDeviceId' },
                },
            }));
        }
    });

    test('adds the approved DevDeviceId identity and rejects publisher identity overrides', () => {
        const identityOnly = readExperimentationConfiguration({
            experimentation: { targetPopulation: 'public' },
        });
        assert.deepStrictEqual(identityOnly?.assignmentParameters, { devdeviceid: 'devDeviceId' });

        for (const assignmentParameters of [
            { approved_identity: 'DevDeviceId' },
            { devdeviceid: 'machineId' },
            { devdeviceid: 'devDeviceId', second_identity: 'devDeviceId' },
            { devdeviceid: 'devDeviceId', unapproved: 'some literal value' },
        ]) {
            assert.throws(() => readExperimentationConfiguration({
                experimentation: { ...configuration, assignmentParameters },
            }));
        }
    });

    test('does not treat a malformed configuration as an unconfigured build', () => {
        for (const value of [false, null, [], 'enabled', {}]) {
            assert.throws(() => readExperimentationConfiguration({ experimentation: value }));
        }
    });

    test('validates the extension version', () => {
        assert.strictEqual(getExperimentationExtensionVersion({ version: '1.39.0' }), '1.39.0');
        for (const manifest of [{}, { version: 1 }, { version: '' }, { version: ' ' }, undefined]) {
            assert.throws(() => getExperimentationExtensionVersion(manifest));
        }
    });
});
