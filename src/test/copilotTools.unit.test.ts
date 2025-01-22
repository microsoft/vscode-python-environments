import * as assert from 'assert';
import * as vscode from 'vscode';
import { GetPackagesTool } from '../copilotTools';
//import { PythonEnvironment, Package } from '../api';
import { IGetActiveFile } from '../copilotTools';
import * as sinon from 'sinon';
import * as typeMoq from 'typemoq';
import { GetEnvironmentScope, Package, PythonEnvironment } from '../api';

suite('GetPackagesTool Tests', () => {
    let tool: GetPackagesTool;
    let mockGetEnvironment: typeMoq.IMock<(scope: GetEnvironmentScope) => Promise<PythonEnvironment | undefined>>;
    let mockGetPackages: typeMoq.IMock<(environment: PythonEnvironment) => Promise<Package[] | undefined>>;
    let mockRefreshPackages: typeMoq.IMock<(environment: PythonEnvironment) => Promise<void>>;
    let mockEnvironment: typeMoq.IMock<PythonEnvironment>;

    setup(() => {
        // Create mock functions
        mockGetEnvironment =
            typeMoq.Mock.ofType<(scope: GetEnvironmentScope) => Promise<PythonEnvironment | undefined>>();
        mockGetPackages = typeMoq.Mock.ofType<(environment: PythonEnvironment) => Promise<Package[] | undefined>>();
        mockRefreshPackages = typeMoq.Mock.ofType<(environment: PythonEnvironment) => Promise<void>>();
        mockEnvironment = typeMoq.Mock.ofType<PythonEnvironment>();

        // Create an instance of GetPackagesTool with the mock functions
        tool = new GetPackagesTool(mockGetEnvironment.object, mockGetPackages.object, mockRefreshPackages.object);
    });

    teardown(() => {
        sinon.restore();
    });

    test('should throw error if filePath is undefined', async () => {
        mockGetEnvironment.setup((x) => x(typeMoq.It.isAny())).returns(async () => undefined);

        const testFile: IGetActiveFile = {
            filePath: '',
        };
        const options = { input: testFile, toolInvocationToken: undefined };
        const token = new vscode.CancellationTokenSource().token;
        await assert.rejects(tool.invoke(options, token), { message: 'Invalid input: filePath is required' });
    });

    test('should throw error for notebook files', async () => {
        mockGetEnvironment.setup((x) => x(typeMoq.It.isAny())).returns(async () => undefined);

        const testFile: IGetActiveFile = {
            filePath: 'test.ipynb',
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

    test('should throw error for notebook cells', async () => {
        mockGetEnvironment.setup((x) => x(typeMoq.It.isAny())).returns(async () => undefined);

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

    // test('should return no packages message if no packages are installed', async () => {
    //     mockGetEnvironment
    //         .setup((x) => x(typeMoq.It.isAny()))
    //         .returns(async () => {
    //             console.log('hi');
    //             return Promise.resolve(mockEnvironment.object);
    //         });

    //     const testFile: IGetActiveFile = {
    //         filePath: 'test.py',
    //     };
    //     const options = { input: testFile, toolInvocationToken: undefined };
    //     const token = new vscode.CancellationTokenSource().token;
    //     const result = await tool.invoke(options, token);
    //     const content = result.content as vscode.LanguageModelTextPart[];
    //     const firstPart = content[0] as vscode.MarkdownString;

    //     assert.strictEqual(firstPart.value, 'No packages are installed in the current environment.');
    // });

    // test('should return installed packages', async () => {
    //     const testFile: IGetActiveFile = {
    //         filePath: 'abc.py',
    //     };
    //     const options = { input: testFile, toolInvocationToken: undefined };
    //     const token = new vscode.CancellationTokenSource().token;

    //     // Mock the getEnvironment function to return a valid environment
    //     const mockEnvironment: PythonEnvironment = {
    //         name: 'env',
    //         displayName: 'env',
    //         displayPath: 'path/to/env',
    //         version: '3.9.0',
    //         environmentPath: vscode.Uri.file('path/to/env'),
    //         sysPrefix: 'path/to/env',
    //         execInfo: { run: { executable: 'python' } },
    //         envId: { id: 'env1', managerId: 'manager1' },
    //     };
    //     mockGetEnvironment.resolves(mockEnvironment);

    //     // Mock the getPackages function to return a list of packages
    //     const mockPackages: Package[] = [
    //         {
    //             pkgId: { id: 'pkg1', managerId: 'pip', environmentId: 'env1' },
    //             name: 'package1',
    //             displayName: 'package1',
    //         },
    //         {
    //             pkgId: { id: 'pkg2', managerId: 'pip', environmentId: 'env1' },
    //             name: 'package2',
    //             displayName: 'package2',
    //         },
    //     ];
    //     mockGetPackages.resolves(mockPackages);

    //     const result = await tool.invoke(options, token);
    //     assert.strictEqual(
    //         result.parts[0].text,
    //         'The packages installed in the current environment are as follows:\npackage1, package2',
    //     );
    // });

    // test('should handle cancellation', async () => {
    //     const tokenSource = new vscode.CancellationTokenSource();
    //     const token = tokenSource.token;

    //     const testFile: IGetActiveFile = {
    //         filePath: 'abc.py',
    //     };
    //     const options = { input: testFile, toolInvocationToken: undefined };

    //     // Mock the getEnvironment function to return a valid environment
    //     const mockEnvironment: PythonEnvironment = {
    //         name: 'env',
    //         displayName: 'env',
    //         displayPath: 'path/to/env',
    //         version: '3.9.0',
    //         environmentPath: vscode.Uri.file('path/to/env'),
    //         sysPrefix: 'path/to/env',
    //         execInfo: { run: { executable: 'python' } },
    //         envId: { id: 'env1', managerId: 'manager1' },
    //     };
    //     mockGetEnvironment.resolves(mockEnvironment);

    //     // Mock the getPackages function to return a list of packages
    //     const mockPackages: Package[] = [
    //         {
    //             pkgId: { id: 'pkg1', managerId: 'pip', environmentId: 'env1' },
    //             name: 'package1',
    //             displayName: 'package1',
    //         },
    //         {
    //             pkgId: { id: 'pkg2', managerId: 'pip', environmentId: 'env1' },
    //             name: 'package2',
    //             displayName: 'package2',
    //         },
    //     ];
    //     mockGetPackages.resolves(mockPackages);

    //     tool.invoke(options, token);

    //     tokenSource.cancel();
    //     await assert.rejects(tool.invoke(options, token), { message: 'Operation cancelled' });
    // });
});
