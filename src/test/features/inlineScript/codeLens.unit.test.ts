// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as sinon from 'sinon';
import { Position, TextDocument, Uri } from 'vscode';
import { InlineScriptMetadata } from '../../../common/inlineScript/metadata';
import { InlineScriptRoutingRegistry } from '../../../common/inlineScript/routingRegistry';
import { InlineScriptCodeLensProvider, READY_CONFIRMATION_TIMEOUT_MS } from '../../../features/inlineScript/codeLens';

const SETUP_COMMAND = 'python-envs.setupInlineScriptEnv';

function makeMetadata(): InlineScriptMetadata {
    return {
        dependencies: ['requests'],
        range: { start: 0, end: 24 },
        sourceRange: { start: 0, end: 24 },
    };
}

function makeDocument(uri: Uri, isDirty = false): TextDocument {
    return {
        uri,
        isDirty,
        positionAt: (offset: number) => new Position(0, offset),
    } as unknown as TextDocument;
}

suite('Inline script CodeLens provider', () => {
    const scriptUri = Uri.file('/workspace/app.py');
    let routing: InlineScriptRoutingRegistry;
    let provider: InlineScriptCodeLensProvider;

    setup(() => {
        routing = new InlineScriptRoutingRegistry();
        provider = new InlineScriptCodeLensProvider(routing, SETUP_COMMAND);
    });

    teardown(() => {
        provider.dispose();
        routing.dispose();
    });

    test('shows no CodeLens when the file has no saved inline metadata', () => {
        const lenses = provider.provideCodeLenses(makeDocument(scriptUri), {} as never);
        assert.strictEqual(lenses.length, 0);
    });

    test('shows a setup CodeLens when metadata exists but no environment is associated', () => {
        routing.setMetadata(scriptUri, makeMetadata());

        const lenses = provider.provideCodeLenses(makeDocument(scriptUri), {} as never);

        assert.strictEqual(lenses.length, 1);
        assert.strictEqual(lenses[0].command?.command, SETUP_COMMAND);
        assert.deepStrictEqual(lenses[0].command?.arguments, [scriptUri]);
    });

    test('shows no CodeLens while the document has unsaved changes', () => {
        routing.setMetadata(scriptUri, makeMetadata());

        const lenses = provider.provideCodeLenses(makeDocument(scriptUri, true), {} as never);

        assert.strictEqual(lenses.length, 0);
    });

    test('hides the CodeLens once a validated association makes the script routeable', () => {
        routing.setMetadata(scriptUri, makeMetadata());
        routing.setValidatedAssociation(scriptUri, true);
        assert.strictEqual(routing.shouldRoute(scriptUri), true);

        const lenses = provider.provideCodeLenses(makeDocument(scriptUri), {} as never);

        assert.strictEqual(lenses.length, 0);
    });

    test('refreshes CodeLenses when routing state changes', () => {
        let fireCount = 0;
        const sub = provider.onDidChangeCodeLenses(() => (fireCount += 1));

        routing.setMetadata(scriptUri, makeMetadata());
        routing.setValidatedAssociation(scriptUri, true);

        sub.dispose();
        assert.ok(fireCount >= 1, 'onDidChangeCodeLenses should fire when routing state changes');
    });

    suite('post-setup confirmation', () => {
        let clock: sinon.SinonFakeTimers;

        setup(() => {
            clock = sinon.useFakeTimers();
            routing.setMetadata(scriptUri, makeMetadata());
            routing.setValidatedAssociation(scriptUri, true);
        });

        teardown(() => clock.restore());

        test('replaces the hidden setup lens with a non-clickable confirmation naming the version', () => {
            provider.noteEnvironmentReady(scriptUri, '3.12.4');

            const lenses = provider.provideCodeLenses(makeDocument(scriptUri), {} as never);

            assert.strictEqual(lenses.length, 1);
            assert.ok(lenses[0].command?.title.includes('3.12.4'), lenses[0].command?.title);
            assert.strictEqual(lenses[0].command?.command, '', 'the confirmation must not be clickable');
        });

        test('omits the version when none was resolved', () => {
            provider.noteEnvironmentReady(scriptUri, undefined);

            const lenses = provider.provideCodeLenses(makeDocument(scriptUri), {} as never);

            assert.strictEqual(lenses.length, 1);
            assert.ok(!lenses[0].command?.title.includes('('), lenses[0].command?.title);
        });

        test('expires on its own and refreshes so the lens disappears', () => {
            provider.noteEnvironmentReady(scriptUri, '3.12.4');
            let fireCount = 0;
            const sub = provider.onDidChangeCodeLenses(() => (fireCount += 1));

            clock.tick(READY_CONFIRMATION_TIMEOUT_MS + 1);
            sub.dispose();

            assert.strictEqual(fireCount, 1, 'expiry must refresh the lenses');
            assert.strictEqual(provider.provideCodeLenses(makeDocument(scriptUri), {} as never).length, 0);
        });

        test('shows nothing for a routed script that was not just set up', () => {
            assert.strictEqual(provider.provideCodeLenses(makeDocument(scriptUri), {} as never).length, 0);
        });

        test('stays hidden while the document is dirty', () => {
            provider.noteEnvironmentReady(scriptUri, '3.12.4');

            assert.strictEqual(provider.provideCodeLenses(makeDocument(scriptUri, true), {} as never).length, 0);
        });

        test('does not leak timers past disposal', () => {
            provider.noteEnvironmentReady(scriptUri, '3.12.4');

            provider.dispose();

            assert.doesNotThrow(() => clock.tick(READY_CONFIRMATION_TIMEOUT_MS + 1));
        });
    });
});
