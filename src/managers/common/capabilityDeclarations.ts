// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import type { Capabilities, EnvironmentManagerCapability } from '../../capabilities';

/** Cache and provider-event capabilities implemented by every built-in environment manager. */
export const environmentManagerCacheAndEventCapabilities = Object.freeze({
    'environments.clearCache': async () => ({ supported: true }) as const,
    'environments.events.changed': async () => ({ supported: true }) as const,
    'environments.events.selectionChanged': async () => ({ supported: true }) as const,
} satisfies Capabilities<EnvironmentManagerCapability>);
