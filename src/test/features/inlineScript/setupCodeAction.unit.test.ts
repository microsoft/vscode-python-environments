// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as sinon from 'sinon';
import { CodeActionContext, Diagnostic, Position, Range, TextDocument, Uri } from 'vscode';
import { InlineScriptMetadata, MAX_HEADER_BYTES } from '../../../common/inlineScript/metadata';
import { InlineScriptRoutingRegistry } from '../../../common/inlineScript/routingRegistry';
import { InlineScriptStrings } from '../../../common/localize';
import {
    InlineScriptSetupCodeActionProvider,
    isUnresolvedImportDiagnostic,
} from '../../../features/inlineScript/setupCodeAction';
import * as helpers from '../../../helpers';

const SETUP_COMMAND = 'python-envs.setupInlineScriptEnv';

const SCRIPT_WITH_METADATA = [
    '# /// script',
    '# dependencies = ["requests"]',
    '# ///',
    '',
    'import requests',
    '',
].join('\n');

const SCRIPT_WITHOUT_METADATA = ['import requests', '', 'print(requests)', ''].join('\n');

function makeMetadata(): InlineScriptMetadata {
    return {
        dependencies: ['requests'],
        range: { start: 0, end: 47 },
        sourceRange: { start: 0, end: 47 },
    };
}

function makeDocument(uri: Uri, text = SCRIPT_WITH_METADATA): TextDocument {
    return {
        uri,
        languageId: 'python',
        getText: () => text,
    } as unknown as TextDocument;
}

function makeDiagnostic(code: Diagnostic['code'], source = 'Pylance'): Diagnostic {
    const range = new Range(new Position(4, 7), new Position(4, 15));
    const diagnostic = new Diagnostic(range, 'Import "requests" could not be resolved');
    diagnostic.code = code;
    diagnostic.source = source;
    return diagnostic;
}

function makeContext(diagnostics: Diagnostic[]): CodeActionContext {
    return { diagnostics, only: undefined, triggerKind: 1 } as unknown as CodeActionContext;
}

const INVOCATION_RANGE = new Range(new Position(4, 7), new Position(4, 7));

