import assert from 'assert';
import * as sinon from 'sinon';
import { PYLANCE_EXTENSION_ID, PYTHON_EXTENSION_ID } from '../../../common/constants';
import * as extensionApis from '../../../common/extension.apis';
import { getComparableExtensionVersion } from '../../../common/extVersion';
import { Common, InlineScriptStrings } from '../../../common/localize';
import * as persistentState from '../../../common/persistentState';
import * as windowApis from '../../../common/window.apis';
import * as workbenchCommands from '../../../common/workbenchCommands';
import * as workspaceApis from '../../../common/workspace.apis';
import {
    getOutdatedInlineScriptExtensions,
    INLINE_SCRIPT_UPDATE_EXTENSIONS_DONT_SHOW_KEY,
    promptUpdateExtensionsForInlineScripts,
    resetInlineScriptExtensionPromptForTests,
} from '../../../features/inlineScript/extensionVersionCheck';

suite('inlineScript extensionVersionCheck', () => {
    let getExtensionStub: sinon.SinonStub;
    let showWarningMessageStub: sinon.SinonStub;
    let openExtensionStub: sinon.SinonStub;
    let mockState: { get: sinon.SinonStub; set: sinon.SinonStub; clear: sinon.SinonStub };
    let languageServerSetting: string;

    /** Register an installed extension with `version`; pass `undefined` for "not installed". */
    function stubExtension(id: string, version: string | undefined): void {
        if (version === undefined) {
            getExtensionStub.withArgs(id).returns(undefined);
            return;
        }
        getExtensionStub.withArgs(id).returns({ id, packageJSON: { version } });
    }

    function outdatedIds(): string[] {
        return getOutdatedInlineScriptExtensions().map((e) => e.id);
    }

    setup(() => {
        resetInlineScriptExtensionPromptForTests();
        languageServerSetting = 'Default';
        getExtensionStub = sinon.stub(extensionApis, 'getExtension').returns(undefined);
        showWarningMessageStub = sinon.stub(windowApis, 'showWarningMessage').resolves(undefined);
        openExtensionStub = sinon.stub(workbenchCommands, 'openExtension').resolves();
        sinon.stub(workspaceApis, 'getConfiguration').returns({ get: () => languageServerSetting } as never);
        mockState = {
            get: sinon.stub().resolves(undefined),
            set: sinon.stub().resolves(),
            clear: sinon.stub().resolves(),
        };
        sinon.stub(persistentState, 'getGlobalPersistentState').resolves(mockState);
    });

    teardown(() => {
        sinon.restore();
        resetInlineScriptExtensionPromptForTests();
    });

    suite('getComparableExtensionVersion', () => {
        test('reports not-installed when the extension is absent', () => {
            assert.strictEqual(getComparableExtensionVersion('some.ext').kind, 'not-installed');
        });

        test('returns the raw version for a normal release', () => {
            stubExtension('some.ext', '2026.4.0');
            assert.deepStrictEqual(getComparableExtensionVersion('some.ext'), {
                kind: 'version',
                version: '2026.4.0',
            });
        });

        test('reports unknown for a local dev build', () => {
            stubExtension('some.ext', '9999.0.0-dev');
            assert.strictEqual(getComparableExtensionVersion('some.ext').kind, 'unknown');
        });

        test('reports unknown for a dev build that would otherwise sort as outdated', () => {
            stubExtension('some.ext', '2026.7.0-dev');
            assert.strictEqual(getComparableExtensionVersion('some.ext').kind, 'unknown');
        });

        test('reports unknown for an unparseable version', () => {
            stubExtension('some.ext', 'not-a-version');
            assert.strictEqual(getComparableExtensionVersion('some.ext').kind, 'unknown');
        });

        test('reports unknown when packageJSON carries no version', () => {
            getExtensionStub.withArgs('some.ext').returns({ id: 'some.ext', packageJSON: {} });
            assert.strictEqual(getComparableExtensionVersion('some.ext').kind, 'unknown');
        });
    });

    suite('Python channel thresholds', () => {
        setup(() => stubExtension(PYLANCE_EXTENSION_ID, undefined));

        test('current stable 2026.4.0 is outdated', () => {
            stubExtension(PYTHON_EXTENSION_ID, '2026.4.0');
            assert.deepStrictEqual(outdatedIds(), [PYTHON_EXTENSION_ID]);
        });

        test('older stable is outdated', () => {
            stubExtension(PYTHON_EXTENSION_ID, '2026.2.0');
            assert.deepStrictEqual(outdatedIds(), [PYTHON_EXTENSION_ID]);
        });

        test('a next stable below the pre-release line is accepted', () => {
            // 2026.6.0 sorts BELOW pre-release 2026.7.x, so a single threshold would wrongly reject it.
            stubExtension(PYTHON_EXTENSION_ID, '2026.6.0');
            assert.deepStrictEqual(outdatedIds(), []);
        });

        test('a next stable above the pre-release line is accepted', () => {
            stubExtension(PYTHON_EXTENSION_ID, '2026.8.0');
            assert.deepStrictEqual(outdatedIds(), []);
        });

        test('current pre-release 2026.7.2026082601 is outdated', () => {
            stubExtension(PYTHON_EXTENSION_ID, '2026.7.2026082601');
            assert.deepStrictEqual(outdatedIds(), [PYTHON_EXTENSION_ID]);
        });

        test('an older pre-release above the stable floor is still outdated', () => {
            // > 2026.4.0 numerically, but it is a pre-release and must use the pre-release floor.
            stubExtension(PYTHON_EXTENSION_ID, '2026.5.2026070801');
            assert.deepStrictEqual(outdatedIds(), [PYTHON_EXTENSION_ID]);
        });

        test('the next pre-release build is accepted', () => {
            stubExtension(PYTHON_EXTENSION_ID, '2026.7.2026090101');
            assert.deepStrictEqual(outdatedIds(), []);
        });
    });

    suite('Pylance channel thresholds', () => {
        setup(() => stubExtension(PYTHON_EXTENSION_ID, '2026.8.0'));

        test('current stable 2026.3.1 is outdated', () => {
            stubExtension(PYLANCE_EXTENSION_ID, '2026.3.1');
            assert.deepStrictEqual(outdatedIds(), [PYLANCE_EXTENSION_ID]);
        });

        test('a next stable is accepted', () => {
            stubExtension(PYLANCE_EXTENSION_ID, '2026.4.1');
            assert.deepStrictEqual(outdatedIds(), []);
        });

        test('pre-release 2026.3.101 is outdated', () => {
            stubExtension(PYLANCE_EXTENSION_ID, '2026.3.101');
            assert.deepStrictEqual(outdatedIds(), [PYLANCE_EXTENSION_ID]);
        });

        test('pre-release 2026.3.102 (verified to carry the change) is accepted', () => {
            stubExtension(PYLANCE_EXTENSION_ID, '2026.3.102');
            assert.deepStrictEqual(outdatedIds(), []);
        });

        test('an older pre-release above the stable floor is still outdated', () => {
            stubExtension(PYLANCE_EXTENSION_ID, '2026.3.100');
            assert.deepStrictEqual(outdatedIds(), [PYLANCE_EXTENSION_ID]);
        });
    });

    suite('getOutdatedInlineScriptExtensions', () => {
        test('returns nothing when both companions are current', () => {
            stubExtension(PYTHON_EXTENSION_ID, '2026.8.0');
            stubExtension(PYLANCE_EXTENSION_ID, '2026.3.102');
            assert.deepStrictEqual(outdatedIds(), []);
        });

        test('ignores extensions that are not installed', () => {
            stubExtension(PYTHON_EXTENSION_ID, undefined);
            stubExtension(PYLANCE_EXTENSION_ID, undefined);
            assert.deepStrictEqual(outdatedIds(), []);
        });

        test('ignores local dev builds of either companion', () => {
            stubExtension(PYTHON_EXTENSION_ID, '2026.7.0-dev');
            stubExtension(PYLANCE_EXTENSION_ID, '9999.0.0-dev');
            assert.deepStrictEqual(outdatedIds(), []);
        });

        test('flags both when both are behind', () => {
            stubExtension(PYTHON_EXTENSION_ID, '2026.7.2026082601');
            stubExtension(PYLANCE_EXTENSION_ID, '2026.3.101');
            assert.deepStrictEqual(outdatedIds(), [PYTHON_EXTENSION_ID, PYLANCE_EXTENSION_ID]);
        });

        test('skips Pylance entirely when it is not the configured language server', () => {
            languageServerSetting = 'None';
            stubExtension(PYTHON_EXTENSION_ID, '2026.7.2026082601');
            stubExtension(PYLANCE_EXTENSION_ID, '2026.3.101');
            assert.deepStrictEqual(outdatedIds(), [PYTHON_EXTENSION_ID]);
        });

        test('still checks Pylance when the language server is explicitly Pylance', () => {
            languageServerSetting = 'Pylance';
            stubExtension(PYTHON_EXTENSION_ID, '2026.8.0');
            stubExtension(PYLANCE_EXTENSION_ID, '2026.3.101');
            assert.deepStrictEqual(outdatedIds(), [PYLANCE_EXTENSION_ID]);
        });
    });

    suite('promptUpdateExtensionsForInlineScripts', () => {
        function stubOutdatedPython(): void {
            stubExtension(PYTHON_EXTENSION_ID, '2026.7.2026082601');
            stubExtension(PYLANCE_EXTENSION_ID, '2026.3.102');
        }

        test('does not warn when everything is current', async () => {
            stubExtension(PYTHON_EXTENSION_ID, '2026.8.0');
            stubExtension(PYLANCE_EXTENSION_ID, '2026.3.102');
            await promptUpdateExtensionsForInlineScripts();
            assert.strictEqual(showWarningMessageStub.callCount, 0);
        });

        test('warns with the Python-only message', async () => {
            stubOutdatedPython();
            await promptUpdateExtensionsForInlineScripts();
            assert.strictEqual(showWarningMessageStub.callCount, 1);
            const [message, ...actions] = showWarningMessageStub.firstCall.args;
            assert.strictEqual(message, InlineScriptStrings.updatePythonExtension);
            assert.deepStrictEqual(actions, [InlineScriptStrings.updateExtension, Common.dontShowAgain]);
        });

        test('uses the Pylance-only message when only Pylance is behind', async () => {
            stubExtension(PYTHON_EXTENSION_ID, '2026.8.0');
            stubExtension(PYLANCE_EXTENSION_ID, '2026.3.101');
            await promptUpdateExtensionsForInlineScripts();
            assert.strictEqual(showWarningMessageStub.firstCall.args[0], InlineScriptStrings.updatePylanceExtension);
        });

        test('uses the combined message when both are behind', async () => {
            stubExtension(PYTHON_EXTENSION_ID, '2026.7.2026082601');
            stubExtension(PYLANCE_EXTENSION_ID, '2026.3.101');
            await promptUpdateExtensionsForInlineScripts();
            assert.strictEqual(
                showWarningMessageStub.firstCall.args[0],
                InlineScriptStrings.updatePythonAndPylanceExtensions,
            );
        });

        test('does not mention Pylance when the language server is Jedi', async () => {
            languageServerSetting = 'Jedi';
            stubExtension(PYTHON_EXTENSION_ID, '2026.7.2026082601');
            stubExtension(PYLANCE_EXTENSION_ID, '2026.3.101');
            await promptUpdateExtensionsForInlineScripts();
            assert.strictEqual(showWarningMessageStub.firstCall.args[0], InlineScriptStrings.updatePythonExtension);
        });

        test('stays silent when only Pylance is behind and the language server is None', async () => {
            languageServerSetting = 'None';
            stubExtension(PYTHON_EXTENSION_ID, '2026.8.0');
            stubExtension(PYLANCE_EXTENSION_ID, '2026.3.101');
            await promptUpdateExtensionsForInlineScripts();
            assert.strictEqual(showWarningMessageStub.callCount, 0);
        });

        test('"Update Extension" opens the outdated extension page', async () => {
            stubOutdatedPython();
            showWarningMessageStub.resolves(InlineScriptStrings.updateExtension);
            await promptUpdateExtensionsForInlineScripts();
            assert.ok(openExtensionStub.calledOnceWith(PYTHON_EXTENSION_ID));
            assert.strictEqual(mockState.set.callCount, 0, 'opening the page must not suppress future prompts');
        });

        test('"Don\'t Show Again" persists the suppression flag', async () => {
            stubOutdatedPython();
            showWarningMessageStub.resolves(Common.dontShowAgain);
            await promptUpdateExtensionsForInlineScripts();
            assert.ok(mockState.set.calledOnceWith(INLINE_SCRIPT_UPDATE_EXTENSIONS_DONT_SHOW_KEY, true));
            assert.strictEqual(openExtensionStub.callCount, 0);
        });

        test('stays silent when the suppression flag is already set', async () => {
            stubOutdatedPython();
            mockState.get.withArgs(INLINE_SCRIPT_UPDATE_EXTENSIONS_DONT_SHOW_KEY).resolves(true);
            await promptUpdateExtensionsForInlineScripts();
            assert.strictEqual(showWarningMessageStub.callCount, 0);
        });

        test('shows at most once per session', async () => {
            stubOutdatedPython();
            await promptUpdateExtensionsForInlineScripts();
            await promptUpdateExtensionsForInlineScripts();
            await promptUpdateExtensionsForInlineScripts();
            assert.strictEqual(showWarningMessageStub.callCount, 1);
        });

        test('an up-to-date run does not consume the session prompt', async () => {
            stubExtension(PYTHON_EXTENSION_ID, '2026.8.0');
            stubExtension(PYLANCE_EXTENSION_ID, '2026.3.102');
            await promptUpdateExtensionsForInlineScripts();
            assert.strictEqual(showWarningMessageStub.callCount, 0);

            getExtensionStub.withArgs(PYTHON_EXTENSION_ID).returns({ packageJSON: { version: '2026.7.2026082601' } });
            await promptUpdateExtensionsForInlineScripts();
            assert.strictEqual(showWarningMessageStub.callCount, 1);
        });

        test('dismissing without choosing an action does not persist suppression', async () => {
            stubOutdatedPython();
            showWarningMessageStub.resolves(undefined);
            await promptUpdateExtensionsForInlineScripts();
            assert.strictEqual(mockState.set.callCount, 0);
        });
    });
});
