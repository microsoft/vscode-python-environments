import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import * as typeMoq from 'typemoq';
import {
    Package,
    PackageId,
    PythonEnvironment,
    PythonEnvironmentId,
    PythonPackageGetterApi,
    PythonPackageManagementApi,
    PythonProjectEnvironmentApi,
} from '../api';
import { createDeferred } from '../common/utils/deferred';
import {
    GetEnvironmentInfoTool,
    IInstallPackageInput,
    InstallPackageTool,
    IResourceReference,
} from '../features/copilotTools';

suite('InstallPackageTool Tests', () => {
    let installPackageTool: InstallPackageTool;
    let mockApi: typeMoq.IMock<PythonProjectEnvironmentApi & PythonPackageGetterApi & PythonPackageManagementApi>;
    let mockEnvironment: typeMoq.IMock<PythonEnvironment>;

    setup(() => {
        // Create mock functions
        mockApi = typeMoq.Mock.ofType<
            PythonProjectEnvironmentApi & PythonPackageGetterApi & PythonPackageManagementApi
        >();
        mockEnvironment = typeMoq.Mock.ofType<PythonEnvironment>();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockEnvironment.setup((x: any) => x.then).returns(() => undefined);

        // refresh will always return a resolved promise
        mockApi.setup((x) => x.refreshPackages(typeMoq.It.isAny())).returns(() => Promise.resolve());

        // Create an instance of InstallPackageTool with the mock functions
        installPackageTool = new InstallPackageTool(mockApi.object);
    });

    teardown(() => {
        sinon.restore();
    });

    test('should throw error if workspacePath is an empty string', async () => {
        const testFile: IInstallPackageInput = {
            workspacePath: '',
            packageList: ['package1', 'package2'],
        };
        const options = { input: testFile, toolInvocationToken: undefined };
        const token = new vscode.CancellationTokenSource().token;
        await assert.rejects(installPackageTool.invoke(options, token), {
            message: 'Invalid input: workspacePath is required',
        });
    });

    test('should throw error for notebook files', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockEnvironment.setup((x: any) => x.then).returns(() => undefined);

        const testFile: IInstallPackageInput = {
            workspacePath: 'this/is/a/test/path.ipynb',
            packageList: ['package1', 'package2'],
        };
        const options = { input: testFile, toolInvocationToken: undefined };
        const token = new vscode.CancellationTokenSource().token;
        const result = await installPackageTool.invoke(options, token);
        const content = result.content as vscode.LanguageModelTextPart[];
        const firstPart = content[0] as vscode.LanguageModelTextPart;

        assert.strictEqual(firstPart.value.includes('An error occurred while installing packages'), true);
    });

    test('should throw error for notebook cells', async () => {
        const testFile: IInstallPackageInput = {
            workspacePath: 'this/is/a/test/path.ipynb#cell',
            packageList: ['package1', 'package2'],
        };
        const options = { input: testFile, toolInvocationToken: undefined };
        const token = new vscode.CancellationTokenSource().token;
        const result = await installPackageTool.invoke(options, token);
        const content = result.content as vscode.LanguageModelTextPart[];
        const firstPart = content[0] as vscode.LanguageModelTextPart;

        assert.strictEqual(firstPart.value.includes('An error occurred while installing packages'), true);
    });

    test('should throw error if packageList passed in is empty', async () => {
        const testFile: IInstallPackageInput = {
            workspacePath: 'path/to/workspace',
            packageList: [],
        };

        const options = { input: testFile, toolInvocationToken: undefined };
        const token = new vscode.CancellationTokenSource().token;
        await assert.rejects(installPackageTool.invoke(options, token), {
            message: 'Invalid input: packageList is required and cannot be empty',
        });
    });

    test('should handle cancellation', async () => {
        const testFile: IInstallPackageInput = {
            workspacePath: 'path/to/workspace',
            packageList: ['package1', 'package2'],
        };

        mockApi
            .setup((x) => x.getEnvironment(typeMoq.It.isAny()))
            .returns(async () => {
                return Promise.resolve(mockEnvironment.object);
            });

        mockApi.setup((x) => x.refreshPackages(typeMoq.It.isAny())).returns(() => Promise.resolve());

        const options = { input: testFile, toolInvocationToken: undefined };
        const tokenSource = new vscode.CancellationTokenSource();
        const token = tokenSource.token;

        const deferred = createDeferred();
        installPackageTool.invoke(options, token).then((result) => {
            const content = result.content as vscode.LanguageModelTextPart[];
            const firstPart = content[0] as vscode.MarkdownString;

            assert.strictEqual(firstPart.value, 'Operation cancelled by the user.');
            deferred.resolve();
        });

        tokenSource.cancel();
        await deferred.promise;
    });

    test('should handle packages installation', async () => {
        const testFile: IInstallPackageInput = {
            workspacePath: 'path/to/workspace',
            packageList: ['package1', 'package2'],
        };

        mockApi
            .setup((x) => x.getEnvironment(typeMoq.It.isAny()))
            .returns(async () => {
                return Promise.resolve(mockEnvironment.object);
            });

        mockApi.setup((x) => x.refreshPackages(typeMoq.It.isAny())).returns(() => Promise.resolve());
        mockApi
            .setup((x) => x.installPackages(typeMoq.It.isAny(), typeMoq.It.isAny()))
            .returns(() => {
                const deferred = createDeferred<void>();
                deferred.resolve();
                return deferred.promise;
            });

        const options = { input: testFile, toolInvocationToken: undefined };
        const token = new vscode.CancellationTokenSource().token;

        const result = await installPackageTool.invoke(options, token);
        const content = result.content as vscode.LanguageModelTextPart[];
        const firstPart = content[0] as vscode.MarkdownString;

        assert.strictEqual(firstPart.value.includes('Successfully installed packages'), true);
        assert.strictEqual(firstPart.value.includes('package1'), true);
        assert.strictEqual(firstPart.value.includes('package2'), true);
    });
    test('should handle package installation failure', async () => {
        const testFile: IInstallPackageInput = {
            workspacePath: 'path/to/workspace',
            packageList: ['package1', 'package2'],
        };

        mockApi
            .setup((x) => x.getEnvironment(typeMoq.It.isAny()))
            .returns(async () => {
                return Promise.resolve(mockEnvironment.object);
            });

        mockApi.setup((x) => x.refreshPackages(typeMoq.It.isAny())).returns(() => Promise.resolve());
        mockApi
            .setup((x) => x.installPackages(typeMoq.It.isAny(), typeMoq.It.isAny()))
            .returns(() => {
                const deferred = createDeferred<void>();
                deferred.reject(new Error('Installation failed'));
                return deferred.promise;
            });

        const options = { input: testFile, toolInvocationToken: undefined };
        const token = new vscode.CancellationTokenSource().token;

        const result = await installPackageTool.invoke(options, token);
        const content = result.content as vscode.LanguageModelTextPart[];
        const firstPart = content[0] as vscode.MarkdownString;

        console.log('result', firstPart.value);
        assert.strictEqual(
            firstPart.value.includes('An error occurred while installing packages'),
            true,
            `error message was ${firstPart.value}`,
        );
    });
    test('should handle error occurs when getting environment', async () => {
        const testFile: IInstallPackageInput = {
            workspacePath: 'path/to/workspace',
            packageList: ['package1', 'package2'],
        };
        mockApi
            .setup((x) => x.getEnvironment(typeMoq.It.isAny()))
            .returns(async () => {
                return Promise.reject(new Error('Unable to get environment'));
            });

        const options = { input: testFile, toolInvocationToken: undefined };
        const token = new vscode.CancellationTokenSource().token;
        const result = await installPackageTool.invoke(options, token);
        const content = result.content as vscode.LanguageModelTextPart[];
        const firstPart = content[0] as vscode.MarkdownString;
        assert.strictEqual(firstPart.value.includes('An error occurred while installing packages'), true);
    });
    test('correct plurality in package installation message', async () => {
        const testFile: IInstallPackageInput = {
            workspacePath: 'path/to/workspace',
            packageList: ['package1'],
        };
        mockApi
            .setup((x) => x.getEnvironment(typeMoq.It.isAny()))
            .returns(async () => {
                return Promise.resolve(mockEnvironment.object);
            });
        mockApi.setup((x) => x.refreshPackages(typeMoq.It.isAny())).returns(() => Promise.resolve());
        mockApi
            .setup((x) => x.installPackages(typeMoq.It.isAny(), typeMoq.It.isAny()))
            .returns(() => {
                const deferred = createDeferred<void>();
                deferred.resolve();
                return deferred.promise;
            });
        const options = { input: testFile, toolInvocationToken: undefined };
        const token = new vscode.CancellationTokenSource().token;
        const result = await installPackageTool.invoke(options, token);
        const content = result.content as vscode.LanguageModelTextPart[];
        const firstPart = content[0] as vscode.MarkdownString;
        assert.strictEqual(firstPart.value.includes('packages'), false);
        assert.strictEqual(firstPart.value.includes('package'), true);
    });
});

