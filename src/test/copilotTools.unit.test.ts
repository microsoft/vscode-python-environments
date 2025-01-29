import * as assert from 'assert';
import * as vscode from 'vscode';
import { GetPackagesTool } from '../copilotTools';
//import { PythonEnvironment, Package } from '../api';
import { IGetActiveFile } from '../copilotTools';
import * as sinon from 'sinon';
import * as typeMoq from 'typemoq';
import { Package, PythonEnvironment, PythonPackageGetterApi, PythonProjectEnvironmentApi } from '../api';
import { createDeferred } from '../common/utils/deferred';

suite('GetPackagesTool Tests', () => {
    let tool: GetPackagesTool;
    let mockApi: typeMoq.IMock<PythonProjectEnvironmentApi & PythonPackageGetterApi>;
    let mockEnvironment: typeMoq.IMock<PythonEnvironment>;

    setup(() => {
        // Create mock functions
        mockApi = typeMoq.Mock.ofType<PythonProjectEnvironmentApi & PythonPackageGetterApi>();
        mockEnvironment = typeMoq.Mock.ofType<PythonEnvironment>();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockEnvironment.setup((x: any) => x.then).returns(() => undefined);

        // refresh will always return a resolved promise
        mockApi.setup((x) => x.refreshPackages(typeMoq.It.isAny())).returns(() => Promise.resolve());

        // Create an instance of GetPackagesTool with the mock functions
        tool = new GetPackagesTool(mockApi.object);
    });

    teardown(() => {
        sinon.restore();
    });

    test('should throw error if filePath is undefined', async () => {
        const testFile: IGetActiveFile = {
            filePath: '',
        };
        const options = { input: testFile, toolInvocationToken: undefined };
        const token = new vscode.CancellationTokenSource().token;
        await assert.rejects(tool.invoke(options, token), { message: 'Invalid input: filePath is required' });
    });

    test('should throw error for notebook files', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockEnvironment.setup((x: any) => x.then).returns(() => undefined);

        const testFile: IGetActiveFile = {
            filePath: 'test.ipynb',
        };
        const options = { input: testFile, toolInvocationToken: undefined };
        const token = new vscode.CancellationTokenSource().token;
        const result = await tool.invoke(options, token);
        const content = result.content as vscode.LanguageModelTextPart[];
        const firstPart = content[0] as vscode.LanguageModelTextPart;

        assert.strictEqual(
            firstPart.value,
            'An error occurred while fetching packages: Error: Unable to access Jupyter kernels for notebook cells',
        );
    });

    test('should throw error for notebook cells', async () => {
        const testFile: IGetActiveFile = {
            filePath: 'test.ipynb#123',
        };
        const options = { input: testFile, toolInvocationToken: undefined };
        const token = new vscode.CancellationTokenSource().token;
        const result = await tool.invoke(options, token);
        const content = result.content as vscode.LanguageModelTextPart[];
        const firstPart = content[0] as vscode.MarkdownString;

        assert.strictEqual(
            firstPart.value,
            'An error occurred while fetching packages: Error: Unable to access Jupyter kernels for notebook cells',
        );
    });

    test('should return no packages message if no packages are installed', async () => {
        const testFile: IGetActiveFile = {
            filePath: 'test.py',
        };

        mockApi
            .setup((x) => x.getEnvironment(typeMoq.It.isAny()))
            .returns(() => {
                return Promise.resolve(mockEnvironment.object);
            });

        mockApi.setup((x) => x.getPackages(typeMoq.It.isAny())).returns(() => Promise.resolve([]));

        const options = { input: testFile, toolInvocationToken: undefined };
        const token = new vscode.CancellationTokenSource().token;
        const result = await tool.invoke(options, token);
        const content = result.content as vscode.LanguageModelTextPart[];
        const firstPart = content[0] as vscode.MarkdownString;

        assert.strictEqual(firstPart.value, 'No packages are installed in the current environment.');
    });

    test('should return just packages if versions do not exist', async () => {
        const testFile: IGetActiveFile = {
            filePath: 'test.py',
        };

        mockApi
            .setup((x) => x.getEnvironment(typeMoq.It.isAny()))
            .returns(() => {
                return Promise.resolve(mockEnvironment.object);
            });

        const mockPackages: Package[] = [
            {
                pkgId: { id: 'pkg1', managerId: 'pip', environmentId: 'env1' },
                name: 'package1',
                displayName: 'package1',
            },
            {
                pkgId: { id: 'pkg2', managerId: 'pip', environmentId: 'env1' },
                name: 'package2',
                displayName: 'package2',
            },
        ];

        mockApi.setup((x) => x.refreshPackages(typeMoq.It.isAny())).returns(() => Promise.resolve());
        mockApi.setup((x) => x.getPackages(typeMoq.It.isAny())).returns(() => Promise.resolve(mockPackages));

        const options = { input: testFile, toolInvocationToken: undefined };
        const token = new vscode.CancellationTokenSource().token;
        const result = await tool.invoke(options, token);
        const content = result.content as vscode.LanguageModelTextPart[];
        const firstPart = content[0] as vscode.MarkdownString;

        assert.ok(
            firstPart.value.includes('The packages installed in the current environment are as follows:') &&
                firstPart.value.includes('package1') &&
                firstPart.value.includes('package2'),
        );
    });

    test('should return installed packages with versions', async () => {
        const testFile: IGetActiveFile = {
            filePath: 'test.py',
        };

        mockApi
            .setup((x) => x.getEnvironment(typeMoq.It.isAny()))
            .returns(() => {
                return Promise.resolve(mockEnvironment.object);
            });

        const mockPackages: Package[] = [
            {
                pkgId: { id: 'pkg1', managerId: 'pip', environmentId: 'env1' },
                name: 'package1',
                displayName: 'package1',
                version: '1.0.0',
            },
            {
                pkgId: { id: 'pkg2', managerId: 'pip', environmentId: 'env1' },
                name: 'package2',
                displayName: 'package2',
                version: '2.0.0',
            },
        ];

        mockApi.setup((x) => x.refreshPackages(typeMoq.It.isAny())).returns(() => Promise.resolve());
        mockApi.setup((x) => x.getPackages(typeMoq.It.isAny())).returns(() => Promise.resolve(mockPackages));

        const options = { input: testFile, toolInvocationToken: undefined };
        const token = new vscode.CancellationTokenSource().token;
        const result = await tool.invoke(options, token);
        const content = result.content as vscode.LanguageModelTextPart[];
        const firstPart = content[0] as vscode.MarkdownString;

        assert.ok(
            firstPart.value.includes('The packages installed in the current environment are as follows:') &&
                firstPart.value.includes('package1 (1.0.0)') &&
                firstPart.value.includes('package2 (2.0.0)'),
        );
    });

    test('should handle cancellation', async () => {
        const testFile: IGetActiveFile = {
            filePath: 'test.py',
        };

        mockApi
            .setup((x) => x.getEnvironment(typeMoq.It.isAny()))
            .returns(async () => {
                return Promise.resolve(mockEnvironment.object);
            });

        mockApi.setup((x) => x.refreshPackages(typeMoq.It.isAny())).returns(() => Promise.resolve());
        mockApi.setup((x) => x.getPackages(typeMoq.It.isAny())).returns(() => Promise.resolve([]));

        const options = { input: testFile, toolInvocationToken: undefined };
        const tokenSource = new vscode.CancellationTokenSource();
        const token = tokenSource.token;

        const deferred = createDeferred();
        tool.invoke(options, token).then((result) => {
            const content = result.content as vscode.LanguageModelTextPart[];
            const firstPart = content[0] as vscode.MarkdownString;

            assert.strictEqual(firstPart.value, 'Operation cancelled by the user.');
            deferred.resolve();
        });

        tokenSource.cancel();
        await deferred.promise;
    });
});
