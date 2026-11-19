// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import { InlineScriptRoutingRegistry } from '../../common/inlineScript/routingRegistry';
import { PythonEnvironmentManagers } from '../../features/envManagers';
import { PythonProjectManager } from '../../features/projectManager';

suite('PythonEnvironmentManagers inline routing attachment', () => {
    test('attaches once and permits replacement only after disposal', () => {
        const projectManager = {
            getProjects: () => [],
        } as unknown as PythonProjectManager;
        const managers = new PythonEnvironmentManagers(projectManager);
        const firstRouting = new InlineScriptRoutingRegistry();
        const secondRouting = new InlineScriptRoutingRegistry();

        const registration = managers.attachInlineScriptRouting(firstRouting);
        assert.throws(() => managers.attachInlineScriptRouting(secondRouting), /already attached/i);

        registration.dispose();
        const replacement = managers.attachInlineScriptRouting(secondRouting);

        replacement.dispose();
        firstRouting.dispose();
        secondRouting.dispose();
        managers.dispose();
    });
});