suite('GetEnvironmentInfoTool Tests', () => {
    let getEnvironmentInfoTool: GetEnvironmentInfoTool;
    let mockApi: typeMoq.IMock<PythonProjectEnvironmentApi & PythonPackageGetterApi & PythonPackageManagementApi>;
    let mockEnvironment: typeMoq.IMock<PythonEnvironment>;

    setup(() => {
        // Create mock functions
        mockApi = typeMoq.Mock.ofType<
            PythonProjectEnvironmentApi & PythonPackageGetterApi & PythonPackageManagementApi
        >();
        mockEnvironment = typeMoq.Mock.ofType<PythonEnvironment>();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockEnvironment.setup((x: any) => x.then).returns(() => undefined);

        // Create an instance of GetEnvironmentInfoTool with the mock functions
        getEnvironmentInfoTool = new GetEnvironmentInfoTool(mockApi.object);

        // runConfig valid / not valid
        // const runConfigValid: PythonCommandRunConfiguration = {
        //     executable: 'conda',
        //     args: ['run', '-n', 'env_name', 'python'],
        // };
        // const runConfigValidString = 'conda run -n env_name python';
        // const runConfigNoArgs: PythonCommandRunConfiguration = {
        //     executable: '.venv/bin/python',
        //     args: [],
        // };
        // const runConfigNoArgsString = '.venv/bin/python';

        // // managerId valid / not valid
        // const managerIdValid = `'ms-python.python:venv'`;
        // const typeValidString = 'venv';
        // const managerIdInvalid = `vscode-python, there is no such manager`;

        // // environment valid
        // const envInfoVersion = '3.9.1';

        // //package valid / not valid
        // const installedPackagesValid = [{ name: 'package1', version: '1.0.0' }, { name: 'package2' }];
        // const installedPackagesValidString = 'package1 1.0.0\npackage2 2.0.0';
        // const installedPackagesInvalid = undefined;
    });

    teardown(() => {
        sinon.restore();
    });
    test('should throw error if resourcePath is an empty string', async () => {
        const testFile: IResourceReference = {
            resourcePath: '',
        };
        const options = { input: testFile, toolInvocationToken: undefined };
        const token = new vscode.CancellationTokenSource().token;
        await assert.rejects(getEnvironmentInfoTool.invoke(options, token), {
            message: 'Invalid input: resourcePath is required',
        });
    });
    test('should throw error if environment is not found', async () => {
        const testFile: IResourceReference = {
            resourcePath: 'this/is/a/test/path.ipynb',
        };
        mockApi
            .setup((x) => x.getEnvironment(typeMoq.It.isAny()))
            .returns(async () => {
                return Promise.reject(new Error('Unable to get environment'));
            });

        const options = { input: testFile, toolInvocationToken: undefined };
        const token = new vscode.CancellationTokenSource().token;
        await assert.rejects(getEnvironmentInfoTool.invoke(options, token), {
            message: 'Unable to get environment',
        });
    });
    test('should return successful with environment info', async () => {
        // create mock of PythonEnvironment
        const mockEnvironmentSuccess = typeMoq.Mock.ofType<PythonEnvironment>();
        // mockEnvironment = typeMoq.Mock.ofType<PythonEnvironment>();

        // // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockEnvironmentSuccess.setup((x: any) => x.then).returns(() => undefined);
        mockEnvironmentSuccess.setup((x) => x.version).returns(() => '3.9.1');
        const mockEnvId = typeMoq.Mock.ofType<PythonEnvironmentId>();
        mockEnvId.setup((x) => x.managerId).returns(() => 'ms-python.python:venv');
        mockEnvironmentSuccess.setup((x) => x.envId).returns(() => mockEnvId.object);
        mockEnvironmentSuccess
            .setup((x) => x.execInfo)
            .returns(() => ({
                run: {
                    executable: 'conda',
                    args: ['run', '-n', 'env_name', 'python'],
                },
            }));

        mockApi
            .setup((x) => x.getEnvironment(typeMoq.It.isAny()))
            .returns(async () => {
                return Promise.resolve(mockEnvironmentSuccess.object);
            });
        mockApi
            .setup((x) => x.getEnvironment(typeMoq.It.isAny()))
            .returns(async () => {
                return Promise.resolve(mockEnvironmentSuccess.object);
            });
        mockApi.setup((x) => x.refreshPackages(typeMoq.It.isAny())).returns(() => Promise.resolve());

        const packageAId: PackageId = {
            id: 'package1',
            managerId: 'ms-python.python:venv',
            environmentId: 'env_id',
        };
        const packageBId: PackageId = {
            id: 'package2',
            managerId: 'ms-python.python:venv',
            environmentId: 'env_id',
        };
        const packageA: Package = { name: 'package1', displayName: 'Package 1', version: '1.0.0', pkgId: packageAId };
        const packageB: Package = { name: 'package2', displayName: 'Package 2', version: '2.0.0', pkgId: packageBId };
        mockApi
            .setup((x) => x.getPackages(typeMoq.It.isAny()))
            .returns(async () => {
                return Promise.resolve([packageA, packageB]);
            });

        const testFile: IResourceReference = {
            resourcePath: 'this/is/a/test/path.ipynb',
        };
        const options = { input: testFile, toolInvocationToken: undefined };
        const token = new vscode.CancellationTokenSource().token;
        // run
        const result = await getEnvironmentInfoTool.invoke(options, token);
        // assert
        const content = result.content as vscode.LanguageModelTextPart[];
        const firstPart = content[0] as vscode.MarkdownString;
        console.log('result', firstPart.value);
        assert.strictEqual(firstPart.value.includes('Python version: 3.9.1'), true);
        assert.strictEqual(firstPart.value, '');
    });
});
