// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

export type CapabilityExpectation = 'required' | 'unsupported' | { deferred: string };

export type PackageManagerProfile =
    | {
          readonly status: 'active';
          readonly name: string;
          readonly alwaysUseUv?: boolean;
          readonly availableVersions: CapabilityExpectation;
      }
    | {
          readonly status: 'deferred';
          readonly name: string;
          readonly reason: string;
      };

export interface ActivePackageManagerFixture {
    readonly status: 'active';
    readonly id: string;
    readonly environmentManagerId: string;
    readonly packageName: string;
    readonly capabilities: {
        readonly version: CapabilityExpectation;
        readonly directPackageNames: CapabilityExpectation;
        readonly formatInstallSpec: CapabilityExpectation;
    };
    readonly profiles: readonly PackageManagerProfile[];
}

export interface DeferredPackageManagerFixture {
    readonly status: 'deferred';
    readonly id: string;
    readonly reason: string;
}

export type PackageManagerFixture = ActivePackageManagerFixture | DeferredPackageManagerFixture;

export const packageManagerFixtures: readonly PackageManagerFixture[] = [
    {
        status: 'active',
        id: 'ms-python.python:pip',
        environmentManagerId: 'ms-python.python:venv',
        packageName: 'flask',
        capabilities: {
            version: 'required',
            directPackageNames: 'required',
            formatInstallSpec: 'unsupported',
        },
        profiles: [
            {
                status: 'active',
                name: 'pip',
                alwaysUseUv: false,
                availableVersions: 'required',
            },
            {
                status: 'deferred',
                name: 'uv-backed Pip',
                reason:
                    'A reliable profile would require changing the machine-scoped alwaysUseUv setting during one extension-host run, and available-version lookup uses `uv tool run pip`, which adds network tool seeding. The normal pip path is pinned in the test runner instead.',
            },
        ],
    },
    {
        status: 'active',
        id: 'ms-python.python:conda',
        environmentManagerId: 'ms-python.python:conda',
        packageName: 'flask',
        capabilities: {
            version: 'required',
            directPackageNames: 'unsupported',
            formatInstallSpec: 'required',
        },
        profiles: [
            {
                status: 'active',
                name: 'conda',
                availableVersions: 'required',
            },
        ],
    },
    {
        status: 'deferred',
        id: 'ms-python.python:poetry',
        reason:
            'Poetry package operations require a Poetry-owned project and lockfile lifecycle; that project bootstrap is deferred to dedicated coverage.',
    },
];
