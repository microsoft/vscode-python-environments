// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as path from 'path';
import { isWindows } from './platformUtils';

export function getVenvPythonPath(envPath: string): string {
    return isWindows()
        ? path.join(envPath, 'Scripts', 'python.exe')
        : path.join(envPath, 'bin', 'python');
}
