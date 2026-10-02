// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'node:assert';
import {
    getExperimentationExtensionVersion,
    readExperimentationConfiguration,
} from '../../../common/experimentation/configuration';

const configuration = {
    assignmentsEndpoint: 'https://assignments.example.invalid/api/v1/assignments',
    targetPopulation: 'public',
    identityParameter: 'approved_identity',
    assignmentParameters: {
        approved_identity: 'machineId',
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
        assert.deepStrictEqual(result, configuration);
        assert.notStrictEqual(result?.assignmentParameters, configuration.assignmentParameters);
        assert.ok(Object.isFrozen(result?.assignmentParameters));
    });

    for (const endpoint of [
        'http://assignments.example.invalid/api/v1/assignments',
        'https://user:password@assignments.example.invalid/api/v1/assignments',
        'https://assignments.example.invalid/api/v1/assignments?token=secret',
        'https://assignments.example.invalid/api/v1/assignments#fragment',
        'https://assignments.example.invalid/',
        'not a URL',
        undefined,
    ]) {
        test(`rejects an unsafe or incomplete endpoint (${String(endpoint)})`, () => {
            assert.throws(() => readExperimentationConfiguration({
                experimentation: { ...configuration, assignmentsEndpoint: endpoint },
            }));
        });
    }

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
                    identityParameter: name,
                    assignmentParameters: { [name]: 'machineId' },
                },
            }));
        }
    });

    test('requires an unambiguous identity source rather than guessing DevDeviceId', () => {
        for (const assignmentParameters of [
            {},
            { approved_identity: 'DevDeviceId' },
            { approved_identity: 'language' },
            { approved_identity: 'machineId', second_identity: 'machineId' },
            { approved_identity: 'machineId', unapproved: 'some literal value' },
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
