// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import { Uri } from 'vscode';
import {
    InlineScriptRoutingRegistry,
    getInlineScriptMetadataRoutingIdentity,
} from '../../../common/inlineScript/routingRegistry';

const METADATA = {
    requiresPython: '>=3.11',
    dependencies: ['requests'],
    range: { start: 0, end: 40 },
};

suite('InlineScriptRoutingRegistry', () => {
    test('temporary unavailability preserves routing and notifies only on availability changes', () => {
        const registry = new InlineScriptRoutingRegistry();
        const uri = Uri.joinPath(Uri.file(process.cwd()), 'script.py');
        registry.setMetadata(uri, METADATA);
        registry.setValidatedAssociation(uri, true);
        const availability: boolean[] = [];
        const routeability: boolean[] = [];
        registry.onDidChangeAvailability((changed) => availability.push(registry.isEnvironmentUnavailable(changed)));
        registry.onDidChangeRouteability((event) => routeability.push(event.routeable));

        registry.setEnvironmentUnavailable(uri, true);
        registry.setEnvironmentUnavailable(uri, true);
        assert.strictEqual(registry.shouldRoute(uri), true);
        registry.setEnvironmentUnavailable(uri, false);

        assert.deepStrictEqual(availability, [true, false]);
        assert.deepStrictEqual(routeability, []);
        registry.dispose();
    });

    test('a changed metadata identity drops the previous availability state', () => {
        const registry = new InlineScriptRoutingRegistry();
        const uri = Uri.joinPath(Uri.file(process.cwd()), 'script.py');
        registry.setMetadata(uri, METADATA);
        registry.setValidatedAssociation(uri, true);
        registry.setEnvironmentUnavailable(uri, true);

        registry.setMetadata(uri, { ...METADATA, dependencies: ['rich'] });
        registry.setValidatedAssociation(uri, true);

        assert.strictEqual(registry.isEnvironmentUnavailable(uri), false);
        registry.dispose();
    });

    test('invalidates a validated association synchronously when metadata identity changes', () => {
        const registry = new InlineScriptRoutingRegistry();
        const uri = Uri.file('/workspace/script.py');
        const routeabilityEvents: boolean[] = [];
        registry.onDidChangeRouteability((event) => routeabilityEvents.push(event.routeable));
        registry.setMetadata(uri, METADATA);
        registry.setValidatedAssociation(uri, true);

        registry.setMetadata(uri, {
            ...METADATA,
            dependencies: ['httpx'],
        });

        assert.strictEqual(registry.hasValidatedAssociation(uri), false);
        assert.strictEqual(registry.shouldRoute(uri), false);
        assert.deepStrictEqual(routeabilityEvents, [true, false]);
        registry.dispose();
    });

    test('preserves validation when saved metadata has the same routing identity', () => {
        const registry = new InlineScriptRoutingRegistry();
        const uri = Uri.file('/workspace/script.py');
        registry.setMetadata(uri, METADATA);
        registry.setValidatedAssociation(uri, true);

        registry.setMetadata(uri, {
            ...METADATA,
            dependencies: ['Requests'],
        });

        assert.strictEqual(registry.hasValidatedAssociation(uri), true);
        assert.strictEqual(registry.shouldRoute(uri), true);
        registry.dispose();
    });

    test('keeps metadata revisions monotonic after an empty state is removed', () => {
        const registry = new InlineScriptRoutingRegistry();
        const uri = Uri.file('/workspace/script.py');

        registry.setMetadata(uri, METADATA);
        const firstRevision = registry.getMetadataRevision(uri);
        registry.clearMetadata(uri);
        const clearedRevision = registry.getMetadataRevision(uri);
        registry.setMetadata(uri, METADATA);
        const restoredRevision = registry.getMetadataRevision(uri);

        assert.strictEqual(firstRevision, 1);
        assert.strictEqual(clearedRevision, 2);
        assert.strictEqual(restoredRevision, 3);
        assert.strictEqual(registry.getMetadataIdentity(uri), getInlineScriptMetadataRoutingIdentity(METADATA));
        registry.dispose();
    });
});
