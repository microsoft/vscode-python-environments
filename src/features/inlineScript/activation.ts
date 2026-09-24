// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { InlineScriptRoutingRegistry } from '../../common/inlineScript/routingRegistry';
import { isInlineScriptsFeatureEnabled } from '../../helpers';

export interface InlineScriptFeatureActivation {
    readonly enabled: boolean;
    readonly routingRegistry: InlineScriptRoutingRegistry | undefined;
}

/**
 * Latch the inline-script feature flag once during activation.
 * The setting requires a window reload, so later config changes
 * in the same activation must not change the chosen mode.
 */
export function latchInlineScriptFeatureActivation(): InlineScriptFeatureActivation {
    const enabled = isInlineScriptsFeatureEnabled();
    return {
        enabled,
        routingRegistry: enabled ? new InlineScriptRoutingRegistry() : undefined,
    };
}
