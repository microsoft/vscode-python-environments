import assert from 'assert';
import fsExtra from 'fs-extra';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { TextEditor, Uri, WorkspaceFolder } from 'vscode';
import { PythonProject } from '../../../api';
import { NEW_PROJECT_TEMPLATES_FOLDER } from '../../../common/constants';
import { readInlineScriptMetadata } from '../../../common/inlineScript/metadata';
import * as platformUtils from '../../../common/utils/platformUtils';
import * as windowApis from '../../../common/window.apis';
import * as workspaceApis from '../../../common/workspace.apis';
import * as creationHelpers from '../../../features/creators/creationHelpers';
import { NewScriptProject } from '../../../features/creators/newScriptProject';
import { PythonProjectManager } from '../../../internal.api';

// Path to the real script template, resolved from the compiled test location
// (out/test/features/creators/ → workspaceRoot/files/templates/...). We do NOT
// rely on `NEW_PROJECT_TEMPLATES_FOLDER` because it is anchored at
// `path.dirname(__dirname)` of the compiled `constants.js`, which resolves to
// `out/` in test mode and does not contain the bundled template tree.
const TEMPLATE_PATH = path.join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'files',
    'templates',
    'new723ScriptTemplate',
    'script.py',
);

function asRemoteUri(fsPath: string, authority = 'ssh-remote+test-host'): Uri {
    return Uri.from({
        scheme: 'vscode-remote',
        authority,
        path: Uri.file(fsPath).path,
    });
}