suite('Inline script setup code action', () => {
    const scriptUri = Uri.file('/workspace/app.py');
    let routing: InlineScriptRoutingRegistry;
    let provider: InlineScriptSetupCodeActionProvider;
    let featureEnabledStub: sinon.SinonStub;

    setup(() => {
        featureEnabledStub = sinon.stub(helpers, 'isInlineScriptsFeatureEnabled').returns(true);
        routing = new InlineScriptRoutingRegistry();
        provider = new InlineScriptSetupCodeActionProvider(routing, SETUP_COMMAND);
    });

    teardown(() => {
        routing.dispose();
        sinon.restore();
    });

    function provide(document: TextDocument, diagnostics: Diagnostic[]) {
        return provider.provideCodeActions(document, INVOCATION_RANGE, makeContext(diagnostics), {} as never);
    }

    suite('isUnresolvedImportDiagnostic', () => {
        const matching: Array<[string, Diagnostic['code']]> = [
            ['Pyright/Pylance reportMissingImports', 'reportMissingImports'],
            ['Pyright/Pylance reportMissingModuleSource', 'reportMissingModuleSource'],
            ['Ty unresolved-import', 'unresolved-import'],
            ['Ty possibly-missing-import', 'possibly-missing-import'],
            ['Pyrefly missing-import', 'missing-import'],
            ['Pyrefly missing-source', 'missing-source'],
            ['Pyrefly missing-source-for-stubs', 'missing-source-for-stubs'],
            ['mypy import-not-found', 'import-not-found'],
            ['mypy import-untyped', 'import-untyped'],
        ];

        for (const [label, code] of matching) {
            test(`matches ${label}`, () => {
                assert.strictEqual(isUnresolvedImportDiagnostic(makeDiagnostic(code)), true);
            });
        }

        test('matches the {value, target} object form of Diagnostic.code', () => {
            const code = { value: 'reportMissingImports', target: Uri.parse('https://example.invalid/rule') };
            assert.strictEqual(isUnresolvedImportDiagnostic(makeDiagnostic(code)), true);
        });

        test('matches regardless of case', () => {
            assert.strictEqual(isUnresolvedImportDiagnostic(makeDiagnostic('ReportMissingImports')), true);
        });

        test('ignores the diagnostic source, which is "pylance + pyrefly" for Pyrefly', () => {
            assert.strictEqual(
                isUnresolvedImportDiagnostic(makeDiagnostic('missing-import', 'pylance + pyrefly')),
                true,
            );
        });

        test('does not match unrelated diagnostic codes', () => {
            assert.strictEqual(isUnresolvedImportDiagnostic(makeDiagnostic('reportUndefinedVariable')), false);
            assert.strictEqual(isUnresolvedImportDiagnostic(makeDiagnostic('unresolved-reference')), false);
        });

        test('does not match a diagnostic with no code', () => {
            assert.strictEqual(isUnresolvedImportDiagnostic(makeDiagnostic(undefined)), false);
        });

        test('does not match a numeric code that is not an import rule', () => {
            assert.strictEqual(isUnresolvedImportDiagnostic(makeDiagnostic(42)), false);
        });
    });

    suite('provideCodeActions', () => {
        test('offers setup for an unresolved import in a not-yet-configured inline script', () => {
            const actions = provide(makeDocument(scriptUri), [makeDiagnostic('reportMissingImports')]);

            assert.strictEqual(actions.length, 1);
            assert.strictEqual(actions[0].title, InlineScriptStrings.setUpScriptEnvironment);
            assert.strictEqual(actions[0].command?.command, SETUP_COMMAND);
            assert.deepStrictEqual(actions[0].command?.arguments, [scriptUri]);
        });

        test('leaves diagnostics unset so VS Code is not told the action resolves them', () => {
            const actions = provide(makeDocument(scriptUri), [makeDiagnostic('reportMissingImports')]);

            assert.strictEqual(actions.length, 1);
            assert.strictEqual(
                actions[0].diagnostics,
                undefined,
                'setting diagnostics would claim the action fixes them and opt it into fix-all',
            );
        });

        test('leaves isPreferred unset so it never pre-empts a real import fix', () => {
            const actions = provide(makeDocument(scriptUri), [makeDiagnostic('reportMissingImports')]);

            assert.strictEqual(actions.length, 1);
            assert.strictEqual(actions[0].isPreferred, undefined);
        });

        test('offers nothing when no diagnostic reports an unresolved import', () => {
            const actions = provide(makeDocument(scriptUri), [makeDiagnostic('reportUndefinedVariable')]);

            assert.strictEqual(actions.length, 0);
        });

        test('offers nothing when there are no diagnostics at the invocation range', () => {
            const actions = provide(makeDocument(scriptUri), []);

            assert.strictEqual(actions.length, 0);
        });

        test('offers nothing when the file has no PEP 723 block', () => {
            const actions = provide(makeDocument(scriptUri, SCRIPT_WITHOUT_METADATA), [
                makeDiagnostic('reportMissingImports'),
            ]);

            assert.strictEqual(actions.length, 0);
        });

        test('offers nothing when the PEP 723 block is malformed', () => {
            const malformed = ['# /// script', '# dependencies = [', '# ///', '', 'import requests', ''].join('\n');

            const actions = provide(makeDocument(scriptUri, malformed), [makeDiagnostic('reportMissingImports')]);

            assert.strictEqual(actions.length, 0);
        });

        test('offers nothing once the script is already set up', () => {
            routing.setMetadata(scriptUri, makeMetadata());
            routing.setValidatedAssociation(scriptUri, true);
            assert.strictEqual(routing.shouldRoute(scriptUri), true);

            const actions = provide(makeDocument(scriptUri), [makeDiagnostic('reportMissingImports')]);

            assert.strictEqual(actions.length, 0);
        });

        test('offers nothing when the inline-scripts feature flag is off', () => {
            featureEnabledStub.returns(false);

            const actions = provide(makeDocument(scriptUri), [makeDiagnostic('reportMissingImports')]);

            assert.strictEqual(actions.length, 0);
        });

        test('offers nothing for a file that cannot carry an inline-script environment', () => {
            const notebookUri = Uri.parse('vscode-notebook-cell:/workspace/app.py#ch0');

            const actions = provide(makeDocument(notebookUri), [makeDiagnostic('reportMissingImports')]);

            assert.strictEqual(actions.length, 0);
        });

        test('offers setup again after the metadata block is edited to add the missing dependency', () => {
            routing.setMetadata(scriptUri, makeMetadata());
            routing.setValidatedAssociation(scriptUri, true);
            assert.strictEqual(
                provide(makeDocument(scriptUri), [makeDiagnostic('reportMissingImports')]).length,
                0,
                'precondition: hidden while the script is set up',
            );

            routing.setMetadata(scriptUri, { ...makeMetadata(), dependencies: ['requests', 'rich'] });
            assert.strictEqual(routing.shouldRoute(scriptUri), false);

            const edited = ['# /// script', '# dependencies = ["requests", "rich"]', '# ///', '', 'import rich', ''].join(
                '\n',
            );
            const actions = provide(makeDocument(scriptUri, edited), [makeDiagnostic('reportMissingImports')]);

            assert.strictEqual(actions.length, 1);
            assert.strictEqual(actions[0].command?.command, SETUP_COMMAND);
        });

        test('parses the in-memory buffer, so it works on an unsaved edit the CodeLens cannot see', () => {
            assert.strictEqual(routing.getMetadata(scriptUri), undefined);

            const actions = provide(makeDocument(scriptUri), [makeDiagnostic('reportMissingImports')]);

            assert.strictEqual(actions.length, 1);
        });

        test('ignores a metadata block that sits past the header byte budget setup reads', () => {
            const padding = `${'# padding comment\n'.repeat(Math.ceil(MAX_HEADER_BYTES / 18) + 10)}`;
            const document = makeDocument(scriptUri, padding + SCRIPT_WITH_METADATA);

            const actions = provide(document, [makeDiagnostic('reportMissingImports')]);

            assert.strictEqual(
                actions.length,
                0,
                'setup reads only the first MAX_HEADER_BYTES from disk, so the block must be invisible here too',
            );
        });
    });
});
