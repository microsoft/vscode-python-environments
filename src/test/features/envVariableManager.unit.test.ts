// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as sinon from 'sinon';
import { EnvironmentVariableScope } from '../../api';

suite('Environment Variable Scope Tests', () => {
    test('should have correct enum values', () => {
        // Test that the enum values are what we expect
        sinon.assert.match(EnvironmentVariableScope.Process, 1);
        sinon.assert.match(EnvironmentVariableScope.Terminal, 2);
        sinon.assert.match(EnvironmentVariableScope.All, 3); // Process | Terminal = 1 | 2 = 3
    });

    test('should support bitwise operations', () => {
        // Test that All combines Process and Terminal
        const all = EnvironmentVariableScope.Process | EnvironmentVariableScope.Terminal;
        sinon.assert.match(all, EnvironmentVariableScope.All);
        
        // Test that we can check if All includes Process
        const includesProcess = EnvironmentVariableScope.All & EnvironmentVariableScope.Process;
        sinon.assert.match(includesProcess, EnvironmentVariableScope.Process);
        
        // Test that we can check if All includes Terminal
        const includesTerminal = EnvironmentVariableScope.All & EnvironmentVariableScope.Terminal;
        sinon.assert.match(includesTerminal, EnvironmentVariableScope.Terminal);
    });
});