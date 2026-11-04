// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const vscode = require('vscode');
const scenario = JSON.parse(process.env.API_TEST_SCENARIO);

(async () => {
    const packageModule =
        process.env.API_TEST_FORMAT === 'modern'
            ? await import('@vscode/python-environments')
            : require('@vscode/python-environments');
    if (scenario.error) {
        await assert.rejects(packageModule.PythonEnvironments.api(), (error) => {
            assert.match(error.message, new RegExp(scenario.error));
            if (scenario.error === 'requires version') {
                assert.ok(error.message.includes(scenario.version));
                assert.ok(error.message.includes(scenario.minimum));
            }
            return true;
        });
        if (scenario.incompatible) {
            assert.equal(vscode.__state.activations, 0, 'Rejected extensions must not be activated');
            assert.equal(vscode.__state.exportsReads, 0, 'Rejected extensions must not expose their API');
            assert.equal(vscode.__state.translations, 1, 'Compatibility errors must use l10n');
        }
    } else {
        const api = await packageModule.PythonEnvironments.api();
        assert.equal(api, vscode.__runtimeApi);
        assert.equal(vscode.__state.activations, scenario.active ? 0 : 1);
        assert.deepEqual(await api.getEnvironments(), []);
    }
})().catch((error) => {
    process.stderr.write(`${process.env.API_TEST_FORMAT} ${JSON.stringify(scenario)}\n${error.stack}\n`);
    process.exitCode = 1;
});
