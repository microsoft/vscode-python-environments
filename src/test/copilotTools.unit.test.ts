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
    PythonProjectGetterApi,
} from '../api';
import { createDeferred } from '../common/utils/deferred';
import {
    GetEnvironmentInfoTool,
    IInstallPackageInput,
    InstallPackageTool,
    IResourceReference,
} from '../features/copilotTools';
import { EnvironmentManagers, InternalEnvironmentManager } from '../internal.api';

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

        mockApi
            .setup((x) => x.managePackages(typeMoq.It.isAny(), typeMoq.It.isAny()))
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

        mockApi
            .setup((x) => x.managePackages(typeMoq.It.isAny(), typeMoq.It.isAny()))
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
        mockApi
            .setup((x) => x.managePackages(typeMoq.It.isAny(), typeMoq.It.isAny()))
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
    let mockApi: typeMoq.IMock<PythonProjectEnvironmentApi & PythonPackageGetterApi & PythonProjectGetterApi>;
    let mockEnvironment: typeMoq.IMock<PythonEnvironment>;
    let em: typeMoq.IMock<EnvironmentManagers>;
    let managerSys: typeMoq.IMock<InternalEnvironmentManager>;

    setup(() => {
        // Create mock functions
        mockApi = typeMoq.Mock.ofType<PythonProjectEnvironmentApi & PythonPackageGetterApi & PythonProjectGetterApi>();
        mockEnvironment = typeMoq.Mock.ofType<PythonEnvironment>();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockEnvironment.setup((x: any) => x.then).returns(() => undefined);

        em = typeMoq.Mock.ofType<EnvironmentManagers>();
        em.setup((e) => e.managers).returns(() => [managerSys.object]);
        em.setup((e) => e.getEnvironmentManager(typeMoq.It.isAnyString())).returns(() => managerSys.object);

        getEnvironmentInfoTool = new GetEnvironmentInfoTool(mockApi.object, em.object);
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
        const result = getEnvironmentInfoTool.invoke(options, token);
        const content = (await result).content as vscode.LanguageModelTextPart[];
        const firstPart = content[0] as vscode.MarkdownString;
        assert.strictEqual(firstPart.value.includes('An error occurred while fetching environment information'), true);
    });
    test('should return successful with environment info', async () => {
        // Create an instance of GetEnvironmentInfoTool with the mock functions
        managerSys = typeMoq.Mock.ofType<InternalEnvironmentManager>();
        managerSys.setup((m) => m.id).returns(() => 'ms-python.python:venv');
        managerSys.setup((m) => m.name).returns(() => 'venv');
        managerSys.setup((m) => m.displayName).returns(() => 'Test Manager');

        em = typeMoq.Mock.ofType<EnvironmentManagers>();
        em.setup((e) => e.managers).returns(() => [managerSys.object]);
        em.setup((e) => e.getEnvironmentManager(typeMoq.It.isAnyString())).returns(() => managerSys.object);
        // create mock of PythonEnvironment
        const mockEnvironmentSuccess = typeMoq.Mock.ofType<PythonEnvironment>();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        assert.strictEqual(firstPart.value.includes('3.9.1'), true);
        assert.strictEqual(firstPart.value.includes('package1 (1.0.0)'), true);
        assert.strictEqual(firstPart.value.includes('package2 (2.0.0)'), true);
        assert.strictEqual(firstPart.value.includes(`"conda run -n env_name python"`), true);
        assert.strictEqual(firstPart.value.includes('venv'), true);
    });
    test('should return successful with weird environment info', async () => {
        // create mock of PythonEnvironment
        const mockEnvironmentSuccess = typeMoq.Mock.ofType<PythonEnvironment>();

        // Create an instance of GetEnvironmentInfoTool with the mock functions
        let managerSys = typeMoq.Mock.ofType<InternalEnvironmentManager>();
        managerSys.setup((m) => m.id).returns(() => 'ms-python.python:system');
        managerSys.setup((m) => m.name).returns(() => 'system');
        managerSys.setup((m) => m.displayName).returns(() => 'Test Manager');

        let emSys = typeMoq.Mock.ofType<EnvironmentManagers>();
        emSys.setup((e) => e.managers).returns(() => [managerSys.object]);
        emSys.setup((e) => e.getEnvironmentManager(typeMoq.It.isAnyString())).returns(() => managerSys.object);
        getEnvironmentInfoTool = new GetEnvironmentInfoTool(mockApi.object, emSys.object);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockEnvironmentSuccess.setup((x: any) => x.then).returns(() => undefined);
        mockEnvironmentSuccess.setup((x) => x.version).returns(() => '3.12.1');
        const mockEnvId = typeMoq.Mock.ofType<PythonEnvironmentId>();
        mockEnvId.setup((x) => x.managerId).returns(() => 'ms-python.python:system');
        managerSys.setup((m) => m.name).returns(() => 'system');
        mockEnvironmentSuccess.setup((x) => x.envId).returns(() => mockEnvId.object);
        mockEnvironmentSuccess
            .setup((x) => x.execInfo)
            .returns(() => ({
                run: {
                    executable: 'path/to/venv/bin/python',
                    args: [],
                },
            }));

        mockApi
            .setup((x) => x.getEnvironment(typeMoq.It.isAny()))
            .returns(async () => {
                return Promise.resolve(mockEnvironmentSuccess.object);
            });
        mockApi.setup((x) => x.refreshPackages(typeMoq.It.isAny())).returns(() => Promise.resolve());

        mockApi
            .setup((x) => x.getPackages(typeMoq.It.isAny()))
            .returns(async () => {
                return Promise.resolve([]);
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
        assert.strictEqual(firstPart.value.includes('3.12.1'), true);
        assert.strictEqual(firstPart.value.includes('"packages": []'), true);
        assert.strictEqual(firstPart.value.includes(`"path/to/venv/bin/python"`), true);
        assert.strictEqual(firstPart.value.includes('system'), true);
    });
});