suite('new723ScriptTemplate / NewScriptProject', () => {
    let tmpDir: string;
    let getWorkspaceFolderStub: sinon.SinonStub;
    let getWorkspaceFoldersStub: sinon.SinonStub;
    let workspaceFolder: WorkspaceFolder;

    setup(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'new-script-test-'));
        workspaceFolder = {
            index: 0,
            name: 'test-workspace',
            uri: Uri.file(tmpDir),
        };
        getWorkspaceFolderStub = sinon.stub(workspaceApis, 'getWorkspaceFolder').returns(workspaceFolder);
        getWorkspaceFoldersStub = sinon.stub(workspaceApis, 'getWorkspaceFolders').returns([workspaceFolder]);
    });

    teardown(async () => {
        sinon.restore();
        await fs.remove(tmpDir);
    });

    function stubSuccessfulFileCreation() {
        const showTextDocumentStub = sinon
            .stub(windowApis, 'showTextDocument')
            .resolves({} as TextEditor);
        const pathExistsStub = sinon.stub(fsExtra, 'pathExists');
        pathExistsStub.onFirstCall().resolves(true);
        pathExistsStub.onSecondCall().resolves(false);
        const copyStub = sinon.stub(fsExtra, 'copy').callsFake(async (_source, destination) => {
            await fs.copyFile(TEMPLATE_PATH, destination);
        });
        const replaceStub = sinon.stub(creationHelpers, 'replaceInFilesAndNames').resolves();
        const instructionsStub = sinon.stub(creationHelpers, 'manageCopilotInstructionsFile').resolves();
        return { copyStub, instructionsStub, replaceStub, showTextDocumentStub };
    }

    async function createDirectoryLink(target: string, link: string): Promise<boolean> {
        try {
            await fs.symlink(target, link, platformUtils.isWindows() ? 'junction' : 'dir');
            return true;
        } catch {
            await fs.ensureDir(link);
            return false;
        }
    }

    test('shipped template contains parseable PEP 723 metadata', async () => {
        const contents = await fs.readFile(TEMPLATE_PATH, 'utf8');
        const metadata = readInlineScriptMetadata(contents);

        assert.ok(metadata, 'Template must contain valid PEP 723 metadata');
        assert.strictEqual(metadata.range.start, 0, 'PEP 723 metadata should be at the start of the template');
        assert.strictEqual(metadata.requiresPython, '>=3.9');
        assert.notStrictEqual(metadata.dependencies, undefined, 'Template should declare dependencies');
        assert.deepStrictEqual(metadata.dependencies, []);
        assert.strictEqual(metadata.tool, undefined);
    });

    test('interactive filename validation rejects unsafe names and accepts a valid name', async () => {
        const addStub = sinon.stub().resolves();
        const creator = new NewScriptProject({ add: addStub } as unknown as PythonProjectManager);
        const promptStub = sinon.stub(windowApis, 'showInputBoxWithButtons').callsFake(async (options) => {
            const validateInput = options?.validateInput;
            assert.ok(validateInput);
            assert.strictEqual(typeof (await validateInput('../escape.py')), 'string');
            assert.strictEqual(typeof (await validateInput('nested/script.py')), 'string');
            assert.strictEqual(typeof (await validateInput('script')), 'string');
            assert.strictEqual(typeof (await validateInput('invalid name.py')), 'string');
            assert.strictEqual(await validateInput('valid_script.py'), null);
            return undefined;
        });

        const result = await creator.create();

        assert.strictEqual(result, undefined);
        assert.ok(promptStub.calledOnce);
        assert.strictEqual(addStub.called, false);
    });

    test('Windows filename validation rejects reserved device names and accepts similar names', async () => {
        sinon.stub(platformUtils, 'isWindows').returns(true);
        const creator = new NewScriptProject({ add: sinon.stub().resolves() } as unknown as PythonProjectManager);
        sinon.stub(windowApis, 'showInputBoxWithButtons').callsFake(async (options) => {
            const validateInput = options?.validateInput;
            assert.ok(validateInput);
            const reservedNames = [
                'CON.py',
                'prn.py',
                'Aux.data.py',
                'nul.foo.py',
                ...Array.from({ length: 9 }, (_, index) => `cOm${index + 1}.py`),
                ...Array.from({ length: 9 }, (_, index) => `LpT${index + 1}.extra.py`),
            ];
            for (const reservedName of reservedNames) {
                assert.strictEqual(
                    typeof (await validateInput(reservedName)),
                    'string',
                    `${reservedName} should be rejected on Windows`,
                );
            }
            for (const validName of ['console.py', 'com10.py', 'lpt10.py']) {
                assert.strictEqual(
                    await validateInput(validName),
                    null,
                    `${validName} should remain valid on Windows`,
                );
            }
            return undefined;
        });

        assert.strictEqual(await creator.create(), undefined);
        await assert.rejects(
            creator.create({
                name: 'cOn',
                quickCreate: true,
                rootUri: Uri.file(tmpDir),
            }),
            /reserved Windows device name/,
        );
    });

    test('non-Windows filename validation allows Windows device names', async () => {
        sinon.stub(platformUtils, 'isWindows').returns(false);
        const creator = new NewScriptProject({ add: sinon.stub().resolves() } as unknown as PythonProjectManager);
        sinon.stub(windowApis, 'showInputBoxWithButtons').callsFake(async (options) => {
            const validateInput = options?.validateInput;
            assert.ok(validateInput);
            assert.strictEqual(await validateInput('CON.py'), null);
            assert.strictEqual(await validateInput('con.foo.py'), null);
            return undefined;
        });

        assert.strictEqual(await creator.create(), undefined);
    });

    test('quick create rejects a traversal name without prompting', async () => {
        const addStub = sinon.stub().resolves();
        const creator = new NewScriptProject({ add: addStub } as unknown as PythonProjectManager);
        const promptStub = sinon.stub(windowApis, 'showInputBoxWithButtons');
        const showTextDocumentStub = sinon.stub(windowApis, 'showTextDocument');

        await assert.rejects(
            creator.create({
                name: '../escape.py',
                quickCreate: true,
                rootUri: Uri.file(tmpDir),
            }),
            /path separators or traversal/,
        );

        assert.strictEqual(promptStub.called, false);
        assert.strictEqual(addStub.called, false);
        assert.strictEqual(showTextDocumentStub.called, false);
    });

    test('quick create appends .py to a safe extensionless base name', async () => {
        const rootUri = Uri.file(tmpDir);
        const scriptDestination = path.resolve(rootUri.fsPath, 'hello_world.py');
        const addStub = sinon.stub().resolves();
        const creator = new NewScriptProject({ add: addStub } as unknown as PythonProjectManager);
        const promptStub = sinon.stub(windowApis, 'showInputBoxWithButtons');
        const { showTextDocumentStub } = stubSuccessfulFileCreation();

        const result = await creator.create({
            name: 'hello_world',
            quickCreate: true,
            rootUri,
        });

        assert.ok(result);
        const createdScript = result as PythonProject;
        assert.strictEqual(createdScript.name, 'hello_world.py');
        assert.strictEqual(createdScript.uri.fsPath, Uri.file(scriptDestination).fsPath);
        assert.strictEqual(promptStub.called, false);
        assert.ok(addStub.calledOnceWithExactly(createdScript));
        assert.ok(showTextDocumentStub.calledOnceWithExactly(createdScript.uri));
    });

    test('quick create rejects a non-Python extension without prompting', async () => {
        const addStub = sinon.stub().resolves();
        const creator = new NewScriptProject({ add: addStub } as unknown as PythonProjectManager);
        const promptStub = sinon.stub(windowApis, 'showInputBoxWithButtons');
        const showTextDocumentStub = sinon.stub(windowApis, 'showTextDocument');

        await assert.rejects(
            creator.create({
                name: 'hello_world.txt',
                quickCreate: true,
                rootUri: Uri.file(tmpDir),
            }),
            /must end with ".py"/,
        );

        assert.strictEqual(promptStub.called, false);
        assert.strictEqual(addStub.called, false);
        assert.strictEqual(showTextDocumentStub.called, false);
    });

    test('quick create accepts a valid name inside an open workspace without prompting', async () => {
        const scriptFileName = 'quick_script.py';
        const rootUri = Uri.file(tmpDir);
        const scriptDestination = path.resolve(rootUri.fsPath, scriptFileName);
        const expectedTemplatePath = path.join(
            NEW_PROJECT_TEMPLATES_FOLDER,
            'new723ScriptTemplate',
            'script.py',
        );
        const addStub = sinon.stub().resolves();
        const projectManager = { add: addStub } as unknown as PythonProjectManager;
        const creator = new NewScriptProject(projectManager);

        const promptStub = sinon.stub(windowApis, 'showInputBoxWithButtons');
        const { copyStub, instructionsStub, replaceStub, showTextDocumentStub } = stubSuccessfulFileCreation();

        const result = await creator.create({
            name: scriptFileName,
            quickCreate: true,
            rootUri,
        });

        assert.ok(result);
        const createdScript = result as PythonProject;
        assert.strictEqual(createdScript.name, scriptFileName);
        assert.strictEqual(createdScript.uri.fsPath, Uri.file(scriptDestination).fsPath);
        assert.strictEqual(await fs.readFile(scriptDestination, 'utf8'), await fs.readFile(TEMPLATE_PATH, 'utf8'));
        assert.strictEqual(promptStub.called, false, 'quick create must not prompt for a script name');
        assert.ok(getWorkspaceFolderStub.calledOnce);
        assert.strictEqual(
            getWorkspaceFolderStub.firstCall.args[0].fsPath,
            Uri.file(path.resolve(rootUri.fsPath)).fsPath,
        );
        assert.ok(copyStub.calledOnce);
        assert.strictEqual(copyStub.firstCall.args[0], expectedTemplatePath);
        assert.strictEqual(copyStub.firstCall.args[1], scriptDestination);
        assert.ok(
            replaceStub.calledOnceWithExactly(scriptDestination, 'script_name', 'quick_script'),
            'template substitution should run',
        );
        assert.ok(addStub.calledOnceWithExactly(createdScript), 'created script should be added as a project');
        assert.ok(
            showTextDocumentStub.calledOnceWithExactly(createdScript.uri),
            'created script should be opened in the editor',
        );
        assert.ok(
            instructionsStub.calledOnceWithExactly(
                rootUri.fsPath,
                path.join(
                    NEW_PROJECT_TEMPLATES_FOLDER,
                    'copilot-instructions-text',
                    'script-copilot-instructions.md',
                ),
                [{ searchValue: '<script_name>', replaceValue: scriptFileName }],
            ),
            'quick create should retain Copilot-instruction handling',
        );
    });

    test('interactive fallback preserves a remote workspace URI', async () => {
        const remoteWorkspaceUri = asRemoteUri(tmpDir);
        workspaceFolder = {
            index: 0,
            name: 'remote-workspace',
            uri: remoteWorkspaceUri,
        };
        getWorkspaceFoldersStub.returns([workspaceFolder]);
        getWorkspaceFolderStub.callsFake((uri: Uri) =>
            uri.toString() === remoteWorkspaceUri.toString() ? workspaceFolder : undefined,
        );
        sinon.stub(windowApis, 'showInputBoxWithButtons').resolves('remote_script.py');
        const { showTextDocumentStub } = stubSuccessfulFileCreation();
        const addStub = sinon.stub().resolves();
        const creator = new NewScriptProject({ add: addStub } as unknown as PythonProjectManager);

        const result = await creator.create();

        assert.ok(result);
        const createdScript = result as PythonProject;
        assert.strictEqual(getWorkspaceFolderStub.firstCall.args[0].toString(), remoteWorkspaceUri.toString());
        assert.strictEqual(createdScript.uri.scheme, remoteWorkspaceUri.scheme);
        assert.strictEqual(createdScript.uri.authority, remoteWorkspaceUri.authority);
        assert.strictEqual(createdScript.uri.fsPath, Uri.file(path.join(tmpDir, 'remote_script.py')).fsPath);
        assert.ok(addStub.calledOnceWithExactly(createdScript));
        assert.ok(showTextDocumentStub.calledOnceWithExactly(createdScript.uri));
    });

    test('quick file root matches by fsPath and retains the remote workspace URI identity', async () => {
        const nestedRoot = path.join(tmpDir, 'nested');
        await fs.ensureDir(nestedRoot);
        const remoteWorkspaceUri = asRemoteUri(tmpDir, 'dev-container+test');
        workspaceFolder = {
            index: 0,
            name: 'remote-workspace',
            uri: remoteWorkspaceUri,
        };
        getWorkspaceFolderStub.returns(undefined);
        getWorkspaceFoldersStub.returns([workspaceFolder]);
        const rootUri = Uri.file(nestedRoot);
        const { showTextDocumentStub } = stubSuccessfulFileCreation();
        const addStub = sinon.stub().resolves();
        const creator = new NewScriptProject({ add: addStub } as unknown as PythonProjectManager);

        const result = await creator.create({
            name: 'remote_quick',
            quickCreate: true,
            rootUri,
        });

        assert.ok(result);
        const createdScript = result as PythonProject;
        assert.strictEqual(getWorkspaceFolderStub.firstCall.args[0].toString(), rootUri.toString());
        assert.strictEqual(createdScript.uri.scheme, remoteWorkspaceUri.scheme);
        assert.strictEqual(createdScript.uri.authority, remoteWorkspaceUri.authority);
        assert.strictEqual(createdScript.uri.fsPath, Uri.file(path.join(nestedRoot, 'remote_quick.py')).fsPath);
        assert.ok(addStub.calledOnceWithExactly(createdScript));
        assert.ok(showTextDocumentStub.calledOnceWithExactly(createdScript.uri));
    });

    test('quick and programmatic roots outside the workspace are rejected before file creation', async () => {
        const outsideRoot = Uri.file(path.join(tmpDir, 'outside'));
        getWorkspaceFolderStub.returns(undefined);
        getWorkspaceFoldersStub.returns([]);
        sinon.stub(fsExtra, 'pathExists').resolves(true);
        const copyStub = sinon.stub(fsExtra, 'copy').resolves();
        const replaceStub = sinon.stub(creationHelpers, 'replaceInFilesAndNames').resolves();
        const instructionsStub = sinon.stub(creationHelpers, 'manageCopilotInstructionsFile').resolves();
        const showTextDocumentStub = sinon.stub(windowApis, 'showTextDocument');
        const showErrorMessageStub = sinon.stub(windowApis, 'showErrorMessage');
        const addStub = sinon.stub().resolves();
        const creator = new NewScriptProject({ add: addStub } as unknown as PythonProjectManager);

        const quickResult = await creator.create({
            name: 'quick_outside.py',
            quickCreate: true,
            rootUri: outsideRoot,
        });
        const programmaticResult = await creator.create({
            name: 'programmatic_outside.py',
            rootUri: outsideRoot,
        });

        assert.strictEqual(quickResult, undefined);
        assert.strictEqual(programmaticResult, undefined);
        assert.strictEqual(getWorkspaceFolderStub.callCount, 2);
        assert.strictEqual(showErrorMessageStub.callCount, 2);
        assert.strictEqual(copyStub.called, false);
        assert.strictEqual(replaceStub.called, false);
        assert.strictEqual(addStub.called, false);
        assert.strictEqual(instructionsStub.called, false);
        assert.strictEqual(showTextDocumentStub.called, false);
    });

    test('a symlinked workspace root remains a valid destination', async () => {
        const physicalWorkspaceRoot = path.join(tmpDir, 'physical-workspace');
        const linkedWorkspaceRoot = path.join(tmpDir, 'linked-workspace');
        const nestedRoot = path.join(linkedWorkspaceRoot, 'nested');
        await fs.ensureDir(path.join(physicalWorkspaceRoot, 'nested'));
        await createDirectoryLink(physicalWorkspaceRoot, linkedWorkspaceRoot);
        await fs.ensureDir(nestedRoot);
        workspaceFolder = {
            index: 0,
            name: 'linked-workspace',
            uri: Uri.file(linkedWorkspaceRoot),
        };
        getWorkspaceFolderStub.returns(workspaceFolder);
        getWorkspaceFoldersStub.returns([workspaceFolder]);
        const { copyStub, showTextDocumentStub } = stubSuccessfulFileCreation();
        const addStub = sinon.stub().resolves();
        const creator = new NewScriptProject({ add: addStub } as unknown as PythonProjectManager);

        const result = await creator.create({
            name: 'linked_workspace.py',
            quickCreate: true,
            rootUri: Uri.file(nestedRoot),
        });

        assert.ok(result);
        const createdScript = result as PythonProject;
        assert.strictEqual(createdScript.uri.fsPath, Uri.file(path.join(nestedRoot, 'linked_workspace.py')).fsPath);
        assert.ok(copyStub.calledOnce);
        assert.ok(addStub.calledOnceWithExactly(createdScript));
        assert.ok(showTextDocumentStub.calledOnceWithExactly(createdScript.uri));
    });

    test('a destination that physically escapes the workspace is rejected before writing', async () => {
        const workspaceRoot = path.join(tmpDir, 'workspace');
        const outsideRoot = path.join(tmpDir, 'outside');
        const linkedDestination = path.join(workspaceRoot, 'linked-outside');
        await fs.ensureDir(workspaceRoot);
        await fs.ensureDir(outsideRoot);

        // Simulate a destination that is lexically inside the workspace but whose
        // real path (via a symlink/junction) resolves outside of it.
        const realpathStub = sinon.stub(fsExtra, 'realpath') as sinon.SinonStub;
        realpathStub.callsFake(async (targetPath: string) => {
            const resolved = path.resolve(String(targetPath));
            if (path.relative(resolved, path.resolve(linkedDestination)) === '') {
                return path.resolve(outsideRoot);
            }
            if (path.relative(resolved, path.resolve(workspaceRoot)) === '') {
                return path.resolve(workspaceRoot);
            }
            throw new Error(`Unexpected realpath: ${targetPath}`);
        });

        workspaceFolder = {
            index: 0,
            name: 'test-workspace',
            uri: Uri.file(workspaceRoot),
        };
        getWorkspaceFolderStub.returns(workspaceFolder);
        getWorkspaceFoldersStub.returns([workspaceFolder]);
        sinon.stub(fsExtra, 'pathExists').resolves(true);
        const copyStub = sinon.stub(fsExtra, 'copy').resolves();
        const replaceStub = sinon.stub(creationHelpers, 'replaceInFilesAndNames').resolves();
        const instructionsStub = sinon.stub(creationHelpers, 'manageCopilotInstructionsFile').resolves();
        const showTextDocumentStub = sinon.stub(windowApis, 'showTextDocument');
        const showErrorMessageStub = sinon.stub(windowApis, 'showErrorMessage');
        const addStub = sinon.stub().resolves();
        const creator = new NewScriptProject({ add: addStub } as unknown as PythonProjectManager);

        const result = await creator.create({
            name: 'escaped.py',
            quickCreate: true,
            rootUri: Uri.file(linkedDestination),
        });

        assert.strictEqual(result, undefined);
        assert.ok(showErrorMessageStub.calledOnce);
        assert.strictEqual(copyStub.called, false);
        assert.strictEqual(replaceStub.called, false);
        assert.strictEqual(addStub.called, false);
        assert.strictEqual(instructionsStub.called, false);
        assert.strictEqual(showTextDocumentStub.called, false);
    });

    test('create waits for project registration before opening and returning', async () => {
        const scriptFileName = 'wait_for_registration.py';
        const rootUri = Uri.file(tmpDir);
        const { showTextDocumentStub } = stubSuccessfulFileCreation();
        const promptStub = sinon.stub(windowApis, 'showInputBoxWithButtons');
        let notifyAddStarted!: () => void;
        let releaseRegistration!: () => void;
        const addStarted = new Promise<void>((resolve) => {
            notifyAddStarted = resolve;
        });
        const registration = new Promise<void>((resolve) => {
            releaseRegistration = resolve;
        });
        const addStub = sinon.stub().callsFake(async () => {
            notifyAddStarted();
            await registration;
        });
        const creator = new NewScriptProject({ add: addStub } as unknown as PythonProjectManager);

        const createPromise = creator.create({
            name: scriptFileName,
            quickCreate: true,
            rootUri,
        });
        let createSettled = false;
        const trackedCreate = createPromise.finally(() => {
            createSettled = true;
        });
        await addStarted;
        await Promise.resolve();

        assert.strictEqual(createSettled, false, 'create should remain pending while project registration is pending');
        assert.strictEqual(showTextDocumentStub.called, false, 'the script must not open before registration completes');
        assert.strictEqual(promptStub.called, false);

        releaseRegistration();
        const result = await trackedCreate;

        assert.ok(result);
        assert.ok(addStub.calledOnce);
        assert.ok(showTextDocumentStub.calledOnce);
    });

    test('an insert-then-reject registration rolls back creator side effects and preserves the error', async () => {
        const rootUri = Uri.file(tmpDir);
        const scriptDestination = path.resolve(rootUri.fsPath, 'registration_failure.py');
        const { instructionsStub, showTextDocumentStub } = stubSuccessfulFileCreation();
        const promptStub = sinon.stub(windowApis, 'showInputBoxWithButtons');
        const projects: PythonProject[] = [];
        const registrationError = new Error('registration failed after insertion');
        const addStub = sinon.stub().callsFake(async (project: PythonProject) => {
            projects.push(project);
            throw registrationError;
        });
        const removeStub = sinon.stub().callsFake((project: PythonProject) => {
            const index = projects.indexOf(project);
            if (index >= 0) {
                projects.splice(index, 1);
            }
        });
        const creator = new NewScriptProject({
            add: addStub,
            remove: removeStub,
        } as unknown as PythonProjectManager);

        await assert.rejects(
            creator.create({
                name: 'registration_failure.py',
                quickCreate: true,
                rootUri,
            }),
            (error: unknown) => error === registrationError,
        );

        assert.ok(addStub.calledOnce);
        assert.ok(removeStub.calledOnceWithExactly(addStub.firstCall.args[0]));
        assert.deepStrictEqual(projects, []);
        await assert.rejects(fs.readFile(scriptDestination), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
        assert.strictEqual(showTextDocumentStub.called, false);
        assert.strictEqual(instructionsStub.called, false);
        assert.strictEqual(promptStub.called, false);
    });
});
