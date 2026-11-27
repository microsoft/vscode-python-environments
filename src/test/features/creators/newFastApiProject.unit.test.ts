import assert from 'assert';
import fsExtra from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { commands, l10n, QuickInputButtons, Uri, window, workspace, WorkspaceFolder } from 'vscode';
import { PythonEnvironment, PythonProject, PythonProjectCreatorOptions } from '../../../api';
import { NEW_PROJECT_TEMPLATES_FOLDER, VENV_MANAGER_ID } from '../../../common/constants';
import * as windowApis from '../../../common/window.apis';
import * as creationHelpers from '../../../features/creators/creationHelpers';
import {
    FAST_API_CREATOR_NAME,
    FAST_API_PROJECT_TYPE,
    NewFastApiProject,
    validateFastApiProjectName,
} from '../../../features/creators/newFastApiProject';
import { creatorNameForQuickCreateProjectType } from '../../../features/creators/projectCreators';
import type { EnvironmentManagers } from '../../../features/envManagers';
import type { PythonProjectManager } from '../../../features/projectManager';

// Real template, resolved from the compiled test location
// (out/test/features/creators/ → workspaceRoot/files/templates/...). Unit tests do not
// use NEW_PROJECT_TEMPLATES_FOLDER for file contents: that path is anchored at `out/`.
const TEMPLATE_PATH = path.join(__dirname, '..', '..', '..', '..', 'files', 'templates', 'newFastApiTemplate');
const COPILOT_INSTRUCTIONS_PATH = path.join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'files',
    'templates',
    'copilot-instructions-text',
    'fastapi-copilot-instructions.md',
);

function createEnvironment(): PythonEnvironment {
    return { envId: { id: 'fastapi-env' } } as unknown as PythonEnvironment;
}

function createManagers(options?: {
    supportsQuickCreate?: boolean;
    supportsCreate?: boolean;
    includeVenvFallback?: boolean;
    environment?: PythonEnvironment | undefined;
}): {
    envManagers: EnvironmentManagers;
    defaultCreate: sinon.SinonStub;
    venvCreate: sinon.SinonStub;
    getEnvironment: sinon.SinonStub;
    setEnvironment: sinon.SinonStub;
} {
    const environment = options && 'environment' in options ? options.environment : createEnvironment();
    const defaultCreate = sinon.stub().resolves(environment);
    const venvCreate = sinon.stub().resolves(environment ?? createEnvironment());
    const defaultManager = {
        id: 'default-manager',
        supportsQuickCreate: options?.supportsQuickCreate ?? true,
        supportsCreate: options?.supportsCreate ?? true,
        create: defaultCreate,
    };
    const venvManager = {
        id: VENV_MANAGER_ID,
        supportsQuickCreate: true,
        supportsCreate: true,
        create: venvCreate,
    };
    const getEnvironment = sinon.stub().resolves(environment);
    const setEnvironment = sinon.stub().resolves();
    const envManagers = {
        getEnvironmentManager: sinon.stub().returns(defaultManager),
        managers: options?.includeVenvFallback ? [defaultManager, venvManager] : [defaultManager],
        getEnvironment,
        setEnvironment,
    } as unknown as EnvironmentManagers;
    return { envManagers, defaultCreate, venvCreate, getEnvironment, setEnvironment };
}

function asProject(created: PythonProject | Uri | undefined): PythonProject {
    assert.ok(created);
    assert.ok('uri' in created);
    return created;
}

async function collectFiles(root: string): Promise<string[]> {
    const entries = await fsExtra.readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await collectFiles(fullPath)));
        } else {
            files.push(fullPath);
        }
    }
    return files;
}

suite('FastAPI quick-create project type', () => {
    test('maps built-in project types onto creator names', () => {
        assert.strictEqual(creatorNameForQuickCreateProjectType('python-package'), 'newPackage');
        assert.strictEqual(creatorNameForQuickCreateProjectType('python-script'), 'newScript');
        assert.strictEqual(creatorNameForQuickCreateProjectType(FAST_API_PROJECT_TYPE), FAST_API_CREATOR_NAME);
        assert.strictEqual(creatorNameForQuickCreateProjectType('python-unknown'), undefined);
    });
});

