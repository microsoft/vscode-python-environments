// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const scenario = JSON.parse(process.env.API_TEST_SCENARIO || '{}');
const runtimeApi = { getEnvironments: async () => [] };
const state = { activations: 0, exportsReads: 0, translations: 0 };
let api = scenario.active && !scenario.noApi ? runtimeApi : undefined;
const extension = {
    isActive: Boolean(scenario.active),
    packageJSON: { version: scenario.version },
    get exports() {
        state.exportsReads += 1;
        return api;
    },
    async activate() {
        state.activations += 1;
        if (scenario.activationError) {
            throw new Error('activation failed');
        }
        extension.isActive = true;
        api = scenario.noApi ? undefined : runtimeApi;
        return api;
    },
};

exports.__runtimeApi = runtimeApi;
exports.__state = state;
exports.extensions = { getExtension: () => (scenario.missing ? undefined : extension) };
exports.l10n = {
    t(message, ...args) {
        state.translations += 1;
        return message.replace(/\{(\d+)\}/g, (_match, index) => String(args[Number(index)]));
    },
};
