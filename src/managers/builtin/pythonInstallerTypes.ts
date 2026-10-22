// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/** The runtime installer, distinct from an environment or package manager. */
export type PythonInstaller =
    | { readonly kind: 'uv' }
    | { readonly kind: 'pymanager'; readonly executable: string };

export type PythonInstallTrigger = 'activation' | 'createEnvironment' | 'inlineScript';

/**
 * A version selector and a compatibility constraint have different semantics:
 * version "3.13" selects a patch family, whereas requiresPython "==3.13" selects 3.13.0.
 */
export interface PythonInstallRequest {
    readonly version?: string;
    readonly requiresPython?: string;
}

export type PythonInstallFailure =
    | 'provider-unusable'
    | 'catalogue-failed'
    | 'no-compatible-python'
    | 'runtime-conflict'
    | 'install-failed'
    | 'verification-failed';

export type PythonInstallResult =
    | {
          readonly kind: 'installed';
          readonly pythonPath: string;
          readonly provider: PythonInstaller['kind'];
      }
    | { readonly kind: 'declined' }
    | { readonly kind: 'cancelled'; readonly message?: string }
    | {
          readonly kind: 'failed';
          readonly reason: PythonInstallFailure;
          readonly message?: string;
          readonly alreadyReported?: boolean;
      };

/** An internal classified failure; callers supply the localized notification. */
export class PythonInstallationError extends Error {
    constructor(
        public readonly reason: PythonInstallFailure,
        message: string,
    ) {
        super(message);
        this.name = 'PythonInstallationError';
    }
}