suite('newFastApiTemplate / NewFastApiProject', () => {
    let tmpDir: string;
    let workspaceFolders: readonly WorkspaceFolder[] | undefined;
    let previousWorkspaceFolders: PropertyDescriptor | undefined;
    let previousShowError: unknown;
    let previousExecuteCommand: unknown;
    let showError: sinon.SinonStub;

    setup(async () => {
        tmpDir = await fsExtra.mkdtemp(path.join(os.tmpdir(), 'new-fastapi-test-'));
        workspaceFolders = [
            {
                index: 0,
                name: 'test-workspace',
                uri: Uri.file(tmpDir),
            },
        ];
        previousWorkspaceFolders = Object.getOwnPropertyDescriptor(workspace, 'workspaceFolders');
        Object.defineProperty(workspace, 'workspaceFolders', {
            configurable: true,
            get: () => workspaceFolders,
        });
        previousShowError = (window as unknown as { showErrorMessage?: unknown }).showErrorMessage;
        previousExecuteCommand = (commands as unknown as { executeCommand?: unknown }).executeCommand;
        showError = sinon.stub().resolves(undefined);
        (window as unknown as { showErrorMessage: sinon.SinonStub }).showErrorMessage = showError;
    });

    teardown(async () => {
        sinon.restore();
        (window as unknown as { showErrorMessage?: unknown }).showErrorMessage = previousShowError;
        (commands as unknown as { executeCommand?: unknown }).executeCommand = previousExecuteCommand;
        if (previousWorkspaceFolders) {
            Object.defineProperty(workspace, 'workspaceFolders', previousWorkspaceFolders);
        }
        await fsExtra.remove(tmpDir);
    });

    function stubExecuteCommand(): sinon.SinonStub {
        const execute = sinon.stub().resolves(undefined);
        (commands as unknown as { executeCommand: sinon.SinonStub }).executeCommand = execute;
        return execute;
    }

    function useRealTemplateCopy(): { instructions: sinon.SinonStub } {
        const compiledTemplate = path.resolve(path.join(NEW_PROJECT_TEMPLATES_FOLDER, 'newFastApiTemplate'));
        const originalPathExists = fsExtra.pathExists.bind(fsExtra);
        const originalCopy = fsExtra.copy.bind(fsExtra);
        sinon.stub(fsExtra, 'pathExists').callsFake(async (checkedPath: fsExtra.PathLike) => {
            if (path.resolve(String(checkedPath)) === compiledTemplate) {
                return true;
            }
            return originalPathExists(String(checkedPath));
        });
        sinon.stub(fsExtra, 'copy').callsFake(async (source, destination, options) => {
            const resolvedSource = path.resolve(String(source));
            if (resolvedSource === compiledTemplate) {
                await originalCopy(TEMPLATE_PATH, destination, options);
                return;
            }
            await originalCopy(source, destination, options);
        });
        return {
            instructions: sinon.stub(creationHelpers, 'manageCopilotInstructionsFile').resolves(),
        };
    }

    test('shipped template is a FastAPI application with a runnable module and test', async () => {
        const pyproject = await fsExtra.readFile(path.join(TEMPLATE_PATH, 'pyproject.toml'), 'utf8');
        const main = await fsExtra.readFile(path.join(TEMPLATE_PATH, 'package_name', 'main.py'), 'utf8');
        const entry = await fsExtra.readFile(path.join(TEMPLATE_PATH, 'package_name', '__main__.py'), 'utf8');
        const testFile = await fsExtra.readFile(path.join(TEMPLATE_PATH, 'tests', 'test_package_name.py'), 'utf8');
        const devRequirements = await fsExtra.readFile(path.join(TEMPLATE_PATH, 'dev-requirements.txt'), 'utf8');
        const instructions = await fsExtra.readFile(COPILOT_INSTRUCTIONS_PATH, 'utf8');

        assert.match(pyproject, /name = "package_name"/);
        assert.match(pyproject, /"fastapi"/);
        assert.match(pyproject, /"uvicorn\[standard\]"/);
        assert.match(pyproject, /package_name = "package_name\.__main__:main"/);
        assert.match(main, /FastAPI\(\)/);
        assert.match(main, /@app\.get\("\/"\)/);
        assert.match(entry, /from package_name\.main import app/);
        assert.match(entry, /uvicorn\.run\(app,/);
        assert.match(testFile, /TestClient/);
        assert.match(testFile, /from package_name\.main import app/);
        assert.match(devRequirements, /^pytest$/m);
        assert.match(devRequirements, /^httpx$/m);
        assert.match(instructions, /uvicorn <package_name>\.main:app --reload/);
        assert.strictEqual(await fsExtra.pathExists(path.join(TEMPLATE_PATH, 'package_name', '__init__.py')), true);
    });

    test('accepts PEP 508-style names and rejects unsafe ones', () => {
        for (const validName of ['a', 'my_api', 'MyAPI', 'my-api', 'a.b', 'package_name']) {
            assert.strictEqual(validateFastApiProjectName(validName), null, validName);
        }
        assert.strictEqual(typeof validateFastApiProjectName(''), 'string');
        assert.strictEqual(typeof validateFastApiProjectName('1'), 'string');
        assert.strictEqual(typeof validateFastApiProjectName('my api'), 'string');
        assert.strictEqual(typeof validateFastApiProjectName('my/api'), 'string');
        assert.strictEqual(typeof validateFastApiProjectName('-api'), 'string');
        assert.strictEqual(typeof validateFastApiProjectName('api-'), 'string');
        assert.match(validateFastApiProjectName('_') ?? '', /Single-character project names/);
    });

    test('creator is offered as FastAPI and supports quick create', () => {
        const creator = new NewFastApiProject({} as EnvironmentManagers, {} as PythonProjectManager);

        assert.strictEqual(creator.name, FAST_API_CREATOR_NAME);
        assert.strictEqual(creator.displayName, 'FastAPI');
        assert.strictEqual(creator.supportsQuickCreate, true);
        assert.match(creator.description ?? '', /FastAPI/);
    });

    test('quick create scaffolds the project, environment, launch config, and copilot instructions', async () => {
        const { instructions } = useRealTemplateCopy();
        const { envManagers, defaultCreate, setEnvironment } = createManagers();
        const add = sinon.stub().resolves();
        const creator = new NewFastApiProject(envManagers, { add } as unknown as PythonProjectManager);

        const created = asProject(
            await creator.create({
                quickCreate: true,
                name: 'my_api',
                rootUri: Uri.file(tmpDir),
            }),
        );

        const projectFolder = path.join(tmpDir, 'my_api_project');
        assert.strictEqual(created.name, 'my_api');
        assert.strictEqual(created.uri.fsPath, projectFolder);
        assert.strictEqual(add.calledOnce, true);
        assert.strictEqual(add.firstCall.args[0].uri.fsPath, projectFolder);

        const files = await collectFiles(projectFolder);
        for (const file of files) {
            const contents = await fsExtra.readFile(file, 'utf8');
            assert.strictEqual(contents.includes('package_name'), false, file);
        }
        const main = await fsExtra.readFile(path.join(projectFolder, 'my_api', 'main.py'), 'utf8');
        const entry = await fsExtra.readFile(path.join(projectFolder, 'my_api', '__main__.py'), 'utf8');
        const pyproject = await fsExtra.readFile(path.join(projectFolder, 'pyproject.toml'), 'utf8');
        assert.match(main, /FastAPI\(\)/);
        assert.match(entry, /from my_api\.main import app/);
        assert.match(pyproject, /name = "my_api"/);
        assert.match(pyproject, /my_api = "my_api\.__main__:main"/);
        assert.strictEqual(await fsExtra.pathExists(path.join(projectFolder, 'tests', 'test_my_api.py')), true);

        sinon.assert.calledOnce(defaultCreate);
        assert.strictEqual(defaultCreate.firstCall.args[1].quickCreate, true);
        sinon.assert.calledOnce(setEnvironment);

        const launchJson = JSON.parse(await fsExtra.readFile(path.join(tmpDir, '.vscode', 'launch.json'), 'utf8'));
        assert.strictEqual(launchJson.configurations[0].name, 'Python: FastAPI (my_api)');
        assert.strictEqual(launchJson.configurations[0].module, 'uvicorn');
        assert.deepStrictEqual(launchJson.configurations[0].args, ['my_api.main:app']);

        sinon.assert.calledOnce(instructions);
        assert.strictEqual(path.basename(instructions.firstCall.args[1]), 'fastapi-copilot-instructions.md');
        assert.deepStrictEqual(instructions.firstCall.args[2], [
            { searchValue: '<package_name>', replaceValue: 'my_api' },
        ]);
    });

    test('quick create requires a name and rejects an invalid name before writing files', async () => {
        const add = sinon.stub().resolves();
        const creator = new NewFastApiProject({} as EnvironmentManagers, { add } as unknown as PythonProjectManager);

        await assert.rejects(
            () => creator.create({ quickCreate: true, name: '', rootUri: Uri.file(tmpDir) }),
            /FastAPI project name is required in quickCreate mode/,
        );
        await assert.rejects(
            () => creator.create({ quickCreate: true, name: 'bad name', rootUri: Uri.file(tmpDir) }),
            /Invalid project name/,
        );
        assert.strictEqual(add.called, false);
        assert.strictEqual(await fsExtra.pathExists(path.join(tmpDir, 'bad name_project')), false);
    });

    test('interactive creation prompts for a name and virtual environment', async () => {
        const { instructions } = useRealTemplateCopy();
        const { envManagers, defaultCreate } = createManagers();
        const add = sinon.stub().resolves();
        const creator = new NewFastApiProject(envManagers, { add } as unknown as PythonProjectManager);
        const prompt = sinon.stub(windowApis, 'showInputBoxWithButtons').callsFake(async (options) => {
            assert.strictEqual(await options?.validateInput?.('my api'), validateFastApiProjectName('my api'));
            assert.strictEqual(await options?.validateInput?.('my_api'), null);
            return 'my_api';
        });
        sinon.stub(windowApis, 'showQuickPickWithButtons').resolves({ label: l10n.t('Yes') });

        const created = asProject(await creator.create());

        assert.strictEqual(prompt.calledOnce, true);
        assert.strictEqual(created.name, 'my_api');
        sinon.assert.calledOnce(defaultCreate);
        sinon.assert.calledOnce(instructions);
        assert.strictEqual(await fsExtra.pathExists(path.join(tmpDir, 'my_api_project', 'my_api', 'main.py')), true);
    });

    test('interactive creation skips copilot instructions when Copilot is not installed', async () => {
        const { instructions } = useRealTemplateCopy();
        const { envManagers } = createManagers();
        const creator = new NewFastApiProject(envManagers, {
            add: sinon.stub().resolves(),
        } as unknown as PythonProjectManager);
        sinon.stub(windowApis, 'showInputBoxWithButtons').resolves('my_api');
        sinon.stub(windowApis, 'showQuickPickWithButtons').resolves({ label: l10n.t('Yes') });
        sinon.stub(creationHelpers, 'isCopilotInstalled').returns(false);

        const created = asProject(await creator.create());

        assert.strictEqual(created.name, 'my_api');
        sinon.assert.notCalled(instructions);
        assert.strictEqual(await fsExtra.pathExists(path.join(tmpDir, '.vscode', 'launch.json')), true);
    });

    test('declining a virtual environment keeps the project when an environment already exists', async () => {
        useRealTemplateCopy();
        const { envManagers, defaultCreate, getEnvironment, setEnvironment } = createManagers();
        const creator = new NewFastApiProject(envManagers, {
            add: sinon.stub().resolves(),
        } as unknown as PythonProjectManager);
        sinon.stub(windowApis, 'showInputBoxWithButtons').resolves('my_api');
        sinon.stub(windowApis, 'showQuickPickWithButtons').resolves({ label: l10n.t('No') });
        sinon.stub(creationHelpers, 'isCopilotInstalled').returns(false);

        const created = asProject(await creator.create());

        assert.strictEqual(created.name, 'my_api');
        sinon.assert.notCalled(defaultCreate);
        sinon.assert.calledOnce(getEnvironment);
        sinon.assert.calledOnce(setEnvironment);
    });

    test('returns undefined when the name prompt or environment prompt is cancelled', async () => {
        const add = sinon.stub().resolves();
        const creator = new NewFastApiProject({} as EnvironmentManagers, { add } as unknown as PythonProjectManager);
        const prompt = sinon.stub(windowApis, 'showInputBoxWithButtons').resolves(undefined);

        assert.strictEqual(await creator.create(), undefined);

        prompt.resolves('my_api');
        sinon.stub(windowApis, 'showQuickPickWithButtons').resolves(undefined);
        assert.strictEqual(await creator.create(), undefined);
        assert.strictEqual(add.called, false);
    });

    test('back from the name prompt reopens template selection', async () => {
        const creator = new NewFastApiProject(
            {} as EnvironmentManagers,
            {
                add: sinon.stub().resolves(),
            } as unknown as PythonProjectManager,
        );
        sinon.stub(windowApis, 'showInputBoxWithButtons').rejects(QuickInputButtons.Back);
        const execute = stubExecuteCommand();

        assert.strictEqual(await creator.create(), undefined);
        sinon.assert.calledOnceWithExactly(execute, 'python-envs.createNewProjectFromTemplate');
    });

    test('aborts when the template, workspace, or destination is unavailable', async () => {
        const add = sinon.stub().resolves();
        const { envManagers } = createManagers();
        const creator = new NewFastApiProject(envManagers, { add } as unknown as PythonProjectManager);

        assert.strictEqual(await creator.create({ name: 'my_api', rootUri: Uri.file(tmpDir) }), undefined);
        sinon.assert.calledWith(showError, l10n.t('Template folder does not exist, aborting creation.'));

        showError.resetHistory();
        useRealTemplateCopy();
        workspaceFolders = undefined;
        assert.strictEqual(await creator.create({ name: 'my_api' } as PythonProjectCreatorOptions), undefined);
        sinon.assert.calledWith(showError, l10n.t('No workspace folder is open or provided, aborting creation.'));

        workspaceFolders = [{ index: 0, name: 'test-workspace', uri: Uri.file(tmpDir) }];
        await fsExtra.ensureDir(path.join(tmpDir, 'my_api_project'));
        showError.resetHistory();
        assert.strictEqual(await creator.create({ name: 'my_api', rootUri: Uri.file(tmpDir) }), undefined);
        sinon.assert.calledWith(
            showError,
            l10n.t(
                'A project folder by that name already exists, aborting creation. Please retry with a unique project name given your workspace.',
            ),
        );
        assert.strictEqual(add.called, false);
    });

    test('reports an invalid name supplied outside quick create', async () => {
        const creator = new NewFastApiProject(
            {} as EnvironmentManagers,
            {
                add: sinon.stub().resolves(),
            } as unknown as PythonProjectManager,
        );

        assert.strictEqual(await creator.create({ name: 'bad name', rootUri: Uri.file(tmpDir) }), undefined);
        sinon.assert.calledWith(showError, validateFastApiProjectName('bad name'));
    });

    test('uses a quick-create environment manager when the default manager cannot quick-create', async () => {
        useRealTemplateCopy();
        const { envManagers, defaultCreate, venvCreate } = createManagers({
            supportsQuickCreate: false,
            supportsCreate: true,
            includeVenvFallback: true,
        });
        const creator = new NewFastApiProject(envManagers, {
            add: sinon.stub().resolves(),
        } as unknown as PythonProjectManager);

        const created = asProject(
            await creator.create({
                quickCreate: true,
                name: 'my_api',
                rootUri: Uri.file(tmpDir),
            }),
        );

        assert.strictEqual(created.name, 'my_api');
        sinon.assert.notCalled(defaultCreate);
        sinon.assert.calledOnce(venvCreate);
        assert.strictEqual(venvCreate.firstCall.args[1].quickCreate, true);
    });

    test('offers custom environment creation when no manager can create one', async () => {
        useRealTemplateCopy();
        const environment = createEnvironment();
        const { envManagers, getEnvironment, setEnvironment } = createManagers({
            supportsQuickCreate: false,
            supportsCreate: false,
            environment,
        });
        const creator = new NewFastApiProject(envManagers, {
            add: sinon.stub().resolves(),
        } as unknown as PythonProjectManager);
        showError.resolves(l10n.t('Create custom environment'));
        const execute = stubExecuteCommand();

        const created = asProject(
            await creator.create({
                quickCreate: true,
                name: 'my_api',
                rootUri: Uri.file(tmpDir),
            }),
        );

        assert.strictEqual(created.uri.fsPath, path.join(tmpDir, 'my_api_project'));
        sinon.assert.calledWith(
            showError,
            l10n.t(
                'A virtual environment could not be created for the new FastAPI project "{0}" because your default environment manager does not support this operation and no alternative was available.',
                'my_api',
            ),
            l10n.t('Create custom environment'),
        );
        assert.strictEqual(execute.firstCall.args[0], 'python-envs.createAny');
        assert.strictEqual(execute.firstCall.args[1].selectEnvironment, true);
        assert.strictEqual(execute.firstCall.args[1].uri.fsPath, path.join(tmpDir, 'my_api_project'));
        sinon.assert.calledOnce(getEnvironment);
        sinon.assert.calledOnce(setEnvironment);
    });

    test('returns undefined when the created project cannot be matched to an environment', async () => {
        useRealTemplateCopy();
        const { envManagers } = createManagers({ environment: undefined });
        const creator = new NewFastApiProject(envManagers, {
            add: sinon.stub().resolves(),
        } as unknown as PythonProjectManager);
        sinon.stub(windowApis, 'showInputBoxWithButtons').resolves('my_api');
        sinon.stub(windowApis, 'showQuickPickWithButtons').resolves({ label: l10n.t('No') });

        assert.strictEqual(await creator.create(), undefined);
        sinon.assert.calledWith(
            showError,
            l10n.t('Project created but unable to be correlated to correct Python environment.'),
        );
    });
});
