// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import type { CancellationToken } from 'vscode';
import type { PythonEnvironment } from '../types';

/** Private __pythonTools v1 contract, excluded from the published API. */
export interface PythonToolEnvironmentRequest {
    resourcePath?: string;
    pythonPath?: string;
}

export interface PythonToolQueryRequest {
    resourcePath?: string;
    includePackages?: boolean;
}

export interface PythonToolInstallRequest {
    resourcePath?: string;
    packages: string[];
}

export type PythonToolResult =
    | {
          status: 'success';
          environment: PythonEnvironment;
          resourcePath?: string;
          created?: boolean;
          packages?: { name: string; version?: string }[];
      }
    | {
          status: 'error';
          code: string;
          message: string;
          environment?: PythonEnvironment;
          resourcePath?: string;
      };

export interface PythonToolsApi {
    readonly version: 1;
    configureEnvironment(request: PythonToolEnvironmentRequest, token: CancellationToken): Promise<PythonToolResult>;
    getEnvironment(request: PythonToolQueryRequest, token: CancellationToken): Promise<PythonToolResult>;
    installPackages(request: PythonToolInstallRequest, token: CancellationToken): Promise<PythonToolResult>;
}
